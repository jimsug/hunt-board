import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import BoardComments from "lib/models/BoardComments";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import type { WhiteboardNodeInput } from "lib/protocol";
import {
  LIVE_UPDATE_BURST,
  LIVE_UPDATES_PER_SECOND,
  LIVE_USER_UPDATE_BURST,
  MAX_COORDINATE,
  MAX_LIVE_SELECTION,
  MAX_WHITEBOARD_EDITORS,
} from "lib/whiteboard/limits";
import { MAX_ZOOM, MIN_ZOOM } from "lib/whiteboard/links";
import { postComment } from "../../server/comments";
import type { RoomLive } from "../../server/live";
import {
  applyLive,
  clearLiveEditsOfNonEditors,
  createRoomLive,
  joinLive,
  leaveLive,
  presenceOf,
  setLiveClaims,
} from "../../server/live";
import { parseArgs } from "../../server/methods";
import { ensureBoard } from "../../server/whiteboard";
import {
  deleteEdges,
  deleteNodes,
  upsertEdges,
  upsertNodes,
} from "../../server/whiteboardEdits";
import { otherHuntBoard } from "./fixtures";
import {
  archived,
  call,
  claimsFor,
  defaultRoleOperator,
  fakeNow,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setFlag,
  setUpDatabase,
  spyOnMethod,
  tearDownDatabase,
} from "./harness";

