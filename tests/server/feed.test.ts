import { afterAll, beforeAll, describe, it } from "bun:test";
import { createHash } from "node:crypto";
import { assert } from "chai";
import { Random } from "lib/compat/random";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import { MongoClient } from "mongodb";
import { startService } from "../../server/app";
import type { Feed } from "../../server/feed";
import { startFeed } from "../../server/feed";
import {
  deferredSyncsDone,
  deleteBoard,
  ensureBoard,
} from "../../server/whiteboard";
import {
  resetDatabase,
  setUpDatabase,
  tearDownDatabase,
  waitForAssertion,
} from "./harness";
import { testConfig } from "./service";

// The feed against a running Jolly Roger: the source checkout's app on
// JR_TEST_URL, whose Mongo is JR_TEST_MONGO_URL (the dev Mongo one port up
// from the app, database "meteor"). The test seeds that Mongo directly: a
// service account with a resume token, a hunt, tags and puzzles, in the
// shape Jolly Roger's collection validators want. Without JR_TEST_URL the
// suite is skipped; see README.md for running it.

const JR_URL = process.env.JR_TEST_URL?.replace(/\/$/, "");
const JR_MONGO_URL =
  process.env.JR_TEST_MONGO_URL ??
  (JR_URL
    ? `mongodb://127.0.0.1:${Number(new URL(JR_URL).port || 80) + 1}/meteor`
    : undefined);

if (!JR_URL) {
  console.warn(
    "feed tests skipped: set JR_TEST_URL to a running Jolly Roger (see README.md)",
  );
}

// Meteor stores the sha256 of a resume token, base64
const hashLoginToken = (token: string) =>
  createHash("sha256").update(token).digest("base64");

const WAIT_MS = 15_000;

// Jolly Roger's documents have string ids, which the driver's default
// document type doesn't allow for
type JrDocument = { _id: string } & Record<string, unknown>;

describe("feed", () => {
  it("starts nothing with FEED=off", async () => {
    const service = startService({ config: testConfig() });
    try {
      assert.isUndefined(service.feed);
    } finally {
      await service.stop();
    }
  });
});

