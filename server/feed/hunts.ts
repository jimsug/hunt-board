import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import Whiteboards from "lib/models/Whiteboards";
import type SoftDeletedModel from "lib/typedModel/SoftDeletedModel";
import { ModelValidationError } from "lib/typedModel/validateWrite";
import { onChange } from "../changes";
import Logger from "../logger";
import { deferSyncPuzzlesOnBoard } from "../whiteboard";
import type { DataMessage, DdpClient, DdpError, Subscription } from "./ddp";

// Keeps the copies of Jolly Roger's puzzles and tags for every hunt that has
// a board. Each such hunt gets a subscription pair on the DDP client, the
// documents they deliver are mirrored into Puzzles and Tags (only the fields
// the copies declare), and the puzzles a batch of changes touched go to the
// board's deferred placement, as Jolly Roger's own hooks sent them. After
// every connect the server sends everything again; once a hunt's pair is
// ready, any copy it didn't send is retired, so a change missed while
// disconnected is caught up.

// Jolly Roger has no tags-only publication: the puzzle list's sends the
// hunt's tags (and its puzzles again, which the server sends once).
export const PUZZLES_PUBLICATION = "Puzzles.publications.forHunt";
export const TAGS_PUBLICATION = "Puzzles.publications.forPuzzleList";

// How long after the last change to wait for the rest of a burst before
// handing the batch to placement
const FLUSH_DELAY_MS = 50;

interface HuntFeed {
  hunt: string;
  subs: Subscription[];
  // Subscriptions that have reported ready since the last connect
  ready: Set<string>;
  // Reconciled since the last connect, so changes flow straight through
  loaded: boolean;
  // What the server has sent since the last connect, for the reconcile
  seenPuzzles: Set<string>;
  seenTags: Set<string>;
  dirtyPuzzles: Set<string>;
  dirtyTags: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface HuntFeedOptions {
  client: DdpClient;
  logger?: Pick<typeof Logger, "info" | "warn" | "error">;
}

export interface HuntFeeds {
  // The hunts with a subscription pair
  hunts(): string[];
  // Settles once every change received so far has been mirrored and handed
  // to placement (which deferredSyncsDone then waits for)
  settled(): Promise<void>;
  stop(): Promise<void>;
}

type AnyModel = SoftDeletedModel<any>;

// The fields a copy declares, so the rest of Jolly Roger's document is
// dropped on the way in
function declaredFields(model: AnyModel): Set<string> {
  const schema = model.schema as { shape?: Record<string, unknown> };
  return new Set(Object.keys(schema.shape ?? {}).filter((k) => k !== "_id"));
}

const PUZZLE_FIELDS = declaredFields(Puzzles);
const TAG_FIELDS = declaredFields(Tags);

function keep(
  fields: Record<string, unknown> | undefined,
  declared: Set<string>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (declared.has(key)) kept[key] = value;
  }
  return kept;
}