describe("whiteboard live", () => {
  // A live update with just a cursor
  const state = {
    cursor: { x: 1, y: 2 },
    drag: null,
    stroke: null,
  };

  let operator: Claims;
  let member: Claims;
  let outsider: Claims;
  let boardId: string;
  let room: RoomLive;

  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  beforeEach(async () => {
    await resetDatabase();
    operator = makeUser(true);
    member = makeUser();
    outsider = { ...makeUser(), scope: { hunt: Random.id() } };
    await makeFixtureHunt(operator.user);
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
    room = createRoomLive((await Whiteboards.findOneAsync(boardId))!);
  });

  // The room's board as it's stored now, as the room layer keeps it
  const refreshRoom = async () => {
    room.board = (await Whiteboards.findOneAsync(boardId))!;
  };
  // A new connection on the board, by id
  const join = (claims: Claims, into = room) => {
    const id = Random.id();
    joinLive(into, id, claims);
    return id;
  };
  const setLive = (
    claims: Claims,
    connection: string,
    live: Parameters<typeof applyLive>[3],
    into = room,
  ) => applyLive(into, connection, claims, live);
  const presence = (connection: string, from = room) =>
    from.connections.get(connection)?.presence;
  const node = (id: string) => WhiteboardNodes.findOneAsync(id);
  const edge = (id: string) => WhiteboardEdges.findOneAsync(id);
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
  const setPolicy = async (
    claims: Claims,
    editPolicy: "members" | "operators" | "operatorsAndEditors",
    editors: string[] = [],
  ) => {
    await call("setEditPolicy", claims, boardId, { editPolicy, editors });
    await refreshRoom();
  };

  describe("live", () => {
    it("keeps one presence per connection and drops it when it leaves", async () => {
      const connection = join(member);
      await setLive(member, connection, state);
      await setLive(member, connection, { ...state, cursor: { x: 3, y: 4 } });
      const docs = presenceOf(room).filter((p) => p.connection === connection);
      assert.lengthOf(docs, 1);
      assert.deepEqual(docs[0]!.cursor, { x: 3, y: 4 });
      assert.equal(docs[0]!.user, member.user);
      assert.equal(docs[0]!.name, member.name);

      leaveLive(room, connection);
      assert.isUndefined(presence(connection));
      assert.lengthOf(presenceOf(room), 0);
    });

    it("drops an update that lands after its connection has left", async () => {
      const leaving = join(member);
      const ids = (
        await WhiteboardNodes.find(
          { board: boardId },
          { limit: 1, projection: { _id: 1 } },
        ).fetchAsync()
      ).map((n) => n._id);
      // The connection leaves while its update is looking up its selection
      const find = WhiteboardNodes.find.bind(WhiteboardNodes);
      const stub = spyOnMethod(WhiteboardNodes, "find").mockImplementation(
        (...args: Parameters<typeof find>) => {
          leaveLive(room, leaving);
          return find(...args);
        },
      );
      try {
        assert.isUndefined(
          await setLive(member, leaving, { ...state, selection: ids }),
        );
      } finally {
        stub.mockRestore();
      }
      assert.lengthOf(presenceOf(room), 0);

      // Later updates from a connection that's still on the board go through
      const back = join(member);
      assert.ok(await setLive(member, back, state));
      assert.lengthOf(presenceOf(room), 1);
    });

    it("drops updates past a connection's rate limit, without an error, and takes them again a second later", async () => {
      const clock = fakeNow();
      try {
        const connection = join(member);
        const cursorAt = () => presence(connection)?.cursor;
        for (let i = 1; i <= LIVE_UPDATE_BURST; i++) {
          await setLive(member, connection, {
            ...state,
            cursor: { x: i, y: 0 },
          });
        }
        assert.deepEqual(cursorAt(), { x: LIVE_UPDATE_BURST, y: 0 });
        assert.isUndefined(
          await setLive(member, connection, {
            ...state,
            cursor: { x: -1, y: 0 },
          }),
        );
        assert.deepEqual(cursorAt(), { x: LIVE_UPDATE_BURST, y: 0 });

        // Another connection has a bucket of its own
        const other = join(member);
        assert.ok(await setLive(member, other, state));

        clock.tick(1000);
        for (let i = 1; i <= LIVE_UPDATES_PER_SECOND; i++) {
          await setLive(member, connection, {
            ...state,
            cursor: { x: 1000 + i, y: 0 },
          });
        }
        assert.deepEqual(cursorAt(), {
          x: 1000 + LIVE_UPDATES_PER_SECOND,
          y: 0,
        });
        await setLive(member, connection, {
          ...state,
          cursor: { x: -1, y: 0 },
        });
        assert.deepEqual(cursorAt(), {
          x: 1000 + LIVE_UPDATES_PER_SECOND,
          y: 0,
        });
      } finally {
        clock.restore();
      }
    });

    it("holds back a person's updates across all their connections", async () => {
      const clock = fakeNow();
      try {
        const connections = Array.from(
          { length: LIVE_USER_UPDATE_BURST / LIVE_UPDATE_BURST + 1 },
          () => join(member),
        );
        const [last, ...rest] = connections.toReversed();
        for (const c of rest) {
          for (let i = 0; i < LIVE_UPDATE_BURST; i++) {
            await setLive(member, c, state);
          }
          assert.ok(presence(c)?.cursor);
        }
        // The person's bucket is empty, though this connection's isn't
        assert.isUndefined(await setLive(member, last!, state));
        assert.isNull(presence(last!)?.cursor);
        // Someone else's isn't
        const theirs = join(operator);
        assert.ok(await setLive(operator, theirs, state));
        connections.forEach((c) => leaveLive(room, c));
      } finally {
        clock.restore();
      }
    });

    it("keeps nothing for a connection that isn't on the board, or a caller who can't see it", async () => {
      await rejects(setLive(member, Random.id(), state), /Not on this board/);
      const connection = join(outsider);
      await rejects(setLive(outsider, connection, state), /member/);
      assert.isNull(presence(connection)?.cursor);
      // The schema refuses a malformed update before it gets this far
      assert.throws(
        () => parseArgs("live", { ...state, cursor: { x: "1", y: 2 } }),
        /Match error/,
      );
    });

    it("only shows the cursor of an update whose access changed while it was under way", async () => {
      const connection = join(member);
      const ids = (
        await WhiteboardNodes.find(
          { board: boardId },
          { limit: 2, projection: { _id: 1 } },
        ).fetchAsync()
      ).map((n) => n._id);
      await setLive(member, connection, state);
      // As the room does on a change to the edit policy, just as the update
      // looks up its selection
      const find = WhiteboardNodes.find.bind(WhiteboardNodes);
      const stub = spyOnMethod(WhiteboardNodes, "find").mockImplementation(
        (...args: Parameters<typeof find>) => {
          room.board = { ...room.board, editPolicy: "operators" };
          return find(...args);
        },
      );
      try {
        await setLive(member, connection, {
          ...state,
          cursor: { x: 7, y: 8 },
          selection: ids,
          editing: ids[0],
        });
      } finally {
        stub.mockRestore();
      }
      const doc = presence(connection);
      assert.deepEqual(doc?.cursor, { x: 7, y: 8 });
      assert.isNull(doc?.selection);
      assert.isNull(doc?.editing);
    });

    it("keeps an update's selection when a change under way didn't touch its access", async () => {
      const connection = join(member);
      const ids = (
        await WhiteboardNodes.find(
          { board: boardId },
          { limit: 2, projection: { _id: 1 } },
        ).fetchAsync()
      ).map((n) => n._id);
      await setLive(member, connection, state);
      const find = WhiteboardNodes.find.bind(WhiteboardNodes);
      const stub = spyOnMethod(WhiteboardNodes, "find").mockImplementation(
        (...args: Parameters<typeof find>) => {
          room.board = { ...room.board, editors: [Random.id()] };
          return find(...args);
        },
      );
      try {
        await setLive(member, connection, {
          ...state,
          cursor: { x: 7, y: 8 },
          selection: ids,
        });
      } finally {
        stub.mockRestore();
      }
      const doc = presence(connection);
      assert.deepEqual(doc?.cursor, { x: 7, y: 8 });
      assert.deepEqual(doc?.selection, ids);
    });

    it("lists everyone on the board, and forgets you when you leave", async () => {
      const mine = join(member);
      const theirs = join(operator);
      await setLive(member, mine, state);
      await setLive(operator, theirs, state);

      assert.sameMembers(
        presenceOf(room).map((p) => p.user),
        [member.user, operator.user],
      );
      leaveLive(room, mine);
      assert.deepEqual(
        presenceOf(room).map((p) => p.user),
        [operator.user],
      );
      leaveLive(room, theirs);
      assert.lengthOf(presenceOf(room), 0);
    });

    it("does nothing while live updates are switched off", async () => {
      await setFlag("disable.whiteboard_live");
      const connection = join(member);
      assert.isUndefined(await setLive(member, connection, state));
      assert.isNull(presence(connection)?.cursor);
    });

    it("rejects people outside the hunt", async () => {
      await rejects(setLive(outsider, join(outsider), state), /member/);
    });

    it("rejects out-of-range positions and foreign nodes", async () => {
      const connection = join(member);
      await rejects(
        setLive(member, connection, {
          ...state,
          cursor: { x: Number.POSITIVE_INFINITY, y: 0 },
        }),
        /Invalid live update/,
      );
      await rejects(
        setLive(member, connection, {
          ...state,
          drag: [{ node: Random.id(), x: 0, y: 0 }],
        }),
        /on this board/,
      );
      await rejects(
        setLive(member, connection, {
          ...state,
          stroke: {
            color: "black",
            strokeWidth: "thin",
            points: Array.from(
              { length: 501 },
              (_, i) => [i, 0, 0.5] as [number, number, number],
            ),
          },
        }),
        /Invalid live update/,
      );
    });

    it("keeps the frame a drag is measured in", async () => {
      const connection = join(member);
      const card = (
        await WhiteboardNodes.find({
          board: boardId,
          type: "puzzle",
        }).fetchAsync()
      ).find((n) => n.parent)!;
      await setLive(member, connection, {
        ...state,
        drag: [{ node: card._id, x: 5, y: 6, parent: card.parent }],
      });
      assert.deepEqual(presence(connection)?.drag, [
        { node: card._id, x: 5, y: 6, parent: card.parent },
      ]);
      await rejects(
        setLive(member, connection, {
          ...state,
          drag: [{ node: card._id, x: 5, y: 6, parent: "not an id!" }],
        }),
      );
    });

    describe("view and following", () => {
      it("keeps a view on the board at a zoom it allows, and shows it with who's followed", async () => {
        const mine = join(member);
        const theirs = join(operator);
        const view = { x: -250.5, y: 1200, zoom: 0.75 };
        await setLive(operator, theirs, state);
        await setLive(member, mine, {
          ...state,
          view,
          followedUser: operator.user,
        });
        await setLive(operator, theirs, {
          ...state,
          view: { x: 0, y: 0, zoom: MAX_ZOOM },
        });

        const doc = presence(mine);
        assert.deepEqual(doc?.view, view);
        assert.equal(doc?.followedUser, operator.user);

        // What the operator sees of the member, and the member of the
        // operator
        const seen = presenceOf(room);
        const memberDoc = seen.find((p) => p.user === member.user);
        assert.deepEqual(memberDoc?.view, view);
        assert.equal(memberDoc?.followedUser, operator.user);
        const theirDoc = seen.find((p) => p.user === operator.user);
        assert.deepEqual(theirDoc?.view, { x: 0, y: 0, zoom: MAX_ZOOM });
        assert.isNull(theirDoc?.followedUser);
      });

      it("refuses a view off the board or at a zoom the board doesn't allow", async () => {
        const connection = join(member);
        for (const view of [
          { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 },
          { x: 0, y: MAX_COORDINATE + 1, zoom: 1 },
          { x: 0, y: 0, zoom: MIN_ZOOM / 2 },
          { x: 0, y: 0, zoom: MAX_ZOOM + 0.5 },
          { x: 0, y: 0, zoom: Number.NaN },
        ]) {
          await rejects(
            setLive(member, connection, { ...state, view }),
            /Invalid live update/,
          );
        }
        assert.throws(
          () => parseArgs("live", { ...state, view: { x: 0, y: 0 } }),
          /Match error/,
        );
        // The ends of the range will do
        await setLive(member, connection, {
          ...state,
          view: { x: MAX_COORDINATE, y: -MAX_COORDINATE, zoom: MIN_ZOOM },
        });
        assert.ok(presence(connection)?.view);
      });

      it("only follows someone on the board", async () => {
        const connection = join(member);
        await rejects(
          setLive(member, connection, {
            ...state,
            followedUser: "not an id!",
          }),
          /Invalid live update/,
        );
        // A member of the hunt, but not on the board
        await rejects(
          setLive(member, connection, {
            ...state,
            followedUser: operator.user,
          }),
          /must be on this board/,
        );
        // On another hunt's board
        const other = await otherHuntBoard(operator);
        const elsewhere = createRoomLive(
          (await Whiteboards.findOneAsync(other.board))!,
        );
        await setLive(
          other.claims,
          join(other.claims, elsewhere),
          state,
          elsewhere,
        );
        await rejects(
          setLive(member, connection, {
            ...state,
            followedUser: operator.user,
          }),
          /must be on this board/,
        );
        await setLive(operator, join(operator), state);
        await setLive(member, connection, {
          ...state,
          followedUser: operator.user,
        });
        assert.equal(presence(connection)?.followedUser, operator.user);
      });
    });

    describe("selection and editing", () => {
      const nodeIds = async (count: number) =>
        (
          await WhiteboardNodes.find(
            { board: boardId },
            { limit: count, projection: { _id: 1 } },
          ).fetchAsync()
        ).map((n) => n._id);
      // Enough notes for a selection of `count` nodes on this board
      const boardNodes = async (count: number) => {
        const have = await WhiteboardNodes.find({
          board: boardId,
        }).countAsync();
        if (have < count) {
          const notes = Array.from({ length: count - have }, (_, i) =>
            stickyInput(i * 10, 0),
          );
          for (let i = 0; i < notes.length; i += 100) {
            await upsertNodes(member, boardId, notes.slice(i, i + 100));
          }
        }
        return nodeIds(count);
      };

      it("keeps a selection of up to 50 of the board's nodes, and what's being typed in", async () => {
        const connection = join(member);
        const ids = await boardNodes(MAX_LIVE_SELECTION);
        await setLive(member, connection, {
          ...state,
          selection: ids,
          editing: ids[0],
        });
        const doc = presence(connection);
        assert.deepEqual(doc?.selection, ids);
        assert.equal(doc?.editing, ids[0]);

        // A line's label is typed in too
        const line = Random.id();
        await upsertEdges(member, boardId, [
          { _id: line, source: ids[0]!, target: ids[1]! },
        ]);
        await setLive(member, connection, {
          ...state,
          selection: null,
          editing: line,
        });
        const after = presence(connection);
        assert.isNull(after?.selection);
        assert.equal(after?.editing, line);

        // An update from a client that doesn't send them clears them
        await setLive(member, connection, state);
        const cleared = presence(connection);
        assert.isNull(cleared?.selection);
        assert.isNull(cleared?.editing);
      });

      it("refuses too big a selection, bad ids and things not on the board", async () => {
        const connection = join(member);
        const ids = await boardNodes(MAX_LIVE_SELECTION + 1);
        await rejects(
          setLive(member, connection, { ...state, selection: ids }),
          /Invalid live update/,
        );
        await rejects(
          setLive(member, connection, {
            ...state,
            selection: [ids[0]!, Random.id()],
          }),
          /Selected nodes must be on this board/,
        );
        await rejects(
          setLive(member, connection, {
            ...state,
            selection: ["not an id!"],
          }),
          /Invalid live update/,
        );
        await rejects(
          setLive(member, connection, { ...state, editing: Random.id() }),
          /Edited items must be on this board/,
        );
        await rejects(
          setLive(member, connection, { ...state, editing: "not an id!" }),
          /Invalid live update/,
        );
        await rejects(
          setLive(member, connection, { ...state, editing: "" }),
          /Invalid live update/,
        );
        // A node on another board is as good as none
        const { board: otherBoard, claims } = await otherHuntBoard(operator);
        const elsewhere = Random.id();
        await upsertNodes(claims, otherBoard, [
          stickyInput(0, 0, { _id: elsewhere }),
        ]);
        await rejects(
          setLive(member, connection, { ...state, selection: [elsewhere] }),
          /on this board/,
        );
        await rejects(
          setLive(member, connection, { ...state, editing: elsewhere }),
          /on this board/,
        );
        assert.isNull(presence(connection)?.cursor);
      });

      it("doesn't write an update over a newer one that overtook it", async () => {
        const connection = join(member);
        const ids = await boardNodes(1);
        await setLive(member, connection, state);
        // The first looks up its selection; the second, sent after it,
        // has nothing to look up and is written first.
        await Promise.all([
          setLive(member, connection, {
            ...state,
            selection: ids,
            editing: ids[0],
          }),
          setLive(member, connection, { ...state, cursor: { x: 5, y: 6 } }),
        ]);
        const doc = presence(connection);
        assert.deepEqual(doc?.cursor, { x: 5, y: 6 });
        assert.isNull(doc?.selection);
        assert.isNull(doc?.editing);
      });

      it("keeps when someone typing last said so, only while they're typing", async () => {
        const connection = join(member);
        const [id] = await boardNodes(1);
        const at = new Date(Date.now() - 5000);
        await setLive(member, connection, {
          ...state,
          editing: id,
          editingAt: at,
        });
        assert.deepEqual(presence(connection)?.editingAt, at);

        // Nothing being typed in has no time
        await setLive(member, connection, {
          ...state,
          editing: null,
          editingAt: at,
        });
        assert.isNull(presence(connection)?.editingAt);
        // nor does a client that doesn't send one
        await setLive(member, connection, { ...state, editing: id });
        assert.isNull(presence(connection)?.editingAt);

        await rejects(
          setLive(member, connection, {
            ...state,
            editing: id,
            editingAt: new Date(Number.NaN),
          }),
          /Invalid live update/,
        );
        assert.throws(
          () => parseArgs("live", { ...state, editing: id, editingAt: "now" }),
          /Match/,
        );
      });

      it("shows others what someone has selected and is typing in", async () => {
        const theirs = join(operator);
        const ids = await boardNodes(2);
        const editingAt = new Date();
        await setLive(operator, theirs, {
          ...state,
          selection: ids,
          editing: ids[1],
          editingAt,
        });
        const published = presenceOf(room);
        assert.lengthOf(published, 1);
        assert.deepEqual(published[0]!.selection, ids);
        assert.equal(published[0]!.editing, ids[1]);
        assert.deepEqual(published[0]!.editingAt, editingAt);
      });
    });
  });

  describe("edit policy", () => {
    const editors = async () =>
      (await Whiteboards.findOneAsync(boardId))?.editors;
    const card = async () =>
      (await WhiteboardNodes.findOneAsync({ board: boardId, type: "puzzle" }))!;
    // A cursor, a drag, a stroke, a selection and text being typed in all
    // at once
    const busy = async () => {
      const node = await card();
      return {
        cursor: { x: 1, y: 2 },
        drag: [{ node: node._id, x: 5, y: 6, parent: node.parent ?? null }],
        stroke: {
          color: "black" as const,
          strokeWidth: "thin" as const,
          points: [[0, 0, 0.5] as [number, number, number]],
        },
        selection: [node._id],
        editing: node._id,
        editingAt: new Date(),
      };
    };
    // Someone who can't edit: their cursor shows, and none of their live edits
    const assertNoLiveEdits = (
      doc: ReturnType<typeof presence>,
      cursor: { x: number; y: number },
    ) => {
      assert.deepEqual(doc?.cursor, cursor);
      assert.isNull(doc?.drag);
      assert.isNull(doc?.stroke);
      assert.isNull(doc?.selection);
      assert.isNull(doc?.editing);
      assert.isNull(doc?.editingAt);
    };
    // Someone who can: everything they sent is kept
    const assertLiveEdits = (
      doc: ReturnType<typeof presence>,
      live: Awaited<ReturnType<typeof busy>>,
    ) => {
      assert.deepEqual(doc?.drag, live.drag);
      assert.deepEqual(doc?.stroke, live.stroke);
      assert.deepEqual(doc?.selection, live.selection);
      assert.equal(doc?.editing, live.editing);
      assert.deepEqual(doc?.editingAt, live.editingAt);
    };

    it("refuses node edits, deletes and edge edits from non-editors", async () => {
      const a = stickyInput(0, 0);
      const b = stickyInput(0, 0);
      const line = Random.id();
      await upsertNodes(member, boardId, [a, b]);
      await upsertEdges(member, boardId, [
        { _id: line, source: a._id, target: b._id },
      ]);
      await setPolicy(operator, "operators");

      await rejects(
        upsertNodes(member, boardId, [stickyInput(0, 0)]),
        /Only operators can edit/,
      );
      await rejects(
        deleteNodes(member, boardId, [a._id]),
        /Only operators can edit/,
      );
      await rejects(
        upsertEdges(member, boardId, [{ _id: line, label: "mine" }]),
        /Only operators can edit/,
      );
      await rejects(
        deleteEdges(member, boardId, [line]),
        /Only operators can edit/,
      );
      assert.ok(await node(a._id));
      assert.notOk((await edge(line))?.label);

      await upsertNodes(operator, boardId, [stickyInput(0, 0)]);
      await deleteEdges(operator, boardId, [line]);
    });

    it("lets listed people edit", async () => {
      const listed = makeUser();
      await setPolicy(operator, "operatorsAndEditors", [listed.user]);
      await upsertNodes(listed, boardId, [stickyInput(0, 0)]);
      await upsertNodes(operator, boardId, [stickyInput(0, 0)]);
      await rejects(
        upsertNodes(member, boardId, [stickyInput(0, 0)]),
        /people they've chosen/,
      );
    });

    it("applies a policy change to the next edit", async () => {
      await upsertNodes(member, boardId, [stickyInput(0, 0)]);
      await setPolicy(operator, "operators");
      await rejects(upsertNodes(member, boardId, [stickyInput(0, 0)]));
      await setPolicy(operator, "members");
      await upsertNodes(member, boardId, [stickyInput(0, 0)]);
    });

    it("lets anyone in the hunt comment, reply, react and resolve whatever the policy", async () => {
      await setPolicy(operator, "operators");
      const node = (await card())._id;
      const root = await postComment(member, boardId, {
        text: "on the card",
        anchor: { node, x: 1, y: 1 },
      });
      await postComment(member, boardId, { text: "a reply", parentId: root });
      await call("comment.react", member, boardId, {
        messageId: root,
        emoji: "👍",
        on: true,
      });
      assert.equal(await BoardComments.find({ thread: root }).countAsync(), 2);
      await call("comment.resolve", member, boardId, {
        messageId: root,
        resolved: true,
      });
      assert.ok((await BoardComments.findOneAsync(root))?.comment?.resolvedAt);
      await call("comment.resolve", member, boardId, {
        messageId: root,
        resolved: false,
      });
      assert.notOk(
        (await BoardComments.findOneAsync(root))?.comment?.resolvedAt,
      );
    });

    it("keeps delete to authors and operators", async () => {
      await setPolicy(operator, "operators");
      const other = makeUser();
      const comment = (claims: Claims, text: string) =>
        postComment(claims, boardId, { text, anchor: { x: 0, y: 0 } });
      const remove = (claims: Claims, messageId: string) =>
        call("comment.delete", claims, boardId, { messageId });
      const mine = await comment(member, "mine");
      const theirs = await comment(other, "theirs");

      await rejects(remove(member, theirs), /author/);
      await remove(member, mine);
      await remove(operator, theirs);
      assert.equal(
        await BoardComments.find({ board: boardId }).countAsync(),
        0,
      );
    });

    it("drops live drags, strokes, selections and editing from non-editors but keeps the cursor", async () => {
      await setPolicy(operator, "operators");
      const live = await busy();
      const theirs = join(member);
      const ours = join(operator);
      await setLive(member, theirs, live);
      await setLive(operator, ours, live);
      assertNoLiveEdits(presence(theirs), live.cursor);
      assertLiveEdits(presence(ours), live);
      // Not even checked: a drag, selection or edit of something on
      // another board is dropped rather than refused.
      await setLive(member, theirs, {
        ...live,
        drag: [{ node: Random.id(), x: 0, y: 0 }],
        selection: [Random.id()],
        editing: Random.id(),
      });
    });

    it("drops live drags on an archived hunt", async () => {
      const live = await busy();
      const connection = join(archived(operator));
      await setLive(archived(operator), connection, live);
      assertNoLiveEdits(presence(connection), live.cursor);
    });

    it("keeps the view and who's followed from someone who can comment but not edit", async () => {
      await setPolicy(operator, "operators");
      const ours = join(operator);
      const theirs = join(member);
      const view = { x: 10, y: 20, zoom: 1.5 };
      await setLive(operator, ours, state);
      await setLive(member, theirs, {
        ...(await busy()),
        view,
        followedUser: operator.user,
      });
      const doc = presence(theirs);
      assert.isNull(doc?.drag);
      assert.deepEqual(doc?.view, view);
      assert.equal(doc?.followedUser, operator.user);
    });

    it("sends no view and follows nobody on an archived hunt", async () => {
      const ours = join(operator);
      const theirs = join(archived(member));
      await setLive(operator, ours, state);
      await setLive(archived(member), theirs, {
        ...state,
        view: { x: 10, y: 20, zoom: 1 },
        followedUser: operator.user,
      });
      const doc = presence(theirs);
      assert.isNull(doc?.view);
      assert.isNull(doc?.followedUser);
    });

    it("clears the live state of people who lose edit rights", async () => {
      const live = await busy();
      const view = { x: 10, y: 20, zoom: 1 };
      const theirs = join(member);
      const ours = join(operator);
      await setLive(operator, ours, live);
      await setLive(member, theirs, {
        ...live,
        view,
        followedUser: operator.user,
      });
      assert.deepEqual(presence(theirs)?.drag, live.drag);

      await setPolicy(operator, "operators");
      // As the room does once it hears the board changed
      const changed = clearLiveEditsOfNonEditors(room);
      assert.deepEqual(
        changed.map((p) => p.connection),
        [theirs],
      );
      const doc = presence(theirs);
      assertNoLiveEdits(doc, live.cursor);
      // They can still comment, so what they look at and follow stays
      assert.deepEqual(doc?.view, view);
      assert.equal(doc?.followedUser, operator.user);
      assert.deepEqual(presence(ours)?.drag, live.drag);

      // and their next update keeps it that way
      await setLive(member, theirs, live);
      assert.isNull(presence(theirs)?.drag);
    });

    describe("setEditPolicy", () => {
      it("is for the hunt's assigned operators", async () => {
        await rejects(setPolicy(member, "operators"), /assigned operators/);
        await rejects(setPolicy(outsider, "operators"), /member/);
        // An operator by the hunt's default role edits under an
        // operators-only policy but can't set one
        const byRole = defaultRoleOperator(operator);
        await rejects(setPolicy(byRole, "operators"), /assigned operators/);
        assert.isUndefined(
          (await Whiteboards.findOneAsync(boardId))?.editPolicy,
        );

        await setPolicy(operator, "operators");
        assert.equal(
          (await Whiteboards.findOneAsync(boardId))?.editPolicy,
          "operators",
        );
        const theirs = stickyInput(1, 1);
        await upsertNodes(byRole, boardId, [theirs]);
        assert.isOk(await node(theirs._id));
        await rejects(
          upsertNodes(member, boardId, [stickyInput(2, 2)]),
          /operators/,
        );
        await setPolicy(operator, "members");
        assert.equal(
          (await Whiteboards.findOneAsync(boardId))?.editPolicy,
          "members",
        );
      });

      it("keeps the list under any tier", async () => {
        const listed = [member.user, Random.id()];
        for (const policy of [
          "members",
          "operators",
          "operatorsAndEditors",
        ] as const) {
          await setPolicy(operator, policy, listed);
          assert.deepEqual(await editors(), listed);
        }
      });

      it("caps the list", async () => {
        const tooMany = Array.from({ length: MAX_WHITEBOARD_EDITORS + 1 }, () =>
          Random.id(),
        );
        await rejects(
          setPolicy(operator, "operatorsAndEditors", tooMany),
          /Too many/,
        );
        await rejects(
          setPolicy(operator, "operatorsAndEditors", ["not an id!"]),
          /Invalid user id/,
        );
        assert.isUndefined(await editors());
      });

      it("dedupes the list", async () => {
        await setPolicy(operator, "operatorsAndEditors", [
          member.user,
          member.user,
          operator.user,
          member.user,
        ]);
        assert.deepEqual(await editors(), [member.user, operator.user]);
      });

      it("refuses on an archived hunt or with the whiteboard off", async () => {
        await rejects(setPolicy(archived(operator), "operators"), /archived/);

        await setFlag("disable.whiteboard");
        await rejects(setPolicy(operator, "operators"), /disabled/);
        assert.isUndefined(
          (await Whiteboards.findOneAsync(boardId))?.editPolicy,
        );
      });
    });

    describe("access changes", () => {
      it("applies a policy change to the next live update", async () => {
        const live = await busy();
        const connection = join(member);
        await setLive(member, connection, live);
        assert.deepEqual(presence(connection)?.drag, live.drag);
        await Whiteboards.updateAsync(boardId, {
          $set: { editPolicy: "operators" },
        });
        await refreshRoom();
        await setLive(member, connection, live);
        assert.isNull(presence(connection)?.drag);
      });

      it("takes each update's token as it comes, so a demotion applies at once", async () => {
        await setPolicy(operator, "operators");
        const live = await busy();
        const connection = join(operator);
        await setLive(operator, connection, live);
        assert.deepEqual(presence(connection)?.drag, live.drag);
        const demoted = claimsFor(operator.user);
        await setLive(demoted, connection, live);
        assert.isNull(presence(connection)?.drag);
      });

      it("clears the live edits of someone demoted, before they next move", async () => {
        await setPolicy(operator, "operators");
        const live = await busy();
        const connection = join(operator);
        await setLive(operator, connection, live);
        assert.equal(presence(connection)?.editing, live.editing);
        // As the room does when the connection's token is renewed
        const changed = setLiveClaims(
          room,
          connection,
          claimsFor(operator.user),
        );
        assert.ok(changed);
        assertNoLiveEdits(presence(connection), live.cursor);
        // and nothing changes for a token that keeps their access
        assert.isUndefined(setLiveClaims(room, connection, operator));
      });

      it("clears the view and who's followed of someone who leaves the hunt, before they next move", async () => {
        const live = await busy();
        const theirs = join(member);
        const ours = join(operator);
        await setLive(operator, ours, live);
        await setLive(member, theirs, {
          ...live,
          view: { x: 1, y: 1, zoom: 1 },
          followedUser: operator.user,
        });
        assert.equal(presence(theirs)?.followedUser, operator.user);
        setLiveClaims(room, theirs, {
          ...member,
          scope: { hunt: Random.id() },
        });
        const doc = presence(theirs);
        assert.isNull(doc?.view);
        assert.isNull(doc?.followedUser);
        assert.isNull(doc?.drag);
        assert.isNull(doc?.editing);
      });

      it("clears everyone's live edits on a hunt that's archived, before they next move", async () => {
        const live = await busy();
        const theirs = join(member);
        const ours = join(operator);
        await setLive(operator, ours, live);
        await setLive(member, theirs, {
          ...live,
          view: { x: 1, y: 1, zoom: 1 },
          followedUser: operator.user,
        });
        // Everyone's next token says so
        setLiveClaims(room, theirs, archived(member));
        setLiveClaims(room, ours, archived(operator));
        for (const connection of [theirs, ours]) {
          const doc = presence(connection);
          assertNoLiveEdits(doc, live.cursor);
          assert.isNull(doc?.view);
          assert.isNull(doc?.followedUser);
        }
      });
    });
  });
});
