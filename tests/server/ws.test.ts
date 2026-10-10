import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import type { Change } from "lib/protocol";
import type { Service } from "../../server/app";
import { closeRooms } from "../../server/rooms";
import { ensureBoard } from "../../server/whiteboard";
import { MAX_FRAME_BYTES } from "../../server/ws";
import { zigzag } from "./fixtures";
import {
  archived,
  claimsFor,
  huntId,
  makeFixtureHunt,
  makeUser,
  resetDatabase,
  setFlag,
  setUpDatabase,
  tearDownDatabase,
} from "./harness";
import {
  failure,
  startTestService,
  TestClient,
  tokenFor,
  tokenOf,
} from "./service";

describe("ws", () => {
  let service: Service;
  let operator: Claims;
  let member: Claims;
  let boardId: string;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    await setUpDatabase();
    service = startTestService({ pingIntervalMs: 200 });
  });
  afterAll(async () => {
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

  const connect = async () => {
    const client = await TestClient.connect(service.url);
    clients.push(client);
    return client;
  };
  const join = async (claims: Claims, hideInk?: boolean) => {
    const client = await connect();
    const welcome = await client.hello(tokenOf(claims), hideInk);
    return { client, welcome };
  };

  const textNode = (text = "hi") => ({
    _id: Random.id(),
    type: "text" as const,
    position: { x: 10, y: 20 },
    text,
  });

  const changeTo = (id: string) => (m: { t: string }) =>
    m.t === "change" && (m as Change).id === id;

  describe("hello", () => {
    it("closes 4401 on a bad token", async () => {
      const client = await connect();
      client.send({ t: "hello", token: "nope.nope" });
      const closed = await client.closed;
      assert.equal(closed.code, 4401);

      const expired = await connect();
      expired.send({
        t: "hello",
        token: tokenOf({ ...member, exp: Date.now() - 1000 }),
      });
      assert.equal((await expired.closed).code, 4401);
    });

    it("closes 4404 when the scope has no board", async () => {
      const client = await connect();
      client.send({
        t: "hello",
        token: tokenFor(member.user, { hunt: Random.id() }),
      });
      const closed = await client.closed;
      assert.equal(closed.code, 4404);
    });

    it("closes 4400 on anything before hello", async () => {
      const client = await connect();
      client.send({
        t: "call",
        id: 1,
        name: "upsertNodes",
        args: { nodes: [] },
      });
      assert.equal((await client.closed).code, 4400);
      const junk = await connect();
      junk.sendRaw("{not json");
      assert.equal((await junk.closed).code, 4400);
    });

    it("answers with the snapshot", async () => {
      const { welcome } = await join(member);
      assert.equal(welcome.user, member.user);
      assert.equal(welcome.name, member.name);
      assert.isTrue(welcome.mayEdit);
      assert.equal(welcome.access, "edit");
      assert.isFalse(welcome.operator);
      assert.equal(welcome.board, boardId);
      assert.match(welcome.connection, /^[A-Za-z0-9]{17}$/);
      const snapshot = welcome.snapshot as unknown as {
        board: { _id: string; createdAt: Date };
        nodes: { type: string }[];
        edges: unknown[];
        versions: unknown[];
        comments: unknown[];
        puzzles: unknown[];
        tags: unknown[];
      };
      assert.equal(snapshot.board._id, boardId);
      assert.instanceOf(snapshot.board.createdAt, Date);
      assert.isAbove(
        snapshot.nodes.filter((n) => n.type === "puzzle").length,
        0,
      );
      assert.isArray(snapshot.edges);
      assert.deepEqual(snapshot.versions, []);
      assert.deepEqual(snapshot.comments, []);
      assert.isAbove(snapshot.puzzles.length, 0);
      assert.isAbove(snapshot.tags.length, 0);
    });

    it("tells an archived hunt's viewer and an operator what they are", async () => {
      const viewer = await join(archived(member));
      assert.isFalse(viewer.welcome.mayEdit);
      assert.equal(viewer.welcome.access, "view");
      const op = await join(operator);
      assert.isTrue(op.welcome.operator);
    });

    it("leaves the puzzle copies off a puzzle's board", async () => {
      const puzzle = Random.id();
      await ensureBoard({ hunt: huntId, puzzle });
      const { welcome } = await join(claimsFor(member.user, { puzzle }));
      assert.notProperty(welcome.snapshot, "puzzles");
      assert.notProperty(welcome.snapshot, "tags");
      assert.deepEqual(welcome.snapshot?.nodes, []);
    });

    it("closes 4503 while the whiteboard is off", async () => {
      await setFlag("disable.whiteboard");
      const client = await connect();
      client.send({ t: "hello", token: tokenOf(member) });
      assert.equal((await client.closed).code, 4503);
    });

    it("takes a renewed token on the same socket", async () => {
      const { client } = await join(member);
      const watching = await join(operator);
      client.send({
        t: "hello",
        token: tokenOf({ ...member, name: "Renamed" }),
      });
      const again = await client.nextOf("welcome");
      assert.equal(again.name, "Renamed");
      assert.notProperty(again, "snapshot");
      // Still on the board
      await client.call("upsertNodes", { nodes: [textNode()] });
      // And the others hear the new name
      const renamed = await watching.client.next(
        (m) => m.t === "live" && (m as { name?: string }).name === "Renamed",
      );
      assert.equal((renamed as { user: string }).user, member.user);
    });

    it("sends the snapshot again when a renewal hides or shows ink", async () => {
      const { client } = await join(member);
      const ink = zigzag(5);
      await client.call("upsertNodes", { nodes: [ink] });
      client.send({ t: "hello", token: tokenOf(member), hideInk: true });
      const hidden = await client.nextOf("welcome");
      const nodes = hidden.snapshot?.nodes as {
        _id: string;
        points?: unknown[];
      }[];
      assert.isUndefined(nodes.find((n) => n._id === ink._id)?.points);
      client.send({ t: "hello", token: tokenOf(member) });
      const same = await client.nextOf("welcome");
      assert.notProperty(same, "snapshot");
      client.send({ t: "hello", token: tokenOf(member), hideInk: false });
      const shown = await client.nextOf("welcome");
      const all = shown.snapshot?.nodes as {
        _id: string;
        points?: unknown[];
      }[];
      assert.lengthOf(all.find((n) => n._id === ink._id)?.points ?? [], 5);
    });

    it("closes a renewal for another scope", async () => {
      const { client } = await join(member);
      client.send({
        t: "hello",
        token: tokenFor(member.user, { hunt: Random.id() }),
      });
      assert.equal((await client.closed).code, 4403);
    });
  });

  describe("call", () => {
    it("answers a write and tells the room", async () => {
      const a = await join(member);
      const b = await join(operator);
      const node = textNode("from a");
      const value = await a.client.call("upsertNodes", { nodes: [node] });
      assert.isNull(value ?? null);
      const change = await b.client.next<Change>(changeTo(node._id));
      assert.equal(change.collection, WhiteboardNodes.name);
      assert.equal((change.doc as { text: string }).text, "from a");
      // The writer hears it too
      const own = await a.client.next<Change>(changeTo(node._id));
      assert.equal((own.doc as { createdBy: string }).createdBy, member.user);

      await a.client.call("deleteNodes", { nodeIds: [node._id] });
      const gone = await b.client.next<Change>(changeTo(node._id));
      assert.isNull(gone.doc);
    });

    it("answers a read", async () => {
      const { client } = await join(member);
      const chunk = await client.call<{ data: Uint8Array; chunkCount: number }>(
        "exportBoard",
        { index: 0 },
      );
      assert.instanceOf(chunk.data, Uint8Array);
      assert.equal(chunk.chunkCount, 1);
    });

    it("says nothing to a socket on another board", async () => {
      const puzzle = Random.id();
      await ensureBoard({ hunt: huntId, puzzle });
      const other = await join(claimsFor(member.user, { puzzle }));
      const { client } = await join(operator);
      const node = textNode();
      await client.call("upsertNodes", { nodes: [node] });
      await client.next(changeTo(node._id));
      await other.client.none((m) => m.t === "change");
    });

    it("answers an error in the method's shape", async () => {
      const { client } = await join(member);
      const error = await failure(
        client.call("upsertNodes", { nodes: [{ _id: "x", bogus: 1 }] }),
      );
      assert.equal(error.code, 400);
      assert.match(error.reason, /Unknown key 'bogus'/);
      const unknown = await failure(client.call("nope", {}));
      assert.equal(unknown.code, 404);
      const malformed = await failure(client.call("upsertNodes", "nope"));
      assert.equal(malformed.code, 400);
    });

    it("answers a malformed frame after hello with an error", async () => {
      const { client } = await join(member);
      client.send({ t: "call", name: "upsertNodes" });
      const error = await client.nextOf("error");
      assert.equal(error.code, 400);
      assert.isNull(error.id);
      client.send({ t: "nope" });
      assert.equal((await client.nextOf("error")).code, 400);
      // Still connected
      await client.call("upsertNodes", { nodes: [] });
    });
  });

  describe("live", () => {
    it("is rebroadcast to the room and not stored", async () => {
      const a = await join(member);
      const b = await join(operator);
      await b.client.nextOf("presence");
      a.client.send({
        t: "live",
        cursor: { x: 1, y: 2 },
        drag: null,
        stroke: null,
      });
      const live = await b.client.next<{
        t: "live";
        user: string;
        cursor: unknown;
        connection: string;
      }>((m) => m.t === "live");
      assert.equal(live.user, member.user);
      assert.deepEqual(live.cursor, { x: 1, y: 2 });
      assert.equal(live.connection, a.welcome.connection);
      await a.client.none((m) => m.t === "live");
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          type: "ink",
        }).countAsync(),
        0,
      );
    });

    it("tells the room who's here", async () => {
      const a = await join(member);
      const first = await a.client.nextOf("presence");
      assert.lengthOf(first.users, 1);
      const b = await join(operator);
      const second = await a.client.nextOf("presence");
      assert.lengthOf(second.users, 2);
      await b.client.close();
      const third = await a.client.nextOf("presence");
      assert.lengthOf(third.users, 1);
    });

    it("answers an invalid update with an error", async () => {
      const { client } = await join(member);
      client.send({
        t: "live",
        cursor: { x: 1e9, y: 0 },
        drag: null,
        stroke: null,
      });
      const error = await client.nextOf("error");
      assert.equal(error.code, 400);
      assert.match(error.reason, /Invalid live update/);
    });
  });

  describe("ink", () => {
    const pointsOf = (message: unknown) =>
      ((message as { doc: { points?: unknown[] } }).doc ?? {}).points;

    it("sends ink to a socket that hid it as an outline without points", async () => {
      const hiding = await join(member, true);
      const seeing = await join(operator);
      const ink = zigzag(5);
      const text = textNode();
      await seeing.client.call("upsertNodes", { nodes: [ink, text] });
      assert.lengthOf(
        pointsOf(await seeing.client.next(changeTo(ink._id)))!,
        5,
      );
      const outline = await hiding.client.next(changeTo(ink._id));
      assert.isUndefined(pointsOf(outline));
      assert.equal((outline as { doc: { type: string } }).doc.type, "ink");
      await hiding.client.next(changeTo(text._id));
      await seeing.client.call("deleteNodes", { nodeIds: [ink._id] });
      await seeing.client.next(changeTo(ink._id));
      // The outline goes when the stroke does
      await hiding.client.next(changeTo(ink._id));
    });

    it("leaves points out of a hidden snapshot", async () => {
      const ink = zigzag(5);
      const { client } = await join(operator);
      await client.call("upsertNodes", { nodes: [ink] });
      const hiding = await join(member, true);
      const nodes = hiding.welcome.snapshot?.nodes as {
        _id: string;
        type: string;
        points?: unknown[];
      }[];
      const outline = nodes.find((n) => n._id === ink._id);
      assert.ok(outline);
      assert.equal(outline.type, "ink");
      assert.isUndefined(outline.points);
      const seeing = await join(member);
      const all = seeing.welcome.snapshot?.nodes as {
        _id: string;
        points?: unknown[];
      }[];
      assert.lengthOf(all.find((n) => n._id === ink._id)?.points ?? [], 5);
    });
  });

  describe("access", () => {
    it("demotes a member's socket when the policy goes operators-only", async () => {
      const a = await join(member);
      const b = await join(operator);
      const node = textNode();
      await a.client.call("upsertNodes", { nodes: [node] });
      await a.client.next(changeTo(node._id));
      a.client.send({
        t: "live",
        cursor: { x: 1, y: 1 },
        drag: [{ node: node._id, x: 5, y: 5 }],
        stroke: null,
        selection: [node._id],
      });
      const dragging = await b.client.next<{ t: "live"; drag: unknown[] }>(
        (m) => m.t === "live",
      );
      assert.lengthOf(dragging.drag, 1);

      await b.client.call("setEditPolicy", {
        editPolicy: "operators",
        editors: [],
      });
      const board = await a.client.next<Change>(changeTo(boardId));
      assert.equal(board.collection, Whiteboards.name);
      assert.equal(
        (board.doc as { editPolicy: string }).editPolicy,
        "operators",
      );
      const cleared = await b.client.next<{
        t: "live";
        user: string;
        drag: unknown;
        selection: unknown;
      }>((m) => m.t === "live");
      assert.equal(cleared.user, member.user);
      assert.isNull(cleared.drag);
      assert.isNull(cleared.selection);

      const error = await failure(
        a.client.call("upsertNodes", { nodes: [{ ...node, text: "again" }] }),
      );
      assert.equal(error.code, 403);
      assert.match(error.reason, /Only operators/);
      // Comments still go through
      await a.client.call("comment.post", {
        text: "still here",
        anchor: { node: node._id, x: 1, y: 1 },
      });
    });

    it("closes everyone when the board is deleted", async () => {
      const { client } = await join(member);
      const { deleteBoard } = await import("../../server/whiteboard");
      await deleteBoard(boardId);
      const closed = await client.closed;
      assert.equal(closed.code, 4404);
    });
  });

  describe("ping", () => {
    it("answers a ping", async () => {
      const { client } = await join(member);
      client.send({ t: "ping" });
      await client.nextOf("pong");
    });

    it("pings, and closes a socket that doesn't answer", async () => {
      const { client } = await join(member);
      await client.nextOf("ping");
      client.send({ t: "pong" });
      await client.nextOf("ping");
      const closed = await client.closed;
      assert.equal(closed.code, 4408);
    });
  });

  describe("frames", () => {
    it("refuses an oversize frame that isn't a call", async () => {
      const { client } = await join(member);
      client.send({
        t: "live",
        cursor: { x: 1, y: 1 },
        drag: null,
        stroke: null,
        selection: Array.from({ length: 5000 }, () => Random.id()),
      });
      const closed = await client.closed;
      assert.equal(closed.code, 1009);
    });

    it("takes a call bigger than that", async () => {
      const { client } = await join(member);
      const nodes = Array.from({ length: 60 }, () =>
        textNode("x".repeat(1500)),
      );
      assert.isAbove(JSON.stringify(nodes).length, MAX_FRAME_BYTES);
      await client.call("upsertNodes", { nodes });
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          type: "text",
        }).countAsync(),
        60,
      );
    });

    it("refuses a binary frame", async () => {
      const { client } = await join(member);
      client.sendRaw(new Uint8Array([1, 2, 3]).buffer);
      assert.equal((await client.closed).code, 1003);
    });
  });
});