describe.skipIf(!JR_URL)("feed from Jolly Roger", () => {
  let jr: MongoClient;
  let feed: Feed;
  let boardId: string;
  const userId = Random.id();
  const token = Random.id(43);
  const hunt = Random.id();
  const groupA = Random.id();
  const groupB = Random.id();
  const puzzleOne = Random.id();
  const puzzleTwo = Random.id();
  const puzzleThree = Random.id();
  const puzzleLate = Random.id();
  const puzzleWhileAway = Random.id();

  const stamp = () => {
    const now = new Date();
    return {
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      deleted: false,
    };
  };
  const jrPuzzle = (_id: string, title: string, tags: string[]) => ({
    _id,
    hunt,
    title,
    tags,
    answers: [],
    expectedAnswerCount: 1,
    ...stamp(),
  });

  const cardOf = (puzzle: string) =>
    WhiteboardNodes.findOneAsync({ board: boardId, puzzle });
  const frameOf = (tag: string) =>
    WhiteboardNodes.findOneAsync({ board: boardId, type: "frame", tag });
  const settled = async () => {
    await feed.hunts.settled();
    await deferredSyncsDone();
  };

  beforeAll(async () => {
    await setUpDatabase();
    await resetDatabase();
    jr = new MongoClient(JR_MONGO_URL!);
    await jr.connect();
    const db = jr.db();
    await db.collection<JrDocument>("users").insertOne({
      _id: userId,
      createdAt: new Date(),
      emails: [{ address: `board-${userId}@example.test`, verified: true }],
      services: {
        resume: {
          loginTokens: [
            { hashedToken: hashLoginToken(token), when: new Date() },
          ],
        },
      },
      hunts: [hunt],
      displayName: "Hunt board",
    });
    await db.collection<JrDocument>("jr_hunts").insertOne({
      _id: hunt,
      name: "Feed test hunt",
      mailingLists: [],
      openSignups: false,
      hasGuessQueue: true,
      defaultRoles: [],
      allowUnlockablePuzzles: false,
      isArchived: false,
      customLinkEmbed: false,
      ...stamp(),
    });
    await db.collection<JrDocument>("jr_tags").insertMany([
      { _id: groupA, hunt, name: "group:alpha", ...stamp() },
      { _id: groupB, hunt, name: "group:beta", ...stamp() },
    ]);
    await db
      .collection<JrDocument>("jr_puzzles")
      .insertMany([
        jrPuzzle(puzzleOne, "One", [groupA]),
        jrPuzzle(puzzleTwo, "Two", [groupA]),
        jrPuzzle(puzzleThree, "Three", [groupB]),
      ]);
    feed = startFeed(
      testConfig({ jrUrl: JR_URL!, feed: { enabled: true, token } }),
      { minBackoffMs: 300, maxBackoffMs: 1000, pingIntervalMs: 0 },
    );
  });

  afterAll(async () => {
    await feed?.stop();
    if (jr) {
      const db = jr.db();
      await db.collection<JrDocument>("users").deleteOne({ _id: userId });
      await db.collection<JrDocument>("jr_hunts").deleteOne({ _id: hunt });
      await db.collection<JrDocument>("jr_tags").deleteMany({ hunt });
      await db.collection<JrDocument>("jr_puzzles").deleteMany({ hunt });
      await jr.close();
    }
    await deferredSyncsDone();
    await tearDownDatabase();
  });

  it("logs in with the resume token", async () => {
    await waitForAssertion(() => {
      assert.isTrue(feed.client.isLoggedIn);
    }, WAIT_MS);
    assert.equal(feed.client.userId, userId);
    assert.isString(feed.client.token);
  });

  it("mirrors a hunt's puzzles and tags once it has a board, and places them", async () => {
    assert.deepEqual(feed.hunts.hunts(), []);
    boardId = await ensureBoard({ hunt });
    await waitForAssertion(async () => {
      assert.deepEqual(feed.hunts.hunts(), [hunt]);
      assert.equal(await Puzzles.find({ hunt }).countAsync(), 3);
      assert.equal(await Tags.find({ hunt }).countAsync(), 2);
    }, WAIT_MS);
    const copy = await Puzzles.findOneAsync(puzzleOne);
    assert.equal(copy?.title, "One");
    assert.deepEqual(copy?.tags, [groupA]);
    assert.equal(copy?.createdBy, userId);
    await waitForAssertion(async () => {
      const alpha = await frameOf(groupA);
      const beta = await frameOf(groupB);
      assert.isDefined(alpha);
      assert.isDefined(beta);
      assert.equal((await cardOf(puzzleOne))?.parent, alpha?._id);
      assert.equal((await cardOf(puzzleTwo))?.parent, alpha?._id);
      assert.equal((await cardOf(puzzleThree))?.parent, beta?._id);
    }, WAIT_MS);
  });

  it("places a puzzle added while subscribed", async () => {
    await jr
      .db()
      .collection<JrDocument>("jr_puzzles")
      .insertOne(jrPuzzle(puzzleLate, "Late", [groupB]));
    await waitForAssertion(async () => {
      const card = await cardOf(puzzleLate);
      assert.isDefined(card);
      assert.equal(card?.parent, (await frameOf(groupB))?._id);
    }, WAIT_MS);
  });

  it("moves a card when its puzzle's tags change", async () => {
    await jr
      .db()
      .collection<JrDocument>("jr_puzzles")
      .updateOne({ _id: puzzleTwo }, { $set: { tags: [groupB] } });
    await waitForAssertion(async () => {
      assert.deepEqual((await Puzzles.findOneAsync(puzzleTwo))?.tags, [groupB]);
      assert.equal(
        (await cardOf(puzzleTwo))?.parent,
        (await frameOf(groupB))?._id,
      );
    }, WAIT_MS);
  });

  it("follows a tag's rename to the puzzles carrying it", async () => {
    await jr
      .db()
      .collection<JrDocument>("jr_tags")
      .updateOne({ _id: groupA }, { $set: { name: "group:alpha-renamed" } });
    await waitForAssertion(async () => {
      assert.equal(
        (await Tags.findOneAsync(groupA))?.name,
        "group:alpha-renamed",
      );
    }, WAIT_MS);
    await settled();
    assert.equal(
      (await cardOf(puzzleOne))?.parent,
      (await frameOf(groupA))?._id,
    );
  });

  it("hides the card of a puzzle Jolly Roger deletes, and shows it again", async () => {
    const puzzles = jr.db().collection<JrDocument>("jr_puzzles");
    await puzzles.updateOne({ _id: puzzleThree }, { $set: { deleted: true } });
    await waitForAssertion(async () => {
      const copy = await Puzzles.findOneAllowingDeletedAsync(puzzleThree);
      assert.isTrue(copy?.deleted);
      const card = await cardOf(puzzleThree);
      assert.isTrue(card?.hidden);
      assert.isTrue(card?.hiddenWithPuzzle);
    }, WAIT_MS);
    await puzzles.updateOne({ _id: puzzleThree }, { $set: { deleted: false } });
    await waitForAssertion(async () => {
      assert.isFalse(
        (await Puzzles.findOneAllowingDeletedAsync(puzzleThree))?.deleted,
      );
      const card = await cardOf(puzzleThree);
      assert.isUndefined(card?.hidden);
      assert.isUndefined(card?.hiddenWithPuzzle);
    }, WAIT_MS);
  });

  it("resyncs after a reconnect", async () => {
    const disconnected = new Promise<void>((resolve) => {
      const off = feed.client.onDisconnected(() => {
        off();
        resolve();
      });
    });
    feed.client.dropConnection();
    await disconnected;
    // Changes the feed can't hear, and a copy that has drifted
    const puzzles = jr.db().collection<JrDocument>("jr_puzzles");
    await puzzles.insertOne(jrPuzzle(puzzleWhileAway, "While away", [groupA]));
    await puzzles.deleteOne({ _id: puzzleLate });
    await Puzzles.updateAsync(puzzleOne, { $set: { title: "Drifted" } });

    await waitForAssertion(async () => {
      assert.isTrue(feed.client.isLoggedIn);
      assert.equal((await Puzzles.findOneAsync(puzzleOne))?.title, "One");
      assert.isTrue(
        (await Puzzles.findOneAllowingDeletedAsync(puzzleLate))?.deleted,
      );
      assert.isDefined(await Puzzles.findOneAsync(puzzleWhileAway));
    }, WAIT_MS);
    await waitForAssertion(async () => {
      assert.isTrue((await cardOf(puzzleLate))?.hiddenWithPuzzle);
      assert.equal(
        (await cardOf(puzzleWhileAway))?.parent,
        (await frameOf(groupA))?._id,
      );
    }, WAIT_MS);
  });

  it("stops following a hunt whose board is deleted", async () => {
    await deleteBoard(boardId);
    await waitForAssertion(async () => {
      assert.deepEqual(feed.hunts.hunts(), []);
      assert.equal(await Puzzles.findAllowingDeleted({ hunt }).countAsync(), 0);
      assert.equal(await Tags.findAllowingDeleted({ hunt }).countAsync(), 0);
    }, WAIT_MS);
  });
});
