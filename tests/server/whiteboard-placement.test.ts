import { afterAll, beforeAll, beforeEach, describe, it, spyOn } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import FixtureHunt from "lib/fixtureHunt";
import BoardComments from "lib/models/BoardComments";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import type { WhiteboardNodeInput } from "lib/protocol";
import { CARD_HEIGHT, CARD_WIDTH, cardSlot } from "lib/whiteboard/layout";
import {
  MAX_BATCH,
  MAX_EDGES_PER_BOARD,
  MAX_FEEDERS_PER_META,
  MAX_NODES_PER_BOARD,
} from "lib/whiteboard/limits";
import { postComment } from "../../server/comments";
import Logger from "../../server/logger";
import Locks from "../../server/models/Locks";
import WhiteboardVersionChunks from "../../server/models/WhiteboardVersionChunks";
import {
  deferredSyncsDone,
  deferSyncPuzzlesOnBoard,
  deleteBoard,
  ensureBoard,
  syncAutoEdges,
  syncPuzzlesOnBoard,
} from "../../server/whiteboard";
import {
  deleteEdges,
  deleteNodes,
  upsertEdges,
  upsertNodes,
} from "../../server/whiteboardEdits";
import { decodeVersion, restoreVersion } from "../../server/whiteboardVersions";
import { otherHuntBoard } from "./fixtures";
import {
  archived,
  call,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setFlag,
  setUpDatabase,
  spyOnMethod,
  tearDownDatabase,
  waitForAssertion,
} from "./harness";