export function startHuntFeeds({
  client,
  logger = Logger,
}: HuntFeedOptions): HuntFeeds {
  const feeds = new Map<string, HuntFeed>();
  // Board id to hunt, so a board's removal (which carries no document) finds
  // the hunt to unsubscribe
  const boards = new Map<string, string>();
  let stopped = false;
  // Changes are mirrored one at a time, in the order the server sent them
  let queue: Promise<void> = Promise.resolve();
  let pendingFlushes = 0;

  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => {
      logger.error("Feed change failed", { error });
    });
    return queue;
  };

  // The puzzles a tag change touches are those carrying it, as the tag
  // methods found them
  async function flush(feed: HuntFeed) {
    const puzzleIds = new Set(feed.dirtyPuzzles);
    feed.dirtyPuzzles.clear();
    if (feed.dirtyTags.size > 0) {
      const tagIds = [...feed.dirtyTags];
      feed.dirtyTags.clear();
      const carrying = await Puzzles.find(
        { hunt: feed.hunt, tags: { $in: tagIds } },
        { projection: { _id: 1 } },
      ).fetchAsync();
      carrying.forEach((p) => puzzleIds.add(p._id));
    }
    if (puzzleIds.size > 0 && feeds.get(feed.hunt) === feed) {
      deferSyncPuzzlesOnBoard(feed.hunt, [...puzzleIds]);
    }
  }

  function scheduleFlush(feed: HuntFeed) {
    if (!feed.loaded || feed.flushTimer) return;
    pendingFlushes += 1;
    feed.flushTimer = setTimeout(() => {
      feed.flushTimer = undefined;
      void enqueue(() => flush(feed)).finally(() => {
        pendingFlushes -= 1;
      });
    }, FLUSH_DELAY_MS);
  }

  // Once both subscriptions have sent everything, copies the server didn't
  // send are retired and the whole hunt goes to placement in one batch
  async function reconcile(feed: HuntFeed) {
    if (feed.loaded || feed.ready.size < feed.subs.length) return;
    const stale = async (model: AnyModel, seen: Set<string>) => {
      const copies = await model
        .find({ hunt: feed.hunt }, { projection: { _id: 1 } })
        .fetchAsync();
      const gone = copies.map((c) => c._id).filter((id) => !seen.has(id));
      if (gone.length > 0) {
        await model.destroyAsync({ _id: { $in: gone } });
      }
      return gone;
    };
    const gonePuzzles = await stale(Puzzles, feed.seenPuzzles);
    const goneTags = await stale(Tags, feed.seenTags);
    gonePuzzles.forEach((id) => feed.dirtyPuzzles.add(id));
    goneTags.forEach((id) => feed.dirtyTags.add(id));
    feed.loaded = true;
    logger.info("Hunt feed loaded", {
      hunt: feed.hunt,
      puzzles: feed.seenPuzzles.size,
      tags: feed.seenTags.size,
      retired: gonePuzzles.length + goneTags.length,
    });
    await flush(feed);
  }

  async function mirror(
    model: AnyModel,
    declared: Set<string>,
    message: DataMessage,
  ): Promise<string | undefined> {
    const { id } = message;
    if (message.msg === "added") {
      const doc = keep(message.fields, declared);
      const hunt = doc.hunt;
      if (typeof hunt !== "string" || !feeds.has(hunt)) return undefined;
      try {
        await model.upsertAsync({ _id: id }, doc);
      } catch (error) {
        if (!(error instanceof ModelValidationError)) throw error;
        logger.warn("Dropped a document the copy can't hold", {
          collection: message.collection,
          id,
          error: error.message,
        });
        return undefined;
      }
      return hunt;
    }
    const copy = await model.findOneAllowingDeletedAsync(id, {
      projection: { hunt: 1 },
    });
    if (!copy || !feeds.has(copy.hunt)) return undefined;
    if (message.msg === "changed") {
      const set = keep(message.fields, declared);
      const unset = (message.cleared ?? []).filter((k) => declared.has(k));
      if (Object.keys(set).length === 0 && unset.length === 0) return undefined;
      const mod: Record<string, unknown> = {};
      if (Object.keys(set).length > 0) mod.$set = set;
      if (unset.length > 0) {
        mod.$unset = Object.fromEntries(unset.map((k) => [k, ""]));
      }
      try {
        await model.updateAsync({ _id: id }, mod);
      } catch (error) {
        if (!(error instanceof ModelValidationError)) throw error;
        logger.warn("Dropped a change the copy can't hold", {
          collection: message.collection,
          id,
          error: error.message,
        });
        return undefined;
      }
    } else {
      await model.destroyAsync({ _id: id });
    }
    return copy.hunt;
  }

  async function handle(message: DataMessage) {
    if (stopped) return;
    const isPuzzle = message.collection === Puzzles.name;
    const isTag = message.collection === Tags.name;
    if (!isPuzzle && !isTag) return;
    const hunt = isPuzzle
      ? await mirror(Puzzles, PUZZLE_FIELDS, message)
      : await mirror(Tags, TAG_FIELDS, message);
    if (!hunt) return;
    const feed = feeds.get(hunt);
    if (!feed) return;
    const seen = isPuzzle ? feed.seenPuzzles : feed.seenTags;
    if (message.msg === "removed") seen.delete(message.id);
    else seen.add(message.id);
    (isPuzzle ? feed.dirtyPuzzles : feed.dirtyTags).add(message.id);
    scheduleFlush(feed);
  }

  function watch(hunt: string) {
    if (feeds.has(hunt)) return;
    const feed: HuntFeed = {
      hunt,
      subs: [],
      ready: new Set(),
      loaded: false,
      seenPuzzles: new Set(),
      seenTags: new Set(),
      dirtyPuzzles: new Set(),
      dirtyTags: new Set(),
      flushTimer: undefined,
    };
    feeds.set(hunt, feed);
    const handlers = (sub: () => Subscription) => ({
      onReady: () => {
        feed.ready.add(sub().id);
        void enqueue(() => reconcile(feed));
      },
      onStop: (error?: DdpError) => {
        feed.ready.delete(sub().id);
        if (error) {
          logger.error("Jolly Roger refused a hunt subscription", {
            hunt,
            subscription: sub().name,
            error: error.message,
          });
        }
      },
    });
    let puzzles: Subscription;
    let tags: Subscription;
    puzzles = client.subscribe(
      PUZZLES_PUBLICATION,
      [{ huntId: hunt, includeDeleted: true }],
      handlers(() => puzzles),
    );
    tags = client.subscribe(
      TAGS_PUBLICATION,
      [{ huntId: hunt }],
      handlers(() => tags),
    );
    feed.subs = [puzzles, tags];
    logger.info("Following a hunt", { hunt });
  }

  // The copies go with the board, as a purged hunt's did
  function unwatch(hunt: string) {
    const feed = feeds.get(hunt);
    if (!feed) return;
    feeds.delete(hunt);
    feed.subs.forEach((sub) => sub.stop());
    if (feed.flushTimer) {
      clearTimeout(feed.flushTimer);
      feed.flushTimer = undefined;
      pendingFlushes -= 1;
    }
    void enqueue(async () => {
      await Puzzles.removeAsync({ hunt });
      await Tags.removeAsync({ hunt });
    });
    logger.info("No longer following a hunt", { hunt });
  }

  const stopData = client.onData((message) => {
    void enqueue(() => handle(message));
  });
  const stopDisconnected = client.onDisconnected(() => {
    for (const feed of feeds.values()) {
      feed.ready.clear();
      feed.loaded = false;
      feed.seenPuzzles.clear();
      feed.seenTags.clear();
    }
  });
  const stopChanges = onChange(({ collection, id, doc }) => {
    if (collection !== Whiteboards.name) return;
    if (doc && doc.puzzle === undefined) {
      boards.set(id, doc.hunt as string);
      watch(doc.hunt as string);
    } else if (!doc) {
      const hunt = boards.get(id);
      if (hunt === undefined) return;
      boards.delete(id);
      unwatch(hunt);
    }
  });

  void enqueue(async () => {
    const existing = await Whiteboards.find(
      { puzzle: { $exists: false } },
      { projection: { hunt: 1 } },
    ).fetchAsync();
    for (const board of existing) {
      boards.set(board._id, board.hunt);
      watch(board.hunt);
    }
  });

  return {
    hunts: () => [...feeds.keys()],
    async settled() {
      while (pendingFlushes > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await queue;
    },
    async stop() {
      stopped = true;
      stopData();
      stopDisconnected();
      stopChanges();
      for (const feed of feeds.values()) {
        feed.subs.forEach((sub) => sub.stop());
        if (feed.flushTimer) {
          clearTimeout(feed.flushTimer);
          feed.flushTimer = undefined;
          pendingFlushes -= 1;
        }
      }
      feeds.clear();
      await queue;
    },
  };
}
