import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import type { ServerMessage } from "lib/protocol";
import {
  BIG_READS_PER_MINUTE,
  MAX_SOCKETS_PER_USER_PER_BOARD,
} from "lib/whiteboard/limits";
import type { Service } from "../../server/app";
import {
  closeRooms,
  ROOM_GRACE_MS,
  roomCount,
  roomFor,
  setRoomGrace,
  snapshot,
} from "../../server/rooms";
import { ensureBoard } from "../../server/whiteboard";
import { takeBigRead } from "../../server/whiteboardVersions";
import { zigzag } from "./fixtures";
import {
  claimsFor,
  fakeNow,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setUpDatabase,
  spyOnMethod,
  tearDownDatabase,
  waitForAssertion,
} from "./harness";
import { startTestService, TestClient, tokenOf } from "./service";

describe("rooms", () => {
  let service: Service;
  let operator: Claims;
  let member: Claims;
  let boardId: string;
  const clients: TestClient[] = [];
  const defaultGrace = ROOM_GRACE_MS;

  beforeAll(async () => {
    await setUpDatabase();
    service = startTestService();
    setRoomGrace(200);
  });
  afterAll(async () => {
    setRoomGrace(defaultGrace);
    await service.stop();
    await tearDownDatabase();
  });

  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await closeRooms(() => {});
    await resetDatabase();
    operator = makeUser(true);
    member = makeUser();
    await makeFixtureHunt(operator.user);
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
  });

  const textNode = () => ({
    _id: Random.id(),
    type: "text" as const,
    position: { x: 10, y: 20 },
    text: "late",
  });
  const changeTo = (id: string) => (m: ServerMessage) =>
    m.t === "change" && m.id === id;

  const join = async (claims: Claims, hideInk?: boolean) => {
    const client = await TestClient.connect(service.url);
    clients.push(client);
    const welcome = await client.hello(tokenOf(claims), hideInk);
    return { client, welcome };
  };

  it("is created on the first join and shared by the next", async () => {
    assert.equal(roomCount(), 0);
    const finds = spyOnMethod(Whiteboards, "findOneAsync");
    try {
      await join(member);
      assert.equal(roomCount(), 1);
      const room = await roomFor(boardId);
      assert.equal(room?.seats.size, 1);
      const loads = finds.mock.calls.filter(
        (args) => args[0] === boardId,
      ).length;
      await join(operator);
      assert.equal(roomCount(), 1);
      assert.equal(room?.seats.size, 2);
      assert.equal(
        finds.mock.calls.filter((args) => args[0] === boardId).length,
        loads,
      );
    } finally {
      finds.mockRestore();
    }
  });

  it("is dropped a grace after the last leave, and reloaded on the next join", async () => {
    const a = await join(member);
    const b = await join(operator);
    const room = await roomFor(boardId);
    await a.client.close();
    await waitForAssertion(() => assert.equal(room?.seats.size, 1));
    await b.client.close();
    await waitForAssertion(() => assert.equal(room?.seats.size, 0));
    assert.equal(roomCount(), 1);
    await Bun.sleep(300);
    assert.equal(roomCount(), 0);

    const c = await join(member);
    assert.equal(roomCount(), 1);
    assert.notEqual(await roomFor(boardId), room);
    assert.equal(c.welcome.board, boardId);
  });

  it("stays if someone comes back within the grace", async () => {
    const a = await join(member);
    const room = await roomFor(boardId);
    await a.client.close();
    await waitForAssertion(() => assert.equal(room?.seats.size, 0));
    await join(member);
    await Bun.sleep(300);
    assert.equal(roomCount(), 1);
    assert.equal(await roomFor(boardId), room);
  });

  it("keeps a room per board", async () => {
    const puzzle = Random.id();
    await ensureBoard({ hunt: huntId, puzzle });
    await join(member);
    await join(claimsFor(member.user, { puzzle }));
    assert.equal(roomCount(), 2);
  });

  it("sends what changed while the snapshot was read, after the welcome", async () => {
    const writer = await join(operator);
    // Hold the new member's snapshot at the versions read until the writer
    // has put a node on the board
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finds = spyOnMethod(WhiteboardVersions, "find");
    const original = finds.getMockImplementation() as (...args: unknown[]) => {
      fetchAsync: () => Promise<unknown[]>;
    };
    let delayed = false;
    finds.mockImplementation((...args: unknown[]) => {
      const cursor = original.apply(WhiteboardVersions, args);
      if (delayed) return cursor;
      delayed = true;
      return Object.create(cursor, {
        fetchAsync: {
          value: async () => {
            await held;
            return cursor.fetchAsync();
          },
        },
      });
    });
    const node = textNode();
    try {
      const late = await TestClient.connect(service.url);
      clients.push(late);
      late.send({ t: "hello", token: tokenOf(member) });
      await waitForAssertion(async () =>
        assert.equal((await roomFor(boardId))?.seats.size, 2),
      );
      await writer.client.call("upsertNodes", { nodes: [node] });
      await writer.client.next(changeTo(node._id));
      release();
      const welcome = await late.nextOf("welcome");
      assert.deepEqual(late.received, []);
      const change = await late.next(changeTo(node._id));
      assert.equal((change as { doc: { text: string } }).doc.text, "late");
      assert.equal(welcome.board, boardId);
    } finally {
      release();
      finds.mockRestore();
    }
  });

  describe("limits", () => {
    it("charges each snapshot to the person's big reads", async () => {
      const ink = zigzag(5);
      await WhiteboardNodes.insertAsync({
        ...ink,
        hunt: huntId,
        board: boardId,
        createdBy: member.user,
      });
      const clock = fakeNow();
      try {
        // Everything but one, which the snapshot takes
        for (let i = 0; i < BIG_READS_PER_MINUTE - 1; i++) {
          takeBigRead(member.user);
        }
        const { client } = await join(member);
        const refused = await TestClient.connect(service.url);
        clients.push(refused);
        refused.send({ t: "hello", token: tokenOf(member) });
        const closed = await refused.closed;
        assert.equal(closed.code, 4429);
        assert.match(closed.reason, /try again in a minute/);
        // Someone else isn't held back
        await join(operator);
        // A renewal that hides the ink wants the snapshot again: the token
        // is renewed without it, and the ink stays shown
        client.send({ t: "hello", token: tokenOf(member), hideInk: true });
        const renewed = await client.nextOf("welcome");
        assert.notProperty(renewed, "snapshot");
        const error = await client.nextOf("error");
        assert.equal(error.code, 429);
        assert.isNull(error.id);
        clock.tick(1000);
        client.send({ t: "hello", token: tokenOf(member), hideInk: true });
        const hidden = await client.nextOf("welcome");
        const nodes = hidden.snapshot?.nodes as {
          _id: string;
          points?: unknown[];
        }[];
        assert.isUndefined(nodes.find((n) => n._id === ink._id)?.points);
      } finally {
        clock.restore();
      }
    });

    it("seats a person on a board a bounded number of times", async () => {
      const seated: TestClient[] = [];
      for (let i = 0; i < MAX_SOCKETS_PER_USER_PER_BOARD; i++) {
        seated.push((await join(member)).client);
      }
      const extra = await TestClient.connect(service.url);
      clients.push(extra);
      extra.send({ t: "hello", token: tokenOf(member) });
      const closed = await extra.closed;
      assert.equal(closed.code, 4429);
      assert.match(closed.reason, /Too many connections/);
      // Someone else's seats aren't counted
      await join(operator);
      // A seat given up is a seat again
      await seated[0]?.close();
      await waitForAssertion(async () =>
        assert.equal(
          (await roomFor(boardId))?.seats.size,
          MAX_SOCKETS_PER_USER_PER_BOARD,
        ),
      );
      await join(member);
    });
  });

  describe("snapshot", () => {
    it("carries the board and what's on it", async () => {
      const board = (await Whiteboards.findOneAsync(boardId))!;
      const snap = await snapshot(board, member);
      assert.equal((snap.board as { _id: string })._id, boardId);
      assert.isAbove(snap.nodes.length, 0);
      assert.isAbove(snap.puzzles?.length ?? 0, 0);
      assert.isAbove(snap.tags?.length ?? 0, 0);
      assert.deepEqual(snap.versions, []);
      assert.deepEqual(snap.comments, []);
    });

    it("refuses another hunt's claims", async () => {
      const board = (await Whiteboards.findOneAsync(boardId))!;
      await rejects(
        snapshot(board, claimsFor(member.user, { hunt: Random.id() })),
        /Not a member/,
      );
    });
  });
});