describe("whiteboard", () => {
  let operator: Claims;
  let member: Claims;
  let outsider: Claims;
  let boardId: string;

  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  beforeEach(async () => {
    await resetDatabase();
    operator = makeUser(true);
    member = makeUser();
    outsider = { ...makeUser(), scope: { hunt: Random.id() } };
    await makeFixtureHunt(operator.user);
  });

  // The hunt's board, fresh for the test
  const makeBoard = async () => {
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
  };
  const node = (id: string) => WhiteboardNodes.findOneAsync(id);
  const edge = (id: string) => WhiteboardEdges.findOneAsync(id);
  // A new sticky at (x, y), with whatever else `extra` sends with it
  const stickyInput = (
    x: number,
    y: number,
    extra: Partial<WhiteboardNodeInput> = {},
  ) => ({
    _id: Random.id(),
    type: "sticky" as const,
    position: { x, y },
    ...extra,
  });
  // Puts a sticky on the board as claims, and returns its id
  const addSticky = async (
    claims: Claims,
    position: { x: number; y: number },
    extra: Partial<WhiteboardNodeInput> = {},
  ) => {
    const _id = Random.id();
    await upsertNodes(claims, boardId, [
      { _id, type: "sticky", position, ...extra },
    ]);
    return _id;
  };
  const setPolicy = (
    claims: Claims,
    editPolicy: "members" | "operators" | "operatorsAndEditors",
    editors: string[] = [],
  ) => call("setEditPolicy", claims, boardId, { editPolicy, editors });
  // Nodes straight into the board, bypassing the caps, leaving `room` for more
  const fillNodesToCap = async (room: number) => {
    const have = await WhiteboardNodes.find({ board: boardId }).countAsync();
    await WhiteboardNodes.insertManyAsync(
      Array.from({ length: MAX_NODES_PER_BOARD - have - room }, (_, i) => ({
        hunt: huntId,
        board: boardId,
        type: "text" as const,
        position: { x: i, y: 0 },
        createdBy: member.user,
      })),
    );
  };
  // Lines from a to b straight into the board, leaving `room` for more
  const fillEdgesToCap = async (a: string, b: string, room: number) => {
    const have = await WhiteboardEdges.find({ board: boardId }).countAsync();
    await WhiteboardEdges.insertManyAsync(
      Array.from({ length: MAX_EDGES_PER_BOARD - have - room }, () => ({
        hunt: huntId,
        board: boardId,
        source: a,
        target: b,
        createdBy: member.user,
      })),
    );
  };
  // As the feed does when Jolly Roger's puzzles change
  const feedPuzzles = async (ids: string[]) => {
    deferSyncPuzzlesOnBoard(huntId, ids);
    await deferredSyncsDone();
  };

  describe("ensureBoard", () => {
    it("seeds a frame per round, a card per puzzle and feeder arrows", async () => {
      const boardId = await ensureBoard({ hunt: huntId }, operator.user);
      const board = await Whiteboards.findOneAsync(boardId);
      assert.ok(board);
      assert.isUndefined(board.puzzle);

      const cards = await WhiteboardNodes.find({
        board: boardId,
        type: "puzzle",
      }).fetchAsync();
      assert.equal(cards.length, FixtureHunt.puzzles.length);
      const frames = await WhiteboardNodes.find({
        board: boardId,
        type: "frame",
      }).fetchAsync();
      const frameIds = new Set(frames.map((f) => f._id));
      cards.forEach((card) => assert.isTrue(frameIds.has(card.parent!)));
      frames.forEach((frame) => {
        if (frame.parent) assert.isTrue(frameIds.has(frame.parent));
      });
      // A round's frame keeps its name, should its tag go
      const anger = FixtureHunt.tags.find((t) => t.name === "group:anger")!;
      assert.equal(frames.find((f) => f.tag === anger._id)?.label, "anger");

      const cardIds = new Set(cards.map((c) => c._id));
      const edges = await WhiteboardEdges.find({ board: boardId }).fetchAsync();
      assert.isAbove(edges.length, 0);
      edges.forEach((edge) => {
        assert.isTrue(edge.auto);
        assert.isTrue(cardIds.has(edge.source));
        assert.isTrue(cardIds.has(edge.target));
      });
    });

    it("returns the existing board on a second call", async () => {
      const first = await ensureBoard({ hunt: huntId }, operator.user);
      const second = await ensureBoard({ hunt: huntId });
      assert.equal(second, first);
      assert.equal(await Whiteboards.find({ hunt: huntId }).countAsync(), 1);
      assert.equal(
        await WhiteboardNodes.find({
          board: first,
          type: "puzzle",
        }).countAsync(),
        FixtureHunt.puzzles.length,
      );
    });

    it("gives a puzzle its own board, empty, beside the hunt's", async () => {
      const huntBoard = await ensureBoard({ hunt: huntId }, operator.user);
      const puzzle = FixtureHunt.puzzles[0]!._id;
      const puzzleBoard = await ensureBoard({ hunt: huntId, puzzle });
      assert.notEqual(puzzleBoard, huntBoard);
      assert.equal(await ensureBoard({ hunt: huntId, puzzle }), puzzleBoard);
      assert.equal(
        (await Whiteboards.findOneAsync(puzzleBoard))?.puzzle,
        puzzle,
      );
      assert.equal(
        await WhiteboardNodes.find({ board: puzzleBoard }).countAsync(),
        0,
      );
      // Placement only ever looks at the hunt's board
      await syncPuzzlesOnBoard(huntId, [puzzle]);
      assert.equal(
        await WhiteboardNodes.find({ board: puzzleBoard }).countAsync(),
        0,
      );
    });

    it("refuses while the whiteboard is switched off", async () => {
      await setFlag("disable.whiteboard");
      await rejects(ensureBoard({ hunt: huntId }), /disabled/);
      assert.equal(await Whiteboards.find({}).countAsync(), 0);
    });
  });

  describe("placement", () => {
    const groupTag = FixtureHunt.tags.find((t) => t.name === "group:anger")!;
    const otherGroupTag = FixtureHunt.tags.find((t) => t.name === "group:joy")!;

    const frameFor = async (tagId: string) =>
      (await WhiteboardNodes.findOneAsync({ board: boardId, tag: tagId }))!;
    const cardFor = async (puzzleId: string) =>
      (await WhiteboardNodes.findOneAsync({
        board: boardId,
        puzzle: puzzleId,
      }))!;
    const newPuzzle = (title: string, tags: string[], locked?: boolean) =>
      Puzzles.insertAsync({
        hunt: huntId,
        title,
        tags,
        answers: [],
        expectedAnswerCount: 1,
        ...(locked ? { locked } : {}),
        createdBy: operator.user,
      });

    beforeEach(makeBoard);

    it("places puzzles the feed adds, locked or not", async () => {
      const opened = await newPuzzle("Added", [groupTag._id]);
      const locked = await newPuzzle("Not yet", [groupTag._id], true);
      await feedPuzzles([opened, locked]);
      const frame = await frameFor(groupTag._id);
      await waitForAssertion(async () => {
        assert.equal((await cardFor(opened))?.parent, frame._id);
        assert.equal((await cardFor(locked))?.parent, frame._id);
      });
    });

    it("gives each new puzzle its own slot, even all at once", async () => {
      const ids = await Promise.all(
        ["One", "Two", "Three", "Four"].map((title) =>
          newPuzzle(title, [groupTag._id]),
        ),
      );
      await Promise.all(ids.map((id) => syncPuzzlesOnBoard(huntId, [id])));
      const frame = await frameFor(groupTag._id);
      const siblings = await WhiteboardNodes.find({
        board: boardId,
        parent: frame._id,
      }).fetchAsync();
      const slots = new Set(
        siblings.map((n) => `${n.position.x},${n.position.y}`),
      );
      assert.equal(slots.size, siblings.length);
      for (const id of ids) {
        assert.equal((await cardFor(id)).parent, frame._id);
      }
      // The frame grew to fit them
      siblings.forEach((n) => {
        assert.isAtMost(n.position.x + (n.width ?? CARD_WIDTH), frame.width!);
        assert.isAtMost(
          n.position.y + (n.height ?? CARD_HEIGHT),
          frame.height!,
        );
      });
    });

    it("makes a frame for a new round, and an Ungrouped frame", async () => {
      const roundId = await Tags.insertAsync({
        hunt: huntId,
        name: "group:brand-new",
        createdBy: operator.user,
      });
      const inRound = await newPuzzle("In the round", [roundId]);
      const loose = await newPuzzle("Loose", []);
      await syncPuzzlesOnBoard(huntId, [inRound, loose]);

      const roundFrame = await frameFor(roundId);
      assert.equal(roundFrame.label, "brand-new");
      assert.equal(roundFrame.frameKind, "group");
      assert.notOk(roundFrame.parent);
      assert.equal((await cardFor(inRound)).parent, roundFrame._id);

      const ungrouped = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        frameKind: "ungrouped",
      }))!;
      assert.equal(ungrouped.label, "Ungrouped");
      assert.equal((await cardFor(loose)).parent, ungrouped._id);
    });

    it("moves untouched cards when their group changes, but not moved ones", async () => {
      const [first, second] = await Puzzles.find({
        hunt: huntId,
        tags: groupTag._id,
        kind: { $ne: "whiteboard" },
      }).fetchAsync();
      await upsertNodes(member, boardId, [
        { _id: (await cardFor(second!._id))._id, position: { x: 5, y: 5 } },
      ]);

      for (const puzzle of [first!, second!]) {
        await Puzzles.updateAsync(puzzle._id, {
          $set: { tags: [otherGroupTag._id] },
        });
      }
      await syncPuzzlesOnBoard(huntId, [first!._id, second!._id]);

      const otherFrame = await frameFor(otherGroupTag._id);
      assert.equal((await cardFor(first!._id)).parent, otherFrame._id);
      const moved = await cardFor(second!._id);
      assert.notEqual(moved.parent, otherFrame._id);
      assert.deepEqual(moved.position, { x: 5, y: 5 });
      assert.isTrue(moved.manual);
    });

    it("follows tags added and removed by the feed", async () => {
      const puzzleId = await newPuzzle("Retagged", []);
      await syncPuzzlesOnBoard(huntId, [puzzleId]);
      const ungrouped = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        frameKind: "ungrouped",
      }))!;
      assert.equal((await cardFor(puzzleId)).parent, ungrouped._id);

      await Puzzles.updateAsync(puzzleId, {
        $addToSet: { tags: otherGroupTag._id },
      });
      await feedPuzzles([puzzleId]);
      const joy = await frameFor(otherGroupTag._id);
      await waitForAssertion(async () => {
        assert.equal((await cardFor(puzzleId)).parent, joy._id);
      });

      await Puzzles.updateAsync(puzzleId, {
        $pull: { tags: otherGroupTag._id },
      });
      await feedPuzzles([puzzleId]);
      await waitForAssertion(async () => {
        assert.equal((await cardFor(puzzleId)).parent, ungrouped._id);
      });
    });

    it("follows a puzzle's tags replaced whole", async () => {
      const puzzleId = await newPuzzle("Edited", [groupTag._id]);
      await syncPuzzlesOnBoard(huntId, [puzzleId]);
      await Puzzles.updateAsync(puzzleId, {
        $set: { tags: [otherGroupTag._id] },
      });
      await feedPuzzles([puzzleId]);
      const joy = await frameFor(otherGroupTag._id);
      await waitForAssertion(async () => {
        assert.equal((await cardFor(puzzleId)).parent, joy._id);
      });
    });

    describe("past the board's caps", () => {
      // Feeders tagged with a new round, and a meta whose tag becomes that
      // round's meta-for: tag only once they're all on the board
      const round = async (name: string, feederCount: number) => {
        const roundTag = await Tags.insertAsync({
          hunt: huntId,
          name: `group:${name}`,
          createdBy: operator.user,
        });
        const metaTag = await Tags.insertAsync({
          hunt: huntId,
          name: `meta-someday:${name}`,
          createdBy: operator.user,
        });
        const feeders: string[] = [];
        for (let i = 0; i < feederCount; i++) {
          feeders.push(await newPuzzle(`${name} ${i}`, [roundTag]));
        }
        const meta = await newPuzzle(`${name} meta`, [metaTag]);
        await syncPuzzlesOnBoard(huntId, [...feeders, meta]);
        const rename = async () => {
          await Tags.updateAsync(metaTag, {
            $set: { name: `meta-for:${name}` },
          });
          return (await Puzzles.findOneAsync(meta))!;
        };
        return { feeders, meta, rename };
      };
      const arrowsTo = (meta: string) =>
        WhiteboardEdges.find({ board: boardId, auto: true, meta }).fetchAsync();
      const warnedWith = (warn: { mock: { calls: unknown[][] } }, re: RegExp) =>
        warn.mock.calls.some(([message]) => re.test(String(message)));

      it("draws a meta's arrows from its first 200 feeders, renewing the lock as it goes", async () => {
        const { feeders, meta, rename } = await round(
          "huge",
          MAX_FEEDERS_PER_META + 5,
        );
        const metaPuzzle = await rename();
        const warn = spyOn(Logger, "warn");
        let renewals = 0;
        const renew = async () => {
          renewals += 1;
        };
        try {
          await syncAutoEdges(
            (await Whiteboards.findOneAsync(boardId))!,
            [metaPuzzle],
            await Tags.find({ hunt: huntId }).fetchAsync(),
            renew,
          );

          const first = (
            await Puzzles.find({ _id: { $in: feeders } }).fetchAsync()
          )
            .toSorted(
              (a, b) =>
                +a.createdAt - +b.createdAt || a._id.localeCompare(b._id),
            )
            .slice(0, MAX_FEEDERS_PER_META)
            .map((p) => p._id);
          assert.sameMembers(
            (await arrowsTo(meta)).map((a) => a.feeder),
            first,
          );
          assert.equal(renewals, MAX_FEEDERS_PER_META / 100);
          assert.isTrue(warnedWith(warn, /too many feeders/));
        } finally {
          warn.mockRestore();
        }

        // A later sync of a feeder past the first 200 leaves it out too
        await syncPuzzlesOnBoard(huntId, feeders);
        assert.lengthOf(await arrowsTo(meta), MAX_FEEDERS_PER_META);
      });

      it("stops drawing feeder arrows once the board has as many lines as it can hold", async () => {
        const { meta, rename } = await round("crowded", 10);
        const [a, b] = await WhiteboardNodes.find(
          { board: boardId, type: "puzzle" },
          { limit: 2 },
        ).fetchAsync();
        const room = 3;
        await fillEdgesToCap(a!._id, b!._id, room);
        await rename();
        const warn = spyOn(Logger, "warn");
        try {
          await syncPuzzlesOnBoard(huntId, [meta]);

          assert.lengthOf(await arrowsTo(meta), room);
          assert.equal(
            await WhiteboardEdges.find({ board: boardId }).countAsync(),
            MAX_EDGES_PER_BOARD,
          );
          assert.isTrue(warnedWith(warn, /no room/));
        } finally {
          warn.mockRestore();
        }
      });

      it("puts a card at the top level rather than add a frame to a full board", async () => {
        await fillNodesToCap(0);
        const tag = await Tags.insertAsync({
          hunt: huntId,
          name: "group:no-room",
          createdBy: operator.user,
        });
        const puzzleId = await newPuzzle("No room", [tag]);
        const warn = spyOn(Logger, "warn");
        try {
          await syncPuzzlesOnBoard(huntId, [puzzleId]);

          assert.notOk(
            await WhiteboardNodes.findOneAsync({ board: boardId, tag }),
          );
          const card = await cardFor(puzzleId);
          assert.ok(card);
          assert.isUndefined(card.parent);
          assert.isTrue(warnedWith(warn, /full whiteboard/));
        } finally {
          warn.mockRestore();
        }
      });
    });

    it("follows a tag renamed into a round", async () => {
      const tagId = await Tags.insertAsync({
        hunt: huntId,
        name: "someday-a-round",
        createdBy: operator.user,
      });
      const puzzleId = await newPuzzle("Renamed", [tagId]);
      await syncPuzzlesOnBoard(huntId, [puzzleId]);

      await Tags.updateAsync(tagId, { $set: { name: "group:renamed" } });
      await feedPuzzles([puzzleId]);
      await waitForAssertion(async () => {
        const frame = await frameFor(tagId);
        assert.ok(frame);
        assert.equal((await cardFor(puzzleId)).parent, frame._id);
      });
    });

    it("tries a deferred sync that fails once more", async () => {
      const puzzleId = await newPuzzle("Retried", [groupTag._id]);
      const frame = await frameFor(groupTag._id);
      // The sync's first read of the hunt's tags fails
      const find = Tags.find.bind(Tags);
      let failed = false;
      const sync = spyOnMethod(Tags, "find").mockImplementation(
        (...args: Parameters<typeof find>) => {
          const selector = args[0] as Record<string, unknown> | undefined;
          if (!failed && selector?.hunt === huntId) {
            failed = true;
            throw new Error("connection reset");
          }
          return find(...args);
        },
      );
      const error = spyOn(Logger, "error").mockImplementation(() => {});
      try {
        deferSyncPuzzlesOnBoard(huntId, [puzzleId]);
        await waitForAssertion(async () => {
          assert.equal((await cardFor(puzzleId))?.parent, frame._id);
        });
      } finally {
        sync.mockRestore();
        error.mockRestore();
      }
    });

    it("folds a burst of deferred syncs for a hunt into one", async () => {
      const ids = await Promise.all(
        ["One", "Two", "Three", "Four", "Five"].map((title) =>
          newPuzzle(title, [groupTag._id]),
        ),
      );
      const frame = await frameFor(groupTag._id);
      const lookups = spyOnMethod(Whiteboards, "findOneAsync");
      try {
        ids.forEach((id) => deferSyncPuzzlesOnBoard(huntId, [id]));
        await waitForAssertion(async () => {
          for (const id of ids) {
            assert.equal((await cardFor(id))?.parent, frame._id);
          }
        });
        assert.lengthOf(
          lookups.mock.calls.filter(
            ([selector]) =>
              typeof selector === "object" &&
              selector !== null &&
              (selector as { hunt?: string }).hunt === huntId,
          ),
          1,
        );
      } finally {
        lookups.mockRestore();
      }
    });

    it("brings a round's cards back when its frame is put back", async () => {
      const added = await newPuzzle("Comes back", [groupTag._id]);
      await syncPuzzlesOnBoard(huntId, [added]);
      const frame = await frameFor(groupTag._id);
      const cards = await WhiteboardNodes.find({
        board: boardId,
        parent: frame._id,
        type: "puzzle",
      }).fetchAsync();
      const metaTag = FixtureHunt.tags.find(
        (t) => t.name === "meta-for:anger",
      )!;
      // The meta is placed by its meta-for: tag rather than the frame's own
      const meta = (await Puzzles.findOneAsync({ tags: metaTag._id }))!;
      assert.include(
        cards.map((c) => c.puzzle),
        meta._id,
      );
      // Cards whose puzzles placement would put in this frame rather than
      // another of their rounds'
      const frameTags = new Set(
        FixtureHunt.tags
          .filter(
            (t) => t.name.startsWith("group:") || t.name === "administrivia",
          )
          .map((t) => t._id),
      );
      const puzzles = await Puzzles.find({
        _id: { $in: cards.map((c) => c.puzzle!) },
      }).fetchAsync();
      const onlyHere = new Set(
        puzzles
          .filter(
            (p) =>
              p._id === meta._id ||
              p.tags.filter((t) => frameTags.has(t)).join(",") === groupTag._id,
          )
          .map((p) => p._id),
      );
      const moved = cards.find(
        (c) => c.puzzle !== meta._id && c.puzzle !== added,
      );
      const rest = cards.filter((c) => c !== moved && onlyHere.has(c.puzzle!));
      assert.isAtLeast(rest.length, 2);

      await deleteNodes(member, boardId, [frame._id]);
      assert.equal((await cardFor(moved!.puzzle!)).parent, frame.parent);
      // Moved by hand while the frame was gone, so it stays where it was put
      await upsertNodes(member, boardId, [
        { _id: moved!._id, position: { x: -5000, y: -5000 } },
      ]);
      await upsertNodes(member, boardId, [
        {
          _id: frame._id,
          hidden: false,
          parent: null,
          position: { x: 9000, y: 9000 },
        },
      ]);
      await waitForAssertion(async () => {
        for (const card of rest) {
          assert.equal((await cardFor(card.puzzle!)).parent, frame._id);
        }
      });
      assert.equal((await cardFor(moved!.puzzle!)).parent, frame.parent);
    });

    describe("bringing a round back only when its frame is put back", () => {
      // A card taken out of its round's frame without being marked as moved
      // by hand, which a sync of its round would put straight back.
      const strayCard = async (frameId: string) => {
        const card = (await WhiteboardNodes.findOneAsync({
          board: boardId,
          parent: frameId,
          type: "puzzle",
        }))!;
        await WhiteboardNodes.updateAsync(card._id, {
          $set: { position: { x: -7000, y: -7000 } },
          $unset: { parent: 1 },
        });
        return card._id;
      };
      // Room for a deferred sync to have run, had one been asked for.
      const settle = async () => {
        await deferredSyncsDone();
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      };

      it("leaves the cards for an edit to a frame that's on the board", async () => {
        const frame = await frameFor(groupTag._id);
        const card = await strayCard(frame._id);
        await upsertNodes(member, boardId, [
          {
            _id: frame._id,
            position: { x: frame.position.x + 100, y: frame.position.y },
          },
        ]);
        await settle();
        const after = await node(card);
        assert.isUndefined(after?.parent);
        assert.deepEqual(after?.position, { x: -7000, y: -7000 });
      });

      it("leaves the cards when putting the frame back is refused", async () => {
        const frame = await frameFor(groupTag._id);
        const card = (await WhiteboardNodes.findOneAsync({
          board: boardId,
          parent: frame._id,
          type: "puzzle",
        }))!;
        // Its cards stay where they were, outside it
        await deleteNodes(member, boardId, [frame._id]);
        await rejects(
          upsertNodes(archived(member), boardId, [
            { _id: frame._id, hidden: false, parent: null },
          ]),
          /archived/,
        );
        await settle();
        assert.isTrue((await node(frame._id))?.hidden);
        assert.equal((await node(card._id))?.parent, frame.parent);
      });
    });

    it("drops feeder arrows when the tag goes, and keeps hidden ones hidden", async () => {
      const edge = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      const feeder = (await Puzzles.findOneAsync(edge.feeder))!;

      await WhiteboardEdges.updateAsync(edge._id, { $set: { hidden: true } });
      await syncPuzzlesOnBoard(huntId, [feeder._id]);
      assert.isTrue((await WhiteboardEdges.findOneAsync(edge._id))?.hidden);

      await Puzzles.updateAsync(feeder._id, { $set: { tags: [] } });
      await syncPuzzlesOnBoard(huntId, [feeder._id]);
      assert.equal(
        await WhiteboardEdges.find({
          board: boardId,
          feeder: feeder._id,
        }).countAsync(),
        0,
      );
    });

    it("draws an arrow when a feeder joins a round with a meta", async () => {
      const meta = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!.meta!;
      const metaPuzzle = (await Puzzles.findOneAsync(meta))!;
      const metaFor = (
        await Tags.find({ _id: { $in: metaPuzzle.tags } }).fetchAsync()
      ).find((t) => t.name.startsWith("meta-for:"))!;
      const round = (await Tags.findOneAsync({
        hunt: huntId,
        name: `group:${metaFor.name.slice("meta-for:".length)}`,
      }))!;

      const feeder = await newPuzzle("Late feeder", [round._id]);
      await syncPuzzlesOnBoard(huntId, [feeder]);
      const edge = await WhiteboardEdges.findOneAsync({
        board: boardId,
        feeder,
        meta,
      });
      assert.ok(edge);
      assert.equal(edge.source, (await cardFor(feeder))._id);
      assert.equal(edge.target, (await cardFor(meta))._id);
    });

    it("grows each frame once when frames have ended up inside each other", async () => {
      // Only two moves racing each other can leave frames like this.
      const frame = await frameFor(groupTag._id);
      const other = await frameFor(otherGroupTag._id);
      await WhiteboardNodes.updateAsync(frame._id, {
        $set: { parent: other._id, width: 1, height: 1 },
      });
      await WhiteboardNodes.updateAsync(other._id, {
        $set: { parent: frame._id },
      });
      const puzzleId = await newPuzzle("In a loop", [groupTag._id]);
      await syncPuzzlesOnBoard(huntId, [puzzleId]);
      assert.equal((await cardFor(puzzleId)).parent, frame._id);
    });

    it("leaves a card someone moves while it's being placed", async () => {
      const puzzleId = await newPuzzle("Dragged", [groupTag._id]);
      await syncPuzzlesOnBoard(huntId, [puzzleId]);
      const card = await cardFor(puzzleId);
      await Puzzles.updateAsync(puzzleId, {
        $set: { tags: [otherGroupTag._id] },
      });

      // The drag lands after placement has read the card, before it moves it.
      const update = WhiteboardNodes.updateAsync.bind(WhiteboardNodes);
      const stub = spyOn(WhiteboardNodes, "updateAsync").mockImplementation(
        async (...args: Parameters<typeof update>) => {
          const selector = args[0] as { _id?: string };
          if (typeof selector === "object" && selector._id === card._id) {
            await update(card._id, {
              $set: { position: { x: 5, y: 5 }, manual: true },
            });
          }
          return update(...args);
        },
      );
      try {
        await syncPuzzlesOnBoard(huntId, [puzzleId]);
      } finally {
        stub.mockRestore();
      }
      const saved = await cardFor(puzzleId);
      assert.equal(saved.parent, card.parent);
      assert.deepEqual(saved.position, { x: 5, y: 5 });
    });

    it("places a card into a collapsed frame and grows it", async () => {
      const frame = await frameFor(groupTag._id);
      await upsertNodes(member, boardId, [{ _id: frame._id, collapsed: true }]);
      // More than a row's worth, so the frame needs another row
      const ids = [];
      for (const title of ["C1", "C2", "C3", "C4", "C5"]) {
        ids.push(await newPuzzle(title, [groupTag._id]));
      }
      await syncPuzzlesOnBoard(huntId, ids);
      for (const id of ids) {
        assert.equal((await cardFor(id)).parent, frame._id);
      }
      const grown = (await node(frame._id))!;
      assert.isTrue(grown.collapsed);
      assert.isAbove(grown.height!, frame.height!);
    });

    it("doesn't bring back a hidden card", async () => {
      const puzzle = (await Puzzles.findOneAsync({
        hunt: huntId,
        tags: groupTag._id,
      }))!;
      const card = await cardFor(puzzle._id);
      await deleteNodes(member, boardId, [card._id]);
      await syncPuzzlesOnBoard(huntId, [puzzle._id]);
      assert.isTrue((await node(card._id))?.hidden);
    });

    it("keeps a new feeder out of a seeded round's meta row", async () => {
      const frame = await frameFor(groupTag._id);
      const metaRow = cardSlot(0).y;
      const inMetaRow = await WhiteboardNodes.find({
        board: boardId,
        parent: frame._id,
        "position.y": metaRow,
      }).fetchAsync();
      // The round's meta, with room beside it
      assert.isNotEmpty(inMetaRow);
      assert.isBelow(inMetaRow.length, 4);

      const feeder = await newPuzzle("Late feeder", [groupTag._id]);
      await syncPuzzlesOnBoard(huntId, [feeder]);
      const card = await cardFor(feeder);
      assert.equal(card.parent, frame._id);
      assert.isAbove(card.position.y, metaRow);
    });

    it("puts a round's metas on a row of their own, and later feeders below", async () => {
      const round = await Tags.insertAsync({
        hunt: huntId,
        name: "group:late-round",
        createdBy: operator.user,
      });
      const metaFor = await Tags.insertAsync({
        hunt: huntId,
        name: "meta-for:late-round",
        createdBy: operator.user,
      });
      const meta = await newPuzzle("Late meta", [round, metaFor]);
      await syncPuzzlesOnBoard(huntId, [meta]);
      assert.deepEqual((await cardFor(meta)).position, cardSlot(0));

      const feeder = await newPuzzle("Late round feeder", [round]);
      await syncPuzzlesOnBoard(huntId, [feeder]);
      assert.deepEqual((await cardFor(feeder)).position, cardSlot(4));

      // Another meta joins the first
      const second = await newPuzzle("Second meta", [round, metaFor]);
      await syncPuzzlesOnBoard(huntId, [second]);
      assert.deepEqual((await cardFor(second)).position, cardSlot(1));
      const frame = await frameFor(round);
      assert.equal((await cardFor(second)).parent, frame._id);
    });
  });

  describe("deleted and replaced puzzles", () => {
    beforeEach(makeBoard);

    const cardFor = (puzzleId: string) =>
      WhiteboardNodes.findOneAsync({ board: boardId, puzzle: puzzleId });
    // A feeder with an arrow to its meta, and its card
    const feederWithArrow = async () => {
      const arrow = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      const puzzle = (await Puzzles.findOneAsync(arrow.feeder))!;
      const card = (await cardFor(puzzle._id))!;
      return { arrow, puzzle, card };
    };
    const newPuzzle = (title: string, tags: string[]) =>
      Puzzles.insertAsync({
        hunt: huntId,
        title,
        tags,
        answers: [],
        expectedAnswerCount: 1,
        createdBy: operator.user,
      });
    // As the feed does when Jolly Roger deletes a puzzle, replacing it or not
    const destroy = async (puzzleId: string, replacedBy?: string) => {
      await Puzzles.updateAsync(puzzleId, {
        $set: { deleted: true, ...(replacedBy ? { replacedBy } : {}) },
      });
      deferSyncPuzzlesOnBoard(huntId, [puzzleId]);
    };
    const undestroy = async (puzzleId: string) => {
      await Puzzles.updateAsync(puzzleId, {
        $set: { deleted: false },
        $unset: { replacedBy: 1 },
      });
      deferSyncPuzzlesOnBoard(huntId, [puzzleId]);
    };
    // A comment pinned to a node, 3 across and 4 down from its corner
    const pin = (node: string, text: string) =>
      postComment(member, boardId, { text, anchor: { node, x: 3, y: 4 } });
    const anchorOf = async (messageId: string) =>
      (await BoardComments.findOneAsync(messageId))?.comment;

    it("hands a replaced puzzle's card to its replacement, as it was", async () => {
      const { arrow, puzzle, card } = await feederWithArrow();
      await WhiteboardNodes.updateAsync(card._id, {
        $set: {
          manual: true,
          locked: true,
          lockedBy: operator.user,
          position: { x: card.position.x + 7, y: card.position.y + 9 },
        },
      });
      const before = (await node(card._id))!;
      const comment = await pin(card._id, "on the old card");

      // The replacement already has a card, with a comment and a line
      const replacement = await newPuzzle("Replacement", puzzle.tags);
      await syncPuzzlesOnBoard(huntId, [replacement]);
      const theirs = (await cardFor(replacement))!;
      const theirComment = await pin(theirs._id, "on the new card");
      // and a free pin that came off it
      const freePin = await pin(theirs._id, "off the new card");
      await BoardComments.updateAsync(freePin, {
        $set: { "comment.detachedFrom": theirs._id },
        $unset: { "comment.node": 1 },
      });
      const note = Random.id();
      const line = Random.id();
      await upsertNodes(member, boardId, [
        stickyInput(-900, -900, { _id: note }),
      ]);
      await upsertEdges(member, boardId, [
        { _id: line, source: note, target: theirs._id },
      ]);

      await destroy(puzzle._id, replacement);
      await waitForAssertion(async () => {
        const cards = await WhiteboardNodes.find({
          board: boardId,
          puzzle: replacement,
        }).fetchAsync();
        assert.deepEqual(
          cards.map((c) => c._id),
          [card._id],
        );
        const arrows = await WhiteboardEdges.find({
          board: boardId,
          auto: true,
          $or: [{ feeder: puzzle._id }, { feeder: replacement }],
        }).fetchAsync();
        assert.deepEqual(
          arrows.map((a) => [a.feeder, a.meta, a.source, a.target, a.hidden]),
          [[replacement, arrow.meta, card._id, arrow.target, undefined]],
        );
      });

      const after = (await node(card._id))!;
      for (const field of [
        "position",
        "parent",
        "width",
        "height",
        "manual",
        "locked",
        "lockedBy",
        "hidden",
      ] as const) {
        assert.deepEqual(after[field], before[field], field);
      }
      assert.isUndefined(await cardFor(puzzle._id));
      assert.isUndefined(await node(theirs._id));
      assert.equal((await anchorOf(comment))?.node, card._id);
      assert.equal((await anchorOf(theirComment))?.node, card._id);
      assert.equal((await anchorOf(freePin))?.detachedFrom, card._id);
      assert.equal((await edge(line))?.target, card._id);
    });

    it("gives a replacement placed at the same moment no card of its own", async () => {
      const { puzzle, card } = await feederWithArrow();
      const replacement = await newPuzzle("Racing replacement", puzzle.tags);
      await Promise.all([
        syncPuzzlesOnBoard(huntId, [replacement]),
        destroy(puzzle._id, replacement),
        syncPuzzlesOnBoard(huntId, [replacement]),
      ]);
      await waitForAssertion(async () => {
        const cards = await WhiteboardNodes.find({
          board: boardId,
          puzzle: replacement,
        }).fetchAsync();
        assert.deepEqual(
          cards.map((c) => [c._id, c.position, c.parent]),
          [[card._id, card.position, card.parent]],
        );
        assert.isUndefined(await cardFor(puzzle._id));
      });
    });

    it("hides a deleted puzzle's card and arrows, and brings them back where they were", async () => {
      const { arrow, puzzle, card } = await feederWithArrow();
      const comment = await pin(card._id, "on the doomed card");

      await destroy(puzzle._id);
      await waitForAssertion(async () => {
        const hidden = await node(card._id);
        assert.isTrue(hidden?.hidden);
        assert.isTrue(hidden?.hiddenWithPuzzle);
        assert.isTrue((await edge(arrow._id))?.hidden);
        const anchor = await anchorOf(comment);
        assert.isUndefined(anchor?.node);
        assert.equal(anchor?.detachedFrom, card._id);
      });
      assert.deepEqual((await node(card._id))?.position, card.position);

      // Nobody can put them back while the puzzle is deleted
      await rejects(
        upsertNodes(member, boardId, [{ _id: card._id, hidden: false }]),
        /deleted/,
      );
      await rejects(
        upsertEdges(member, boardId, [{ _id: arrow._id, hidden: false }]),
        /deleted/,
      );
      // and placing the meta leaves the arrow hidden rather than removing it
      await syncPuzzlesOnBoard(huntId, [arrow.meta!]);
      assert.isTrue((await edge(arrow._id))?.hidden);

      await undestroy(puzzle._id);
      await waitForAssertion(async () => {
        const back = (await node(card._id))!;
        assert.isUndefined(back.hidden);
        assert.isUndefined(back.hiddenWithPuzzle);
        assert.deepEqual(back.position, card.position);
        assert.equal(back.parent, card.parent);
        const shown = await edge(arrow._id);
        assert.exists(shown);
        assert.isUndefined(shown.hidden);
        assert.isUndefined(shown.hiddenWithPuzzle);
        assert.deepEqual(await anchorOf(comment), {
          node: card._id,
          x: 3,
          y: 4,
        });
      });
    });

    it("leaves a card someone took off the board off it when its puzzle comes back", async () => {
      const { arrow, puzzle, card } = await feederWithArrow();
      await deleteNodes(member, boardId, [card._id]);
      await deleteEdges(member, boardId, [arrow._id]);
      await destroy(puzzle._id);
      // As the deferred sync does, but known to have finished
      await syncPuzzlesOnBoard(huntId, [puzzle._id]);
      assert.isNotOk((await node(card._id))?.hiddenWithPuzzle);
      await undestroy(puzzle._id);
      await syncPuzzlesOnBoard(huntId, [puzzle._id]);
      const after = (await node(card._id))!;
      assert.isTrue(after.hidden);
      assert.isTrue((await edge(arrow._id))?.hidden);
    });

    it("leaves what someone put back and took off again off when its puzzle comes back", async () => {
      const { arrow, puzzle, card } = await feederWithArrow();
      await Puzzles.destroyAsync(puzzle._id);
      await syncPuzzlesOnBoard(huntId, [puzzle._id]);
      assert.isTrue((await edge(arrow._id))?.hiddenWithPuzzle);
      // Back, but before the sync that would show them again
      await Puzzles.undestroyAsync(puzzle._id);
      await upsertNodes(member, boardId, [{ _id: card._id, hidden: false }]);
      await upsertEdges(member, boardId, [{ _id: arrow._id, hidden: false }]);
      const shownArrow = await edge(arrow._id);
      assert.isUndefined(shownArrow?.hidden);
      assert.isUndefined(shownArrow?.hiddenWithPuzzle);
      await deleteNodes(member, boardId, [card._id]);
      await deleteEdges(member, boardId, [arrow._id]);
      await syncPuzzlesOnBoard(huntId, [puzzle._id]);

      for (const doc of [await node(card._id), await edge(arrow._id)]) {
        assert.isTrue(doc?.hidden);
        assert.isUndefined(doc?.hiddenWithPuzzle);
      }
    });

    it("leaves the arrows of a puzzle that's back before a sync of its delete gets to them", async () => {
      const { arrow, puzzle } = await feederWithArrow();
      await deleteEdges(member, boardId, [arrow._id]);
      const board = (await Whiteboards.findOneAsync(boardId))!;
      const tags = await Tags.find({ hunt: huntId }).fetchAsync();
      // As a sync that read the puzzle as deleted just before it came back
      await syncAutoEdges(board, [], tags, () => Promise.resolve(), [
        puzzle._id,
      ]);
      const after = await edge(arrow._id);
      assert.isTrue(after?.hidden);
      assert.isUndefined(after?.hiddenWithPuzzle);
    });

    it("keeps a deleted puzzle's arrows off through a reset that puts things back", async () => {
      const arrows = await WhiteboardEdges.find({
        board: boardId,
        auto: true,
      }).fetchAsync();
      const metas = new Map<string, typeof arrows>();
      arrows.forEach((a) =>
        metas.set(a.meta!, [...(metas.get(a.meta!) ?? []), a]),
      );
      const [meta, [byHand, withPuzzle] = []] =
        [...metas].find(([, feeding]) => feeding.length >= 2) ?? [];
      assert.exists(meta, "a meta with two feeders");
      assert.exists(byHand);
      assert.exists(withPuzzle);
      // One is taken off by hand, and a card for a live puzzle too, which
      // put-back should bring back
      await deleteEdges(member, boardId, [byHand._id]);
      const other = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
        puzzle: { $nin: [meta, byHand.feeder!, withPuzzle.feeder!] },
      }))!;
      await deleteNodes(member, boardId, [other._id]);
      await Puzzles.destroyAsync(meta);
      await syncPuzzlesOnBoard(huntId, [meta]);
      assert.isTrue((await edge(withPuzzle._id))?.hiddenWithPuzzle);

      await call("resetLayout", operator, boardId, { putBack: true });

      assert.isTrue((await edge(byHand._id))?.hidden);
      assert.isTrue((await edge(withPuzzle._id))?.hidden);
      assert.isUndefined((await node(other._id))?.hidden);
    });

    it("gives a puzzle that comes back after being replaced a card of its own", async () => {
      const { puzzle, card } = await feederWithArrow();
      const replacement = await newPuzzle("Stand-in", puzzle.tags);
      await destroy(puzzle._id, replacement);
      await waitForAssertion(async () => {
        assert.equal((await cardFor(replacement))?._id, card._id);
      });
      await undestroy(puzzle._id);
      await waitForAssertion(async () => {
        const own = await cardFor(puzzle._id);
        assert.exists(own);
        assert.notEqual(own._id, card._id);
        assert.isNotOk(own.hidden);
        assert.equal((await cardFor(replacement))?._id, card._id);
      });
    });
  });

  describe("deleting the board", () => {
    beforeEach(makeBoard);

    it("takes the board, its nodes, lines and comments with it", async () => {
      const a = Random.id();
      const b = Random.id();
      await upsertNodes(member, boardId, [
        stickyInput(0, 0, { _id: a }),
        stickyInput(300, 0, { _id: b }),
      ]);
      await upsertEdges(member, boardId, [
        { _id: Random.id(), source: a, target: b },
      ]);
      await postComment(member, boardId, {
        text: "going too",
        anchor: { node: a, x: 1, y: 1 },
      });

      await deleteBoard(boardId);

      assert.equal(await Whiteboards.find({ hunt: huntId }).countAsync(), 0);
      assert.equal(
        await WhiteboardNodes.find({ hunt: huntId }).countAsync(),
        0,
      );
      assert.equal(
        await WhiteboardEdges.find({ hunt: huntId }).countAsync(),
        0,
      );
      assert.equal(
        await BoardComments.find({ board: boardId }).countAsync(),
        0,
      );
      // The copies are the feed's to keep
      assert.isAbove(await Puzzles.find({ hunt: huntId }).countAsync(), 0);
    });

    it("takes versions and chunks with it", async () => {
      await upsertNodes(member, boardId, [stickyInput(0, 0)]);
      assert.equal(await WhiteboardVersions.find({}).countAsync(), 1);
      assert.isAbove(await WhiteboardVersionChunks.find({}).countAsync(), 0);

      await deleteBoard(boardId);

      assert.equal(await WhiteboardVersions.find({}).countAsync(), 0);
      assert.equal(await WhiteboardVersionChunks.find({}).countAsync(), 0);
    });
  });

  describe("reset and place by tags", () => {
    const anger = FixtureHunt.tags.find((t) => t.name === "group:anger")!;
    const joy = FixtureHunt.tags.find((t) => t.name === "group:joy")!;
    const angerMeta = FixtureHunt.tags.find(
      (t) => t.name === "meta-for:anger",
    )!;

    beforeEach(makeBoard);

    const frameFor = async (tagId: string) =>
      (await WhiteboardNodes.findOneAsync({ board: boardId, tag: tagId }))!;
    const cardFor = async (puzzleId: string) =>
      (await WhiteboardNodes.findOneAsync({
        board: boardId,
        puzzle: puzzleId,
      }))!;
    // A card in the anger round that isn't its meta
    const angerCard = async () => {
      const puzzle = (await Puzzles.findOneAsync({
        hunt: huntId,
        tags: { $all: [anger._id], $nin: [angerMeta._id] },
      }))!;
      return cardFor(puzzle._id);
    };
    const placeByTags = (claims: Claims, nodeIds: string[]) =>
      call("placeByTags", claims, boardId, { nodeIds });
    const reset = (claims: Claims, putBack = false) =>
      call("resetLayout", claims, boardId, { putBack });
    const versions = () =>
      WhiteboardVersions.find(
        { board: boardId },
        { sort: { createdAt: -1 } },
      ).fetchAsync();
    // Where every card and seeded frame is
    const layout = async () =>
      new Map(
        (
          await WhiteboardNodes.find({
            board: boardId,
            type: { $in: ["puzzle", "frame"] },
          }).fetchAsync()
        ).map((n) => [
          n._id,
          {
            parent: n.parent,
            position: n.position,
            width: n.width,
            height: n.height,
            manual: n.manual,
            hidden: n.hidden,
          },
        ]),
      );
    const comment = (node: string, text: string) =>
      postComment(member, boardId, { text, anchor: { node, x: 10, y: 20 } });

    it("places a dragged card back into its round and clears manual", async () => {
      const card = await angerCard();
      const joyFrame = await frameFor(joy._id);
      await upsertNodes(member, boardId, [
        { _id: card._id, parent: joyFrame._id, position: { x: 900, y: 900 } },
      ]);
      assert.isTrue((await cardFor(card.puzzle!)).manual);

      await placeByTags(member, [card._id]);

      const placed = await cardFor(card.puzzle!);
      assert.equal(placed._id, card._id);
      assert.equal(placed.parent, (await frameFor(anger._id))._id);
      assert.notOk(placed.manual);
      assert.notDeepEqual(placed.position, { x: 900, y: 900 });
      // and follows its tags from then on
      await Puzzles.updateAsync(card.puzzle!, { $set: { tags: [joy._id] } });
      await syncPuzzlesOnBoard(huntId, [card.puzzle!]);
      assert.equal((await cardFor(card.puzzle!)).parent, joyFrame._id);
    });

    it("leaves a card already in its round where it is", async () => {
      const card = await angerCard();
      const moved = { x: card.position.x + 5, y: card.position.y + 7 };
      await upsertNodes(member, boardId, [{ _id: card._id, position: moved }]);

      await placeByTags(member, [card._id]);

      const placed = await cardFor(card.puzzle!);
      assert.equal(placed.parent, card.parent);
      assert.deepEqual(placed.position, moved);
      assert.notOk(placed.manual);
    });

    it("places by tags with history off, recording nothing", async () => {
      const card = await angerCard();
      await upsertNodes(member, boardId, [
        { _id: card._id, parent: null, position: { x: 900, y: 900 } },
      ]);
      await setFlag("disable.whiteboard_versions");
      const before = await versions();

      await placeByTags(operator, [card._id]);

      const placed = await cardFor(card.puzzle!);
      assert.equal(placed.parent, (await frameFor(anger._id))._id);
      assert.notOk(placed.manual);
      assert.sameMembers(
        (await versions()).map((v) => v._id),
        before.map((v) => v._id),
      );
    });

    it("refuses place by tags for non-cards and non-editors", async () => {
      const card = await angerCard();
      await upsertNodes(member, boardId, [
        { _id: card._id, position: { x: 1, y: 1 } },
      ]);
      const sticky = await addSticky(member, { x: 0, y: 0 });
      const hidden = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
        _id: { $ne: card._id },
      }))!;
      await deleteNodes(member, boardId, [hidden._id]);

      for (const ids of [
        [card._id, sticky],
        [hidden._id],
        [Random.id()],
        [(await frameFor(anger._id))._id],
      ]) {
        await rejects(
          placeByTags(member, ids),
          /Only cards on this board can be placed by tags/,
        );
      }
      // A card on another hunt's board
      const { board: otherBoard } = await otherHuntBoard(operator, [
        "Elsewhere",
      ]);
      const foreign = (await WhiteboardNodes.findOneAsync({
        board: otherBoard,
        type: "puzzle",
      }))!;
      await WhiteboardNodes.updateAsync(foreign._id, {
        $set: { manual: true },
      });
      await rejects(
        placeByTags(operator, [foreign._id]),
        /Only cards on this board can be placed by tags/,
      );
      assert.isTrue((await node(foreign._id))?.manual);

      await rejects(
        placeByTags(
          member,
          Array.from({ length: MAX_BATCH + 1 }, () => card._id),
        ),
        /Too many/,
      );
      await rejects(placeByTags(outsider, [card._id]), /member/);
      await setPolicy(operator, "operators");
      await rejects(placeByTags(member, [card._id]), /Only operators can edit/);
      assert.isTrue((await cardFor(card.puzzle!)).manual);
    });

    it("resets cards and round frames and keeps notes, ink and lines", async () => {
      const seeded = await layout();
      const card = await angerCard();
      const angerFrame = await frameFor(anger._id);
      const joyFrame = await frameFor(joy._id);
      const note = Random.id();
      const ink = Random.id();
      const end = Random.id();
      const line = Random.id();
      const freeLine = Random.id();
      await upsertNodes(member, boardId, [
        { _id: card._id, parent: null, position: { x: 9000, y: 9000 } },
        { _id: joyFrame._id, position: { x: 7000, y: 7000 } },
        stickyInput(20, 30, {
          _id: note,
          parent: angerFrame._id,
          text: "a note",
        }),
        {
          _id: ink,
          type: "ink",
          position: { x: 8000, y: 8000 },
          width: 20,
          height: 20,
          points: [
            [0, 0, 0.5],
            [20, 20, 0.5],
          ],
          strokeWidth: "thin",
          color: "black",
          stroke: Random.id(),
        },
        { _id: end, type: "point", position: { x: 8500, y: 8500 } },
      ]);
      await upsertEdges(member, boardId, [
        { _id: line, source: note, target: card._id },
        { _id: freeLine, source: card._id, target: end },
      ]);
      const kept = await WhiteboardNodes.find({
        _id: { $in: [note, ink, end] },
      }).fetchAsync();

      await reset(member);

      // Every card and frame is back where a new board would have it
      assert.deepEqual(await layout(), seeded);
      assert.sameDeepMembers(
        await WhiteboardNodes.find({
          _id: { $in: [note, ink, end] },
        }).fetchAsync(),
        kept,
      );
      const edge = (await WhiteboardEdges.findOneAsync(line))!;
      assert.equal(edge.source, note);
      assert.equal(edge.target, card._id);
      const free = (await WhiteboardEdges.findOneAsync(freeLine))!;
      assert.equal(free.source, card._id);
      assert.equal(free.target, end);
      assert.ok((await Whiteboards.findOneAsync(boardId))?.lastRewrittenAt);
    });

    it("keeps comment anchors through a reset and opens collapsed frames", async () => {
      const card = await angerCard();
      const angerFrame = await frameFor(anger._id);
      await upsertNodes(member, boardId, [
        { _id: card._id, parent: null, position: { x: 9000, y: 9000 } },
        { _id: angerFrame._id, collapsed: true },
      ]);
      const onCard = await comment(card._id, "on the card");
      const onFrame = await comment(angerFrame._id, "on the frame");

      await reset(member);

      assert.deepEqual((await BoardComments.findOneAsync(onCard))?.comment, {
        node: card._id,
        x: 10,
        y: 20,
      });
      assert.deepEqual((await BoardComments.findOneAsync(onFrame))?.comment, {
        node: angerFrame._id,
        x: 10,
        y: 20,
      });
      // The frame gets the open layout, so it's opened for everyone
      assert.isUndefined((await frameFor(anger._id)).collapsed);
    });

    it("records a reset version first and restores from it", async () => {
      const card = await angerCard();
      await upsertNodes(member, boardId, [
        { _id: card._id, parent: null, position: { x: 9000, y: 9000 } },
      ]);
      const before = await WhiteboardNodes.find({
        board: boardId,
      }).fetchAsync();

      await reset(operator);

      const [version] = await versions();
      assert.equal(version!.kind, "reset");
      assert.deepEqual(
        version!.users.map((u) => u.user),
        [operator.user],
      );
      const payload = await decodeVersion(
        (
          await WhiteboardVersionChunks.find(
            { version: version!._id },
            { sort: { index: 1 } },
          ).fetchAsync()
        ).map((c) => c.data),
      );
      assert.sameDeepMembers(payload.nodes, before);
      assert.notOk((await cardFor(card.puzzle!)).manual);

      await restoreVersion(operator, boardId, version!._id);
      const restored = await cardFor(card.puzzle!);
      assert.deepEqual(restored.position, { x: 9000, y: 9000 });
      assert.notOk(restored.parent);
      assert.isTrue(restored.manual);
    });

    it("snapshots the first edit after a reset", async () => {
      await addSticky(member, { x: 0, y: 0 });
      assert.lengthOf(await versions(), 1);

      await reset(operator);
      assert.deepEqual(
        (await versions()).map((v) => v.kind),
        ["reset", "edits"],
      );

      // Inside the member's window, but the board has been rewritten since
      await addSticky(member, { x: 0, y: 0 });
      assert.deepEqual(
        (await versions()).map((v) => v.kind),
        ["edits", "reset", "edits"],
      );
    });

    it("unhides feeder arrows only when putting back", async () => {
      const arrow = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      const card = await angerCard();
      await deleteEdges(member, boardId, [arrow._id]);
      await deleteNodes(member, boardId, [card._id]);
      const hiddenAt = (await cardFor(card.puzzle!)).position;

      await reset(member);
      assert.isTrue((await edge(arrow._id))?.hidden);
      const stillHidden = await cardFor(card.puzzle!);
      assert.isTrue(stillHidden.hidden);
      assert.deepEqual(stillHidden.position, hiddenAt);

      await reset(member, true);
      assert.notOk((await edge(arrow._id))?.hidden);
      const back = await cardFor(card.puzzle!);
      assert.notOk(back.hidden);
      assert.equal(back.parent, (await frameFor(anger._id))._id);
    });

    it("survives a card inserted by hand during a reset", async () => {
      const puzzleId = await Puzzles.insertAsync({
        hunt: huntId,
        title: "Not on the board yet",
        tags: [anger._id],
        answers: [],
        expectedAnswerCount: 1,
        createdBy: operator.user,
      });
      assert.notOk(await cardFor(puzzleId));
      const insert = WhiteboardNodes.insertAsync.bind(WhiteboardNodes);
      let byHand: string | undefined;
      const stub = spyOn(WhiteboardNodes, "insertAsync").mockImplementation(
        async (doc) => {
          if (doc.puzzle === puzzleId && !byHand) {
            byHand = await insert({
              hunt: huntId,
              board: boardId,
              type: "puzzle",
              puzzle: puzzleId,
              position: { x: 9000, y: 9000 },
              createdBy: member.user,
            });
          }
          return insert(doc);
        },
      );
      try {
        await reset(operator);
      } finally {
        stub.mockRestore();
      }

      const cards = await WhiteboardNodes.find({
        board: boardId,
        puzzle: puzzleId,
      }).fetchAsync();
      assert.lengthOf(cards, 1);
      assert.equal(cards[0]!._id, byHand);
      assert.equal(cards[0]!.parent, (await frameFor(anger._id))._id);
    });

    it("checks access and history again once it has the board's lock", async () => {
      const card = await angerCard();
      await upsertNodes(member, boardId, [
        { _id: card._id, position: { x: 1, y: 1 } },
      ]);
      const before = await versions();

      // Holds the board's lock, lets a reset by claims queue for it, makes
      // change, then lets the reset have the lock.
      const lockName = `whiteboard:${boardId}`;
      const resetWhileLocked = async (
        claims: Claims,
        change: () => Promise<unknown>,
      ) => {
        const held = await Locks.insertAsync({ name: lockName });
        const insertLock = Locks.insertAsync.bind(Locks);
        let queued!: () => void;
        const waiting = new Promise<void>((resolve) => {
          queued = resolve;
        });
        const stub = spyOn(Locks, "insertAsync").mockImplementation(
          (...args: Parameters<typeof insertLock>) => {
            if (args[0].name === lockName) queued();
            return insertLock(...args);
          },
        );
        try {
          const result = reset(claims);
          await Promise.race([waiting, result]);
          await change();
          await Locks.removeAsync(held);
          await result;
        } finally {
          stub.mockRestore();
          await Locks.removeAsync(held);
        }
      };

      await rejects(
        resetWhileLocked(member, () => setPolicy(operator, "operators")),
        /Only operators can edit/,
      );
      await rejects(
        resetWhileLocked(operator, () =>
          setFlag("disable.whiteboard_versions"),
        ),
        /Reset layout needs board history, which is turned off/,
      );

      assert.isTrue((await cardFor(card.puzzle!)).manual);
      assert.sameMembers(
        (await versions()).map((v) => v._id),
        before.map((v) => v._id),
      );
    });

    it("refuses reset with history off, for non-editors and on an archived hunt", async () => {
      const card = await angerCard();
      await upsertNodes(member, boardId, [
        { _id: card._id, position: { x: 1, y: 1 } },
      ]);
      const before = await versions();

      await rejects(reset(outsider), /member/);
      await rejects(reset(archived(operator)), /archived/);
      await setPolicy(operator, "operators");
      await rejects(reset(member), /Only operators can edit/);
      await setFlag("disable.whiteboard_versions");
      await rejects(
        reset(operator),
        /Reset layout needs board history, which is turned off/,
      );

      assert.isTrue((await cardFor(card.puzzle!)).manual);
      assert.sameMembers(
        (await versions()).map((v) => v._id),
        before.map((v) => v._id),
      );
    });
  });
});
