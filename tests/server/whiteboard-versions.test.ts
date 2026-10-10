import { afterAll, beforeAll, beforeEach, describe, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { EJSON } from "lib/compat/ejson";
import { Random } from "lib/compat/random";
import BoardComments from "lib/models/BoardComments";
import Puzzles from "lib/models/Puzzles";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import type { WhiteboardVersionType } from "lib/models/WhiteboardVersions";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import {
  BIG_READS_PER_MINUTE,
  MAX_BATCH,
  MAX_INK_POINTS_PER_BOARD,
  MAX_KEPT_EXPORTS,
  MAX_NODES_PER_BOARD,
  MAX_VERSION_BYTES_PER_BOARD,
  VERSION_INTERVAL_MS,
} from "lib/whiteboard/limits";
import { postComment } from "../../server/comments";
import Logger from "../../server/logger";
import WhiteboardVersionChunks from "../../server/models/WhiteboardVersionChunks";
import { ensureBoard, syncPuzzlesOnBoard } from "../../server/whiteboard";
import {
  deleteNodes,
  upsertEdges,
  upsertNodes,
} from "../../server/whiteboardEdits";
import { resetLayout } from "../../server/whiteboardReset";
import {
  compressVersion,
  decodeVersion,
  EXPORT_KEPT_MS,
  exportBoard,
  fetchVersion,
  pruneWhiteboardVersions,
  restoreItems,
  restoreVersion,
  serializeBoard,
} from "../../server/whiteboardVersions";
import {
  fillInk,
  lockThief,
  otherHuntBoard,
  uploadUrl,
  withImageBucket,
  withoutImageBucket,
  zigzag,
} from "./fixtures";
import {
  archived,
  call,
  fakeConnection,
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

const MINUTE = 60 * 1000;

describe("whiteboard versions", () => {
  let operator: Claims;
  let member: Claims;
  let other: Claims;
  let outsider: Claims;
  let boardId: string;

  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  beforeEach(async () => {
    await resetDatabase();
    withoutImageBucket();
    operator = makeUser(true);
    member = makeUser();
    other = makeUser();
    outsider = { ...makeUser(), scope: { hunt: Random.id() } };
    await makeFixtureHunt(operator.user);
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
  });

  const versions = () =>
    WhiteboardVersions.find(
      { board: boardId },
      { sort: { createdAt: -1 } },
    ).fetchAsync();
  const newest = async () => (await versions())[0]!;

  // Moves every version, and everyone's window on it, back in time, so the
  // next edit starts a new one.
  const age = async (ms: number) => {
    for (const version of await versions()) {
      await WhiteboardVersions.rawCollection().updateOne(
        { _id: version._id },
        {
          $set: {
            createdAt: new Date(version.createdAt.getTime() - ms),
            users: version.users.map((u) => ({
              user: u.user,
              at: new Date(u.at.getTime() - ms),
            })),
          },
        },
      );
    }
  };
  const nextWindow = () => age(VERSION_INTERVAL_MS + MINUTE);

  const sticky = async (
    claims: Claims,
    position?: { x: number; y: number },
  ) => {
    const _id = Random.id();
    await upsertNodes(claims, boardId, [
      { _id, type: "sticky", position: position ?? { x: 5000, y: 5000 } },
    ]);
    return _id;
  };

  const payloadOf = async (version: WhiteboardVersionType) =>
    decodeVersion(
      (
        await WhiteboardVersionChunks.find(
          { version: version._id },
          { sort: { index: 1 } },
        ).fetchAsync()
      ).map((c) => c.data),
    );
  const board = async () => ({
    nodes: await WhiteboardNodes.find({ board: boardId }).fetchAsync(),
    edges: await WhiteboardEdges.find({ board: boardId }).fetchAsync(),
  });
  const node = (id: string) => WhiteboardNodes.findOneAsync(id);
  const edge = (id: string) => WhiteboardEdges.findOneAsync(id);
  const restoreAs = (claims: Claims, versionId: string) =>
    call("restoreVersion", claims, boardId, { versionId });
  const restoreItemsAs = (
    claims: Claims,
    versionId: string,
    nodeIds: string[],
  ) =>
    call("restoreItems", claims, boardId, { versionId, nodeIds }) as Promise<{
      restored: boolean;
    }>;
  // The version an edit in a new window records
  const versionAfter = async (edit: () => Promise<unknown>) => {
    await nextWindow();
    await edit();
    return newest();
  };
  // The board and its history, to check nothing has changed them since
  const snapshot = async () => ({
    board: await board(),
    versionIds: (await versions()).map((v) => v._id),
  });
  const assertUnchanged = async ({
    board: before,
    versionIds,
  }: Awaited<ReturnType<typeof snapshot>>) => {
    const after = await board();
    assert.sameDeepMembers(after.nodes, before.nodes);
    assert.sameDeepMembers(after.edges, before.edges);
    assert.sameMembers(
      (await versions()).map((v) => v._id),
      versionIds,
    );
  };
  // A comment by the member pinned to node, 10 across and 20 down from its
  // corner; returns its id
  const commentOn = (node: string, text: string) =>
    postComment(member, boardId, { text, anchor: { node, x: 10, y: 20 } });
  // A version of another hunt's board, recorded by a note put on it
  const foreignVersion = async () => {
    const { board: otherBoard, claims } = await otherHuntBoard(operator);
    const note = Random.id();
    await upsertNodes(claims, otherBoard, [
      { _id: note, type: "sticky", position: { x: 0, y: 0 } },
    ]);
    const version = (await WhiteboardVersions.findOneAsync({
      board: otherBoard,
    }))!;
    return { otherBoard, note, version };
  };
  const inkAt = { x: 600, y: 600 };
  const quietly = async <T>(fn: () => Promise<T>) => {
    const warn = spyOn(Logger, "warn").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      warn.mockRestore();
    }
  };

  // Stores a version made from a payload, as recording one would.
  const storeVersion = async (
    nodes: unknown[],
    edges: unknown[],
    chunkBytes?: number,
  ) => {
    const json = EJSON.stringify({ format: 1, nodes, edges });
    const chunks = await compressVersion(json, chunkBytes);
    const versionId = Random.id();
    const createdAt = new Date(Date.now() - 30 * MINUTE);
    for (const [index, data] of chunks.entries()) {
      await WhiteboardVersionChunks.insertAsync({
        hunt: huntId,
        board: boardId,
        version: versionId,
        index,
        data,
        createdAt,
      });
    }
    await WhiteboardVersions.insertAsync({
      _id: versionId,
      hunt: huntId,
      board: boardId,
      kind: "edits",
      users: [{ user: member.user, at: createdAt }],
      changeCount: 1,
      lastEditAt: createdAt,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      size: chunks.reduce((sum, c) => sum + c.length, 0),
      chunkCount: chunks.length,
      format: 1,
      hash: "0".repeat(64),
      createdAt,
      createdBy: member.user,
    });
    return { versionId, chunks };
  };

  describe("recording", () => {
    it("records a version on a user's first edit", async () => {
      const before = await board();
      const id = await sticky(member);
      const [version, ...rest] = await versions();
      assert.isEmpty(rest);
      assert.equal(version!.kind, "edits");
      assert.deepEqual(
        version!.users.map((u) => u.user),
        [member.user],
      );
      assert.equal(version!.changeCount, 1);
      assert.equal(version!.nodeCount, before.nodes.length);
      assert.equal(version!.edgeCount, before.edges.length);
      // It's the board from before the edit
      const payload = await payloadOf(version!);
      assert.notInclude(
        payload.nodes.map((n) => n._id),
        id,
      );
      assert.sameMembers(
        payload.nodes.map((n) => n._id),
        before.nodes.map((n) => n._id),
      );
      assert.equal(
        await WhiteboardVersionChunks.find({
          version: version!._id,
        }).countAsync(),
        version!.chunkCount,
      );
    });

    it("doesn't record twice for one user within the interval", async () => {
      const id = await sticky(member);
      await upsertNodes(member, boardId, [{ _id: id, text: "edited" }]);
      await deleteNodes(member, boardId, [await sticky(member)]);
      const [version, ...rest] = await versions();
      assert.isEmpty(rest);
      assert.equal(version!.changeCount, 4);

      // Once the interval has passed, the next edit records again
      await nextWindow();
      await sticky(member);
      assert.lengthOf(await versions(), 2);
    });

    it("joins a version less than a minute old", async () => {
      await sticky(member);
      await sticky(other);
      const [version, ...rest] = await versions();
      assert.isEmpty(rest);
      assert.deepEqual(
        version!.users.map((u) => u.user),
        [member.user, other.user],
      );
      assert.equal(version!.changeCount, 2);

      // A minute on, someone else's edit to a changed board starts a new one
      await age(2 * MINUTE);
      await sticky(operator);
      const latest = await newest();
      assert.lengthOf(await versions(), 2);
      assert.deepEqual(
        latest.users.map((u) => u.user),
        [operator.user],
      );
      // and the first two can still extend theirs
      await sticky(other);
      assert.lengthOf(await versions(), 2);
    });

    it("prunes under the lock instead of refusing when the board is over the byte cap", async () => {
      await sticky(member);
      const big = MAX_VERSION_BYTES_PER_BOARD / 2;
      const fakes: string[] = [];
      for (const hours of [3, 4, 5]) {
        const createdAt = new Date(Date.now() - hours * 60 * MINUTE);
        fakes.push(
          await WhiteboardVersions.insertAsync({
            hunt: huntId,
            board: boardId,
            kind: "edits",
            users: [{ user: other.user, at: createdAt }],
            changeCount: 1,
            lastEditAt: createdAt,
            nodeCount: 0,
            edgeCount: 0,
            size: big,
            chunkCount: 1,
            format: 1,
            hash: "0".repeat(64),
            createdAt,
            createdBy: other.user,
          }),
        );
      }
      await nextWindow();
      const id = await sticky(member);
      assert.ok(await node(id));
      const left = (await versions()).map((v) => v._id);
      assert.lengthOf(left, 3);
      assert.include(left, fakes[0]);
      assert.notInclude(left, fakes[1]);
      assert.notInclude(left, fakes[2]);
      assert.ok(
        (await Whiteboards.findOneAsync(boardId))?.versionsPrunedBefore,
      );
    });

    it("records nothing with history off, while edits still go through", async () => {
      await sticky(member);
      await setFlag("disable.whiteboard_versions");
      const id = await sticky(other);
      assert.ok(await node(id));
      assert.lengthOf(await versions(), 1);
    });
  });

  describe("payloads", () => {
    it("round-trips a payload larger than one chunk", async () => {
      const { nodes, edges } = await board();
      const { json } = serializeBoard(nodes, edges);
      const chunks = await compressVersion(json, 256);
      assert.isAbove(chunks.length, 1);
      chunks.forEach((chunk) => assert.isAtMost(chunk.length, 256));
      const decoded = await decodeVersion(chunks);
      assert.sameDeepMembers(decoded.nodes, nodes);
      assert.sameDeepMembers(decoded.edges, edges);
    });

    it("fetches a multi-chunk version one chunk per call and refuses an index out of range", async () => {
      const { nodes, edges } = await board();
      const { versionId, chunks } = await storeVersion(nodes, edges, 512);
      assert.isAbove(chunks.length, 1);
      const fetch = (claims: Claims, index: number) =>
        call("fetchVersion", claims, boardId, {
          versionId,
          index,
        }) as Promise<Uint8Array>;
      const fetched: Uint8Array[] = [];
      for (let index = 0; index < chunks.length; index++) {
        fetched.push(await fetch(member, index));
      }
      fetched.forEach((chunk, i) =>
        assert.deepEqual([...chunk], [...chunks[i]!]),
      );
      assert.sameDeepMembers((await decodeVersion(fetched)).nodes, nodes);

      await rejects(fetch(member, chunks.length), /Unknown version/);
      await rejects(fetch(member, -1), /Unknown version/);
      await rejects(fetch(outsider, 0), /member/);
      // An archived hunt's history can still be read
      assert.lengthOf(await fetch(archived(member), 0), chunks[0]!.length);
      await setFlag("disable.whiteboard_versions");
      await rejects(fetch(member, 0), /history is turned off/);
    });
  });

  describe("export", () => {
    const exportChunk = (claims: Claims, index = 0) =>
      call("exportBoard", claims, boardId, { index }) as Promise<{
        data: Uint8Array;
        chunkCount: number;
        hash: string;
      }>;
    const download = async (claims: Claims) => {
      const { data, chunkCount } = await exportChunk(claims);
      assert.equal(chunkCount, 1);
      return EJSON.parse(gunzipSync(data).toString("utf8")) as {
        format: number;
        nodes: unknown[];
        edges: unknown[];
      };
    };

    it("gives a member every node and line on the board, ink included", async () => {
      const ink = zigzag(20, inkAt);
      await upsertNodes(member, boardId, [ink]);
      const [a, b] = [await sticky(member), await sticky(member)];
      await upsertEdges(member, boardId, [
        { _id: Random.id(), source: a, target: b },
      ]);
      const live = await board();

      const payload = await download(member);
      assert.equal(payload.format, 1);
      assert.sameDeepMembers(payload.nodes, live.nodes);
      assert.sameDeepMembers(payload.edges, live.edges);
      assert.isNotEmpty(live.edges);
      assert.deepEqual(
        (payload.nodes as typeof live.nodes).find((n) => n._id === ink._id)
          ?.points,
        ink.points,
      );
      await rejects(exportChunk(member, 1), /No such part/);
      await rejects(exportChunk(member, -1), /No such part/);
    });

    it("gives the same hash for the same board, and a new one once it changes", async () => {
      const first = await exportChunk(member);
      const again = await exportChunk(member);
      assert.equal(again.hash, first.hash);
      assert.deepEqual([...again.data], [...first.data]);
      await sticky(member);
      assert.notEqual((await exportChunk(member)).hash, first.hash);
    });

    describe("a board too big for one chunk", () => {
      // How many times the board's nodes are read
      const boardReads = () => {
        const find = WhiteboardNodes.find.bind(WhiteboardNodes);
        let reads = 0;
        const stub = spyOnMethod(WhiteboardNodes, "find").mockImplementation(
          (...args: Parameters<typeof find>) => {
            const selector = args[0] as Record<string, unknown> | undefined;
            if (
              selector?.board === boardId &&
              Object.keys(selector).length === 1
            ) {
              reads += 1;
            }
            return find(...args);
          },
        );
        return Object.assign(() => reads, {
          restore: () => stub.mockRestore(),
        });
      };

      beforeEach(async () => {
        // Text that doesn't compress, so the board comes to two chunks
        await WhiteboardNodes.insertAsync({
          hunt: huntId,
          board: boardId,
          type: "sticky",
          position: { x: 0, y: 0 },
          text: randomBytes(6 * 1024 * 1024).toString("base64"),
          createdBy: member.user,
        });
      });

      it("reads and compresses it once for all its chunks", async () => {
        const live = await board();
        const reads = boardReads();
        try {
          const conn = fakeConnection();
          const first = await exportBoard(member, boardId, 0, undefined, conn);
          assert.equal(first.chunkCount, 2);
          const second = await exportBoard(
            member,
            boardId,
            1,
            first.hash,
            conn,
          );
          assert.equal(second.hash, first.hash);
          assert.equal(reads(), 1);
          const payload = EJSON.parse(
            gunzipSync(Buffer.concat([first.data, second.data])).toString(
              "utf8",
            ),
          ) as { nodes: unknown[]; edges: unknown[] };
          assert.sameDeepMembers(payload.nodes, live.nodes);
          assert.sameDeepMembers(payload.edges, live.edges);

          // The export is dropped once its last chunk is sent
          await exportBoard(member, boardId, 1, first.hash, conn);
          assert.equal(reads(), 2);
        } finally {
          reads.restore();
        }
      });

      it("reads the board again for a later chunk of an export it no longer has", async () => {
        const reads = boardReads();
        try {
          const conn = fakeConnection();
          const first = await exportBoard(member, boardId, 0, undefined, conn);
          conn.close();
          await WhiteboardNodes.insertAsync({
            hunt: huntId,
            board: boardId,
            type: "text",
            position: { x: 0, y: 0 },
            createdBy: member.user,
          });
          const second = await exportBoard(
            member,
            boardId,
            1,
            first.hash,
            conn,
          );
          assert.equal(reads(), 2);
          assert.notEqual(second.hash, first.hash);

          // and without a connection, every chunk reads it
          const third = await exportBoard(member, boardId, 0, undefined, null);
          await exportBoard(member, boardId, 1, third.hash, null);
          assert.equal(reads(), 4);
        } finally {
          reads.restore();
        }
      });

      it("drops an export nothing has fetched from for five minutes", async () => {
        const reads = boardReads();
        const conn = fakeConnection();
        const clock = fakeNow();
        const other = fakeConnection();
        try {
          const first = await exportBoard(member, boardId, 0, undefined, conn);
          clock.tick(EXPORT_KEPT_MS - 1000);
          // Another connection's export sweeps, but this one isn't stale yet
          await exportBoard(member, boardId, 0, undefined, other);
          assert.equal(reads(), 2);
          clock.tick(1000);
          await WhiteboardNodes.insertAsync({
            hunt: huntId,
            board: boardId,
            type: "text",
            position: { x: 0, y: 0 },
            createdBy: member.user,
          });
          const second = await exportBoard(
            member,
            boardId,
            1,
            first.hash,
            conn,
          );
          assert.equal(reads(), 3);
          assert.notEqual(second.hash, first.hash);
        } finally {
          other.close();
          clock.restore();
          reads.restore();
        }
      });

      it("keeps at most eight exports on a server, dropping the one fetched from longest ago", async () => {
        const reads = boardReads();
        const conns = Array.from({ length: MAX_KEPT_EXPORTS + 1 }, () =>
          fakeConnection(),
        );
        try {
          const first = await exportBoard(
            member,
            boardId,
            0,
            undefined,
            conns[0]!,
          );
          for (const conn of conns.slice(1)) {
            await exportBoard(member, boardId, 0, undefined, conn);
          }
          assert.equal(reads(), conns.length);
          // The newest still has its export
          await exportBoard(member, boardId, 1, first.hash, conns.at(-1)!);
          assert.equal(reads(), conns.length);
          // The first's has gone, so its next chunk reads the board again
          await exportBoard(member, boardId, 1, first.hash, conns[0]!);
          assert.equal(reads(), conns.length + 1);
        } finally {
          conns.forEach((conn) => conn.close());
          reads.restore();
        }
      });

      it("keeps an export for its next chunk until five minutes are up", async () => {
        const reads = boardReads();
        const conn = fakeConnection();
        const clock = fakeNow();
        try {
          const first = await exportBoard(member, boardId, 0, undefined, conn);
          clock.tick(EXPORT_KEPT_MS - 1000);
          const second = await exportBoard(
            member,
            boardId,
            1,
            first.hash,
            conn,
          );
          assert.equal(second.hash, first.hash);
          assert.equal(reads(), 1);
        } finally {
          clock.restore();
          reads.restore();
        }
      });

      it("counts the five minutes from the last chunk fetched", async () => {
        // A second sticky that doesn't compress, so there are more than two
        // chunks
        await WhiteboardNodes.insertAsync({
          hunt: huntId,
          board: boardId,
          type: "sticky",
          position: { x: 0, y: 0 },
          text: randomBytes(6 * 1024 * 1024).toString("base64"),
          createdBy: member.user,
        });
        const reads = boardReads();
        const conn = fakeConnection();
        const clock = fakeNow();
        try {
          const first = await exportBoard(member, boardId, 0, undefined, conn);
          assert.isAtLeast(first.chunkCount, 3);
          clock.tick(EXPORT_KEPT_MS - 1000);
          await exportBoard(member, boardId, 1, first.hash, conn);
          // Over five minutes since chunk 0, but not since chunk 1
          clock.tick(2000);
          const third = await exportBoard(member, boardId, 2, first.hash, conn);
          assert.equal(third.hash, first.hash);
          assert.equal(reads(), 1);
        } finally {
          conn.close();
          clock.restore();
          reads.restore();
        }
      });
    });

    it("lets each person fetch 60 chunks a minute, versions and exports together, across connections", async () => {
      const { nodes, edges } = await board();
      const { versionId } = await storeVersion(nodes, edges);
      const clock = fakeNow();
      try {
        for (let i = 0; i < BIG_READS_PER_MINUTE; i++) {
          if (i % 2 === 0) {
            await fetchVersion(member, boardId, versionId, 0);
          } else {
            await exportBoard(member, boardId, 0, undefined, null);
          }
        }
        await rejects(
          fetchVersion(member, boardId, versionId, 0),
          /try again in a minute/,
        );
        await rejects(exportChunk(member), /try again in a minute/);
        await rejects(
          call("fetchVersion", member, boardId, { versionId, index: 0 }),
          /try again in a minute/,
        );
        // Someone else isn't held back
        await fetchVersion(other, boardId, versionId, 0);
        // A second later there's one more
        clock.tick(1000);
        await fetchVersion(member, boardId, versionId, 0);
        await rejects(
          fetchVersion(member, boardId, versionId, 0),
          /try again in a minute/,
        );
      } finally {
        clock.restore();
      }
    });

    it("works on an archived hunt, and with history off", async () => {
      await setFlag("disable.whiteboard_versions");
      const payload = await download(archived(member));
      assert.sameDeepMembers(payload.nodes, (await board()).nodes);
    });

    it("refuses someone outside the hunt, and while the whiteboard is off", async () => {
      await rejects(exportChunk(outsider), /member/);
      await setFlag("disable.whiteboard");
      await rejects(exportChunk(member), /whiteboard is disabled/);
    });
  });

  // A puzzle's card, and the puzzle deleted (and replaced by replacedBy, if
  // given) with the board synced, as the feed's deferred sync does.
  const firstCard = async () =>
    (await WhiteboardNodes.findOneAsync({ board: boardId, type: "puzzle" }))!;
  const deletePuzzle = async (puzzleId: string, replacedBy?: string) => {
    await Puzzles.updateAsync(puzzleId, {
      $set: { deleted: true, ...(replacedBy ? { replacedBy } : {}) },
    });
    await syncPuzzlesOnBoard(huntId, [puzzleId]);
  };
  const newPuzzle = async (tags: string[]) => {
    const puzzleId = await Puzzles.insertAsync({
      hunt: huntId,
      title: "Replacement",
      tags,
      answers: [],
      expectedAnswerCount: 1,
      createdBy: operator.user,
    });
    await syncPuzzlesOnBoard(huntId, [puzzleId]);
    return puzzleId;
  };

  describe("restoring", () => {
    it("restores moved, deleted and hidden nodes", async () => {
      const moved = await sticky(member, { x: 0, y: 0 });
      const deleted = await sticky(member, { x: 300, y: 0 });
      const card = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
      }))!;
      const version = await versionAfter(() =>
        upsertNodes(member, boardId, [
          { _id: moved, position: { x: 500, y: 500 } },
        ]),
      );
      await deleteNodes(member, boardId, [deleted, card._id]);
      assert.isTrue((await node(card._id))?.hidden);

      await restoreAs(member, version._id);

      assert.deepEqual((await node(moved))?.position, {
        x: 0,
        y: 0,
      });
      assert.ok(await node(deleted));
      assert.notOk((await node(card._id))?.hidden);
      assert.ok((await Whiteboards.findOneAsync(boardId))?.lastRewrittenAt);
    });

    it("keeps an image node in a version and puts it back", async () => {
      withImageBucket();
      const _id = Random.id();
      const image = {
        url: uploadUrl(huntId, Random.id()),
        width: 640,
        height: 480,
      };
      await upsertNodes(member, boardId, [
        {
          _id,
          type: "image",
          position: { x: 40, y: 60 },
          width: 320,
          height: 240,
          image,
        },
      ]);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [_id]),
      );
      const payload = await payloadOf(version);
      assert.deepEqual(payload.nodes.find((n) => n._id === _id)?.image, image);

      await restoreAs(member, version._id);
      const restored = (await node(_id))!;
      assert.equal(restored.type, "image");
      assert.deepEqual(restored.image, image);
      assert.equal(restored.width, 320);
      assert.equal(restored.height, 240);
    });

    it("keeps a shape and a highlighter stroke in a version and puts them back", async () => {
      const shape = Random.id();
      const marker = Random.id();
      await upsertNodes(member, boardId, [
        {
          _id: shape,
          type: "shape",
          position: { x: 40, y: 60 },
          width: 160,
          height: 120,
          shape: "ellipse",
          color: "pink",
        },
        {
          _id: marker,
          type: "ink",
          position: { x: 0, y: 0 },
          strokeWidth: "marker",
          stroke: Random.id(),
          points: [
            [0, 0, 0.5],
            [100, 0, 0.5],
          ],
        },
      ]);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [shape, marker]),
      );

      await restoreAs(member, version._id);
      const restored = (await node(shape))!;
      assert.equal(restored.type, "shape");
      assert.equal(restored.shape, "ellipse");
      assert.equal(restored.color, "pink");
      assert.equal(restored.width, 160);
      assert.equal((await node(marker))?.strokeWidth, "marker");
    });

    it("doesn't put back a deleted puzzle's card, but moves it with the version", async () => {
      const card = await firstCard();
      const note = await sticky(member, { x: 6000, y: 6000 });
      const line = Random.id();
      await upsertEdges(member, boardId, [
        { _id: line, source: note, target: card._id },
      ]);
      const version = await versionAfter(() => sticky(member));
      await upsertNodes(member, boardId, [
        { _id: card._id, position: { x: 7000, y: 7000 } },
      ]);
      await deletePuzzle(card.puzzle!);
      assert.isTrue((await node(card._id))?.hidden);

      await restoreVersion(member, boardId, version._id);

      const after = (await node(card._id))!;
      assert.isTrue(after.hidden);
      assert.isTrue(after.hiddenWithPuzzle);
      assert.deepEqual(after.position, card.position);
      assert.equal(after.parent, card.parent);
      assert.equal((await edge(line))?.target, card._id);
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          puzzle: card.puzzle,
          hidden: { $ne: true },
        }).countAsync(),
        0,
      );
    });

    it("keeps a card handed over to a replacement, where the version had it", async () => {
      const card = await firstCard();
      const note = await sticky(member, { x: 6000, y: 6000 });
      const line = Random.id();
      await upsertEdges(member, boardId, [
        { _id: line, source: note, target: card._id },
      ]);
      const version = await versionAfter(() => sticky(member));
      const old = (await Puzzles.findOneAsync(card.puzzle))!;
      const replacement = await newPuzzle(old.tags);
      await deletePuzzle(old._id, replacement);
      assert.equal((await node(card._id))?.puzzle, replacement);
      await upsertNodes(member, boardId, [
        { _id: card._id, position: { x: 7000, y: 7000 } },
      ]);

      await restoreVersion(member, boardId, version._id);

      const cards = await WhiteboardNodes.find({
        board: boardId,
        puzzle: { $in: [old._id, replacement] },
      }).fetchAsync();
      assert.deepEqual(
        cards.map((c) => [c._id, c.puzzle, c.hidden]),
        [[card._id, replacement, undefined]],
      );
      assert.deepEqual(cards[0]!.position, card.position);
      assert.equal(cards[0]!.parent, card.parent);
      assert.equal((await edge(line))?.target, card._id);
    });

    it("restores whether a frame is collapsed", async () => {
      const frame = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "frame",
      }))!;
      const isCollapsed = async () => (await node(frame._id))?.collapsed;
      // Folding alone records nothing, so an edit after it records the board
      // with the frame folded
      await upsertNodes(member, boardId, [{ _id: frame._id, collapsed: true }]);
      const folded = await versionAfter(() => sticky(member));
      await upsertNodes(member, boardId, [
        { _id: frame._id, collapsed: false },
      ]);
      const open = await versionAfter(() => sticky(member));
      assert.notEqual(open._id, folded._id);
      assert.isUndefined(await isCollapsed());

      await restoreVersion(member, boardId, folded._id);
      assert.isTrue(await isCollapsed());

      await restoreVersion(member, boardId, open._id);
      assert.isUndefined(await isCollapsed());
    });

    it("restores a card whose id changed since", async () => {
      const card = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
      }))!;
      const note = await sticky(member);
      await upsertEdges(member, boardId, [
        { _id: Random.id(), source: note, target: card._id },
      ]);
      const version = await versionAfter(() => sticky(member));

      // The card is replaced by another for the same puzzle, somewhere else
      await WhiteboardEdges.removeAsync({ target: card._id });
      await WhiteboardNodes.removeAsync(card._id);
      const replacement = await WhiteboardNodes.insertAsync({
        hunt: huntId,
        board: boardId,
        type: "puzzle",
        puzzle: card.puzzle,
        position: { x: 9000, y: 9000 },
        createdBy: operator.user,
      });

      await restoreVersion(member, boardId, version._id);

      const cards = await WhiteboardNodes.find({
        board: boardId,
        puzzle: card.puzzle,
      }).fetchAsync();
      assert.lengthOf(cards, 1);
      assert.equal(cards[0]!._id, replacement);
      assert.deepEqual(cards[0]!.position, card.position);
      assert.equal(cards[0]!.parent, card.parent);
      const lines = await WhiteboardEdges.find({
        board: boardId,
        source: note,
      }).fetchAsync();
      assert.deepEqual(
        lines.map((l) => l.target),
        [replacement],
      );
    });

    it("detaches comments from nodes it removes and re-attaches them to nodes it brings back", async () => {
      const kept = await sticky(member, { x: 100, y: 200 });
      await nextWindow();
      const added = await sticky(member, { x: 1000, y: 1000 });
      const version = await newest();
      const onKept = await commentOn(kept, "on the kept sticky");
      const onAdded = await commentOn(added, "on the added sticky");
      await deleteNodes(member, boardId, [kept]);
      assert.deepEqual((await BoardComments.findOneAsync(onKept))?.comment, {
        x: 110,
        y: 220,
        detachedFrom: kept,
      });

      await restoreVersion(member, boardId, version._id);

      assert.ok(await node(kept));
      assert.notOk(await node(added));
      assert.deepEqual((await BoardComments.findOneAsync(onKept))?.comment, {
        node: kept,
        x: 10,
        y: 20,
      });
      assert.deepEqual((await BoardComments.findOneAsync(onAdded))?.comment, {
        x: 1010,
        y: 1020,
        detachedFrom: added,
      });
    });

    it("puts back nodes and lines whose ids have since been taken on another board, under new ones", async () => {
      const a = await sticky(member, { x: 0, y: 0 });
      const b = await sticky(member, { x: 400, y: 0 });
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: b }]);
      await upsertNodes(member, boardId, [{ _id: a, text: "taken" }]);
      await commentOn(a, "on the taken sticky");
      const version = await versionAfter(() =>
        sticky(member, { x: 800, y: 0 }),
      );
      await deleteNodes(member, boardId, [a]);
      assert.notOk(await edge(line));

      // A member of another hunt reuses both ids there
      const { board: otherBoard, claims } = await otherHuntBoard(operator);
      const end = Random.id();
      await upsertNodes(claims, otherBoard, [
        { _id: a, type: "sticky", position: { x: 0, y: 0 } },
        { _id: end, type: "sticky", position: { x: 400, y: 0 } },
      ]);
      await upsertEdges(claims, otherBoard, [
        { _id: line, source: a, target: end },
      ]);

      await restoreVersion(member, boardId, version._id);

      const restored = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        text: "taken",
      }))!;
      assert.ok(restored);
      assert.notEqual(restored._id, a);
      const lines = await WhiteboardEdges.find({
        board: boardId,
        target: b,
      }).fetchAsync();
      assert.lengthOf(lines, 1);
      assert.equal(lines[0]!.source, restored._id);
      assert.notEqual(lines[0]!._id, line);
      assert.equal(
        (
          await BoardComments.findOneAsync({
            "content.children.text": "on the taken sticky",
          })
        )?.comment?.node,
        restored._id,
      );
      // The other board's are left alone
      assert.equal((await node(a))?.board, otherBoard);
      assert.equal((await edge(line))?.board, otherBoard);
      // and so it can be restored again, when the node keeps its new id
      // and its comment
      await restoreVersion(other, boardId, version._id);
      const again = await WhiteboardNodes.find({
        board: boardId,
        text: "taken",
      }).fetchAsync();
      assert.deepEqual(
        again.map((n) => n._id),
        [restored._id],
      );
      assert.equal(
        (
          await BoardComments.findOneAsync({
            "content.children.text": "on the taken sticky",
          })
        )?.comment?.node,
        restored._id,
      );
    });

    it("finishes a restore that fails part-way through writing", async () => {
      const a = await sticky(member, { x: 0, y: 0 });
      const b = await sticky(member, { x: 400, y: 0 });
      await upsertEdges(member, boardId, [
        { _id: Random.id(), source: a, target: b },
      ]);
      const version = await versionAfter(() =>
        sticky(member, { x: 800, y: 0 }),
      );
      const target = await payloadOf(version);
      await deleteNodes(member, boardId, [a, b]);

      const insert = WhiteboardEdges.insertManyAsync.bind(WhiteboardEdges);
      const insertEdges = spyOn(
        WhiteboardEdges,
        "insertManyAsync",
      ).mockImplementation(insert);
      insertEdges.mockImplementationOnce(() =>
        Promise.reject(new Error("connection reset")),
      );
      try {
        await quietly(() => restoreVersion(member, boardId, version._id));
      } finally {
        insertEdges.mockRestore();
      }

      const live = await board();
      assert.sameMembers(
        live.nodes.map((n) => n._id),
        target.nodes.map((n) => n._id),
      );
      assert.sameMembers(
        live.edges.map((e) => e._id),
        target.edges.map((e) => e._id),
      );
    });

    it("records one version for a burst of resets and restores by one person", async () => {
      await sticky(member, { x: 0, y: 0 });
      const version = await versionAfter(() =>
        sticky(member, { x: 400, y: 0 }),
      );
      await restoreVersion(member, boardId, version._id);
      const recorded = (await versions()).length;
      const size = (await versions()).reduce((sum, v) => sum + v.size, 0);

      for (let i = 0; i < 3; i++) {
        await restoreVersion(member, boardId, version._id);
      }
      await resetLayout(member, boardId, false);
      assert.lengthOf(await versions(), recorded);
      assert.equal(
        (await versions()).reduce((sum, v) => sum + v.size, 0),
        size,
      );

      // Someone else's records the board as they found it
      await restoreVersion(other, boardId, version._id);
      assert.lengthOf(await versions(), recorded + 1);
    });

    it("gives what it puts back a fresh updatedAt", async () => {
      const id = await sticky(member, { x: 0, y: 0 });
      const version = await versionAfter(() =>
        sticky(member, { x: 400, y: 0 }),
      );
      const stored = (await node(id))!.updatedAt;
      await deleteNodes(member, boardId, [id]);
      const before = new Date();

      await restoreVersion(member, boardId, version._id);

      const restored = (await node(id))!;
      assert.isAtLeast(restored.updatedAt.getTime(), before.getTime());
      assert.isAbove(restored.updatedAt.getTime(), stored.getTime());
    });

    // Runs a restore and then a reset, each of which loses the board's lock
    // to another server the moment `steal` is first called while it holds
    // it, and checks both refuse readably and leave the board and its
    // history as they were.
    const refusedWhenPreempted = async (
      stub: (steal: () => Promise<void>) => { mockRestore(): void },
    ) => {
      await sticky(member, { x: 0, y: 0 });
      await nextWindow();
      const moved = await sticky(member, { x: 400, y: 0 });
      const version = await newest();
      await upsertNodes(member, boardId, [
        { _id: moved, position: { x: 800, y: 800 } },
      ]);
      const before = await snapshot();

      const thief = lockThief(boardId);
      const stubbed = stub(thief.steal);
      try {
        await rejects(
          restoreVersion(member, boardId, version._id),
          /The board was busy; try again/,
        );
        assert.ok(thief.held);
        await thief.letGo();
        await rejects(
          resetLayout(member, boardId, false),
          /The board was busy; try again/,
        );
        assert.ok(thief.held);
      } finally {
        stubbed.mockRestore();
        await thief.letGo();
      }

      await assertUnchanged(before);
      assert.equal(
        await WhiteboardVersionChunks.find({ board: boardId }).countAsync(),
        before.versionIds.length,
      );
    };

    it("refuses readably, with nothing written, when another server takes the board's lock", async () => {
      const findBoard = Whiteboards.findOneAsync.bind(Whiteboards);
      await refusedWhenPreempted((steal) =>
        spyOnMethod(Whiteboards, "findOneAsync").mockImplementation(
          async (...args: Parameters<typeof findBoard>) => {
            await steal();
            return findBoard(...args);
          },
        ),
      );
    });

    it("takes away the version it recorded when the lock goes before the board is touched", async () => {
      const insert = WhiteboardVersions.insertAsync.bind(WhiteboardVersions);
      await refusedWhenPreempted((steal) =>
        spyOn(WhiteboardVersions, "insertAsync").mockImplementation(
          async (...args: Parameters<typeof insert>) => {
            const id = await insert(...args);
            await steal();
            return id;
          },
        ),
      );
    });

    it("records a restore version after planning and before writing", async () => {
      await sticky(member, { x: 0, y: 0 });
      const version = await versionAfter(() =>
        sticky(member, { x: 400, y: 0 }),
      );
      await sticky(member, { x: 800, y: 0 });
      const before = await board();

      await restoreVersion(other, boardId, version._id);

      const restore = await newest();
      assert.equal(restore.kind, "restore");
      assert.deepEqual(
        restore.users.map((u) => u.user),
        [other.user],
      );
      assert.deepEqual(restore.restoredFromAt, version.createdAt);
      const payload = await payloadOf(restore);
      assert.sameMembers(
        payload.nodes.map((n) => n._id),
        before.nodes.map((n) => n._id),
      );
      // The first edit after a restore records the restored board
      await sticky(other);
      const after = await newest();
      assert.equal(after.kind, "edits");
      assert.notEqual(after._id, restore._id);
    });

    it("records nothing when a restore is refused", async () => {
      const { nodes } = await board();
      const unreadable = await storeVersion(
        [{ ...nodes[0], type: "bogus" }],
        [],
      );
      const before = await versions();
      await rejects(
        quietly(() => restoreVersion(member, boardId, unreadable.versionId)),
        /older layout/,
      );
      // Nor does a version whose chunks don't unpack
      await WhiteboardVersionChunks.updateAsync(
        { version: unreadable.versionId },
        { $set: { data: new Uint8Array([1, 2, 3]) } },
      );
      await rejects(
        quietly(() => restoreVersion(member, boardId, unreadable.versionId)),
        /older layout/,
      );
      assert.lengthOf(await versions(), before.length);
      assert.sameMembers(
        (await board()).nodes.map((n) => n._id),
        nodes.map((n) => n._id),
      );
      await rejects(
        restoreVersion(member, boardId, Random.id()),
        /Unknown version/,
      );
    });

    it("records nothing when a version has more on it than a board can hold", async () => {
      const template = (await node(await sticky(member)))!;
      const crowded = await storeVersion(
        Array.from({ length: MAX_NODES_PER_BOARD + 1 }, () => ({
          ...template,
          _id: Random.id(),
        })),
        [],
      );
      const before = await snapshot();
      await rejects(
        restoreVersion(member, boardId, crowded.versionId),
        /more on it than a board can hold/,
      );
      await assertUnchanged(before);
    });

    it("records nothing when a version has more drawing on it than a board can hold", async () => {
      const stroke = zigzag(3, inkAt);
      await upsertNodes(member, boardId, [stroke]);
      const template = (await node(stroke._id))!;
      const inky = await storeVersion(
        [{ ...template, points: zigzag(MAX_INK_POINTS_PER_BOARD + 1).points }],
        [],
      );
      const before = await snapshot();
      await rejects(
        restoreVersion(member, boardId, inky.versionId),
        /more drawing on it than a board can hold/,
      );
      await assertUnchanged(before);
    });

    it("restores a version with less drawing on a board already past the budget", async () => {
      const stroke = zigzag(10, inkAt);
      await upsertNodes(member, boardId, [stroke]);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [stroke._id]),
      );
      // Ink from before there was a budget
      const heavy = await fillInk(boardId, -10, member.user);

      await restoreVersion(member, boardId, version._id);
      assert.ok(await node(stroke._id));
      assert.notOk(await node(heavy));
    });

    it("refuses a version from another board", async () => {
      const { otherBoard, version: foreign } = await foreignVersion();
      const otherNodes = await WhiteboardNodes.find({
        board: otherBoard,
      }).fetchAsync();

      await rejects(
        call("fetchVersion", member, boardId, {
          versionId: foreign._id,
          index: 0,
        }),
        /Unknown version/,
      );
      await rejects(restoreAs(member, foreign._id), /Unknown version/);
      assert.sameDeepMembers(
        await WhiteboardNodes.find({ board: otherBoard }).fetchAsync(),
        otherNodes,
      );
      assert.lengthOf(
        await WhiteboardVersions.find({ board: otherBoard }).fetchAsync(),
        1,
      );
    });

    it("refuses restore without edit access, on an archived hunt, and with history off", async () => {
      const id = await sticky(member);
      const version = await newest();
      await call("setEditPolicy", operator, boardId, {
        editPolicy: "operators",
        editors: [],
      });
      await rejects(restoreAs(member, version._id), /Only operators/);
      await rejects(restoreVersion(outsider, boardId, version._id), /member/);
      await rejects(
        restoreVersion(archived(operator), boardId, version._id),
        /archived/,
      );

      await setFlag("disable.whiteboard_versions");
      await rejects(
        restoreVersion(operator, boardId, version._id),
        /history is turned off/,
      );
      assert.ok(await node(id));
      assert.lengthOf(await versions(), 1);
    });
  });

  describe("restoring items", () => {
    const frame = async (position: { x: number; y: number }) => {
      const _id = Random.id();
      await upsertNodes(member, boardId, [
        { _id, type: "frame", position, width: 3000, height: 3000 },
      ]);
      return _id;
    };
    const stickiesIn = async (parent: string, count: number) => {
      const ids = Array.from({ length: count }, () => Random.id());
      await upsertNodes(
        member,
        boardId,
        ids.map((_id, i) => ({
          _id,
          type: "sticky" as const,
          parent,
          position: {
            x: 24 + (i % 10) * 200,
            y: 64 + Math.floor(i / 10) * 200,
          },
        })),
      );
      return ids;
    };

    it("restores one deleted sticky from a version", async () => {
      const gone = await sticky(member, { x: 300, y: 40 });
      await upsertNodes(member, boardId, [{ _id: gone, text: "remember me" }]);
      const pin = await commentOn(gone, "on the sticky");
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [gone]),
      );
      assert.notOk(await node(gone));

      const changed = await restoreItemsAs(member, version._id, [gone]);

      assert.isTrue(changed.restored);
      const restored = (await node(gone))!;
      assert.deepEqual(restored.position, { x: 300, y: 40 });
      assert.equal(restored.text, "remember me");
      assert.deepEqual((await BoardComments.findOneAsync(pin))?.comment, {
        node: gone,
        x: 10,
        y: 20,
      });
    });

    it("changes nothing, and says so, for an item that's as the version has it", async () => {
      const id = await sticky(member, { x: 300, y: 40 });
      const version = await versionAfter(() =>
        sticky(member, { x: 900, y: 40 }),
      );
      const before = await snapshot();

      const changed = await restoreItemsAs(member, version._id, [id]);

      assert.isFalse(changed.restored);
      await assertUnchanged(before);
    });

    it("takes comments off a node it hides", async () => {
      // A deleted card is hidden, and a version can have it so
      const card = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
      }))!;
      await deleteNodes(member, boardId, [card._id]);
      const version = await versionAfter(() =>
        upsertNodes(member, boardId, [{ _id: card._id, hidden: false }]),
      );
      assert.notOk((await node(card._id))!.hidden);
      const pin = await commentOn(card._id, "on the shown card");

      assert.isTrue(
        await restoreItems(member, boardId, version._id, [card._id]),
      );

      assert.isTrue((await node(card._id))!.hidden);
      const comment = (await BoardComments.findOneAsync(pin))?.comment;
      assert.isUndefined(comment?.node);
      assert.equal(comment?.detachedFrom, card._id);
    });

    it("restores a frame and its children within the cap and refuses past it", async () => {
      const small = await frame({ x: 6000, y: 0 });
      const children = await stickiesIn(small, 3);
      const big = await frame({ x: 12000, y: 0 });
      const crowd = await stickiesIn(big, MAX_BATCH);
      const version = await versionAfter(() =>
        upsertNodes(member, boardId, [
          { _id: children[0]!, parent: null, position: { x: 9000, y: 9000 } },
        ]),
      );
      await deleteNodes(member, boardId, [small, big]);
      assert.notOk(await node(small));

      await restoreItems(member, boardId, version._id, [small]);

      assert.ok(await node(small));
      for (const [i, id] of children.entries()) {
        const child = (await node(id))!;
        assert.equal(child.parent, small);
        assert.deepEqual(child.position, { x: 24 + i * 200, y: 64 });
      }

      const before = await snapshot();
      await rejects(
        restoreItems(member, boardId, version._id, [big]),
        /too much to restore at once/,
      );
      assert.notOk(await node(big));
      await assertUnchanged(before);
      assert.lengthOf(crowd, MAX_BATCH);
    });

    it("leaves live documents outside the set alone", async () => {
      const round = await frame({ x: 6000, y: 0 });
      const [inside] = await stickiesIn(round, 1);
      const outside = await sticky(member, { x: 0, y: 6000 });
      const version = await versionAfter(() =>
        upsertNodes(member, boardId, [
          { _id: inside!, parent: null, position: { x: 9000, y: 9000 } },
          { _id: outside, position: { x: 100, y: 7000 } },
        ]),
      );
      // Added since: a sticky in the frame and a line to it
      const [added] = await stickiesIn(round, 1);
      await upsertNodes(member, boardId, [
        { _id: added!, position: { x: 1200, y: 1200 } },
      ]);
      const line = Random.id();
      await upsertEdges(member, boardId, [
        { _id: line, source: added!, target: outside },
      ]);
      const before = await board();

      await restoreItems(member, boardId, version._id, [round]);

      const after = await board();
      assert.includeMembers(
        after.nodes.map((n) => n._id),
        before.nodes.map((n) => n._id),
      );
      assert.includeMembers(
        after.edges.map((e) => e._id),
        before.edges.map((e) => e._id),
      );
      assert.equal((await node(inside!))!.parent, round);
      const stillAdded = (await node(added!))!;
      assert.equal(stillAdded.parent, round);
      assert.deepEqual(stillAdded.position, { x: 1200, y: 1200 });
      assert.deepEqual((await node(outside))!.position, {
        x: 100,
        y: 7000,
      });
    });

    it("updates a live card whose stored id changed instead of inserting a duplicate", async () => {
      const card = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
      }))!;
      const version = await versionAfter(() => sticky(member));

      // The card is replaced by another for the same puzzle, somewhere else
      await WhiteboardNodes.removeAsync(card._id);
      const replacement = await WhiteboardNodes.insertAsync({
        hunt: huntId,
        board: boardId,
        type: "puzzle",
        puzzle: card.puzzle,
        position: { x: 9000, y: 9000 },
        manual: true,
        createdBy: operator.user,
      });

      await restoreItems(member, boardId, version._id, [card._id]);

      const cards = await WhiteboardNodes.find({
        board: boardId,
        puzzle: card.puzzle,
      }).fetchAsync();
      assert.lengthOf(cards, 1);
      assert.equal(cards[0]!._id, replacement);
      assert.deepEqual(cards[0]!.position, card.position);
      assert.equal(cards[0]!.parent, card.parent);
      assert.isUndefined(cards[0]!.manual);
    });

    it("doesn't put back a deleted puzzle's card", async () => {
      const card = await firstCard();
      const version = await versionAfter(() => sticky(member));
      await deletePuzzle(card.puzzle!);

      await restoreItems(member, boardId, version._id, [card._id]);

      const after = (await node(card._id))!;
      assert.isTrue(after.hidden);
      assert.isTrue(after.hiddenWithPuzzle);
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          puzzle: card.puzzle,
        }).countAsync(),
        1,
      );
    });

    it("refuses without edit access, on an archived hunt and with history off", async () => {
      const id = await sticky(member);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [id]),
      );
      await call("setEditPolicy", operator, boardId, {
        editPolicy: "operators",
        editors: [],
      });
      await rejects(
        restoreItemsAs(member, version._id, [id]),
        /Only operators/,
      );
      await rejects(
        restoreItems(outsider, boardId, version._id, [id]),
        /member/,
      );
      await rejects(
        restoreItems(operator, boardId, Random.id(), [id]),
        /Unknown version/,
      );
      await rejects(
        restoreItems(operator, boardId, version._id, [Random.id()]),
        /isn't in this version/,
      );
      await rejects(
        restoreItems(operator, boardId, version._id, []),
        /Nothing to restore/,
      );
      await rejects(
        restoreItems(
          operator,
          boardId,
          version._id,
          Array.from({ length: MAX_BATCH + 1 }, () => id),
        ),
        /Too many nodes/,
      );
      await rejects(
        restoreItems(archived(operator), boardId, version._id, [id]),
        /archived/,
      );

      await setFlag("disable.whiteboard_versions");
      await rejects(
        restoreItems(operator, boardId, version._id, [id]),
        /history is turned off/,
      );
      assert.notOk(await node(id));
      assert.lengthOf(await versions(), 2);
    });

    it("refuses a version from another board", async () => {
      const { version: foreign, note: foreignSticky } = await foreignVersion();
      const before = await snapshot();

      await rejects(
        restoreItems(operator, boardId, foreign._id, [foreignSticky]),
        /Unknown version/,
      );
      await assertUnchanged(before);
    });

    it("records an edits version, not a restore one, and leaves lastRewrittenAt unset", async () => {
      const id = await sticky(member);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [id]),
      );
      await nextWindow();

      await restoreItems(other, boardId, version._id, [id]);

      const recorded = await newest();
      assert.notEqual(recorded._id, version._id);
      assert.equal(recorded.kind, "edits");
      assert.deepEqual(
        recorded.users.map((u) => u.user),
        [other.user],
      );
      const payload = await payloadOf(recorded);
      assert.notInclude(
        payload.nodes.map((n) => n._id),
        id,
      );
      assert.isUndefined(
        (await Whiteboards.findOneAsync(boardId))?.lastRewrittenAt,
      );

      // It coalesces with the same person's next edit
      await sticky(other);
      const after = await newest();
      assert.equal(after._id, recorded._id);
      assert.equal(after.changeCount, 2);
    });

    it("records no version when there's nothing to restore", async () => {
      const id = await sticky(member, { x: 300, y: 40 });
      const version = await versionAfter(() =>
        sticky(member, { x: 900, y: 40 }),
      );
      // Far enough on that any edit would start a version of its own
      await nextWindow();
      const before = (await versions()).map((v) => [v._id, v.changeCount]);

      const restored = await restoreItems(member, boardId, version._id, [id]);

      assert.isFalse(restored);
      assert.sameDeepMembers(
        (await versions()).map((v) => [v._id, v.changeCount]),
        before,
      );
    });

    it("refuses to put back ink the board has no room for", async () => {
      const stroke = zigzag(20, inkAt);
      await upsertNodes(member, boardId, [stroke]);
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [stroke._id]),
      );
      await fillInk(boardId, 10, member.user);

      await rejects(
        restoreItems(member, boardId, version._id, [stroke._id]),
        /as much drawing as it can hold/,
      );
      assert.notOk(await node(stroke._id));
    });

    it("restores every segment of an ink stroke from one of them", async () => {
      const stroke = Random.id();
      const segments = [Random.id(), Random.id()];
      await upsertNodes(
        member,
        boardId,
        segments.map((_id, i) => ({
          _id,
          type: "ink" as const,
          position: { x: 400 + i * 50, y: 400 },
          width: 50,
          height: 10,
          points: [
            [0, 0, 0.5],
            [50, 10, 0.5],
          ],
          strokeWidth: "medium" as const,
          stroke,
        })),
      );
      const version = await versionAfter(() =>
        deleteNodes(member, boardId, [segments[0]!]),
      );
      assert.equal(
        await WhiteboardNodes.find({ _id: { $in: segments } }).countAsync(),
        0,
      );

      const restored = await restoreItems(member, boardId, version._id, [
        segments[1]!,
      ]);

      assert.isTrue(restored);
      const back = await WhiteboardNodes.find({
        _id: { $in: segments },
      }).fetchAsync();
      assert.sameMembers(
        back.map((n) => n._id),
        segments,
      );
      assert.isTrue(back.every((n) => n.stroke === stroke));
    });
  });

  describe("pruneWhiteboardVersions", () => {
    const HOUR = 60 * MINUTE;
    // An hour boundary well in the past, so the test doesn't straddle one
    const now = new Date(Math.floor(Date.now() / HOUR) * HOUR + 30 * MINUTE);

    const fake = async (createdAt: Date, kind: "edits" | "reset" = "edits") => {
      const _id = await WhiteboardVersions.insertAsync({
        hunt: huntId,
        board: boardId,
        kind,
        users: [{ user: member.user, at: createdAt }],
        changeCount: 1,
        lastEditAt: createdAt,
        nodeCount: 0,
        edgeCount: 0,
        size: 10,
        chunkCount: 1,
        format: 1,
        hash: "0".repeat(64),
        createdAt,
        createdBy: member.user,
      });
      await WhiteboardVersionChunks.insertAsync({
        hunt: huntId,
        board: boardId,
        version: _id,
        index: 0,
        data: new Uint8Array([1]),
        createdAt,
      });
      return _id;
    };

    it("prunes old versions per the rules", async () => {
      const hourAgo = (h: number, m = 0) =>
        new Date(now.getTime() - 30 * MINUTE - h * HOUR + m * MINUTE);
      const recent = await fake(new Date(now.getTime() - 15 * MINUTE));
      const firstOfHour = await fake(hourAgo(3, 0));
      const laterInHour = await fake(hourAgo(3, 20));
      const reset = await fake(hourAgo(3, 40), "reset");

      const sizes = await pruneWhiteboardVersions(now);

      const left = (await versions()).map((v) => v._id);
      assert.sameMembers(left, [recent, firstOfHour, reset]);
      assert.equal(
        await WhiteboardVersionChunks.find({
          version: laterInHour,
        }).countAsync(),
        0,
      );
      assert.equal(sizes.get(boardId), 30);
      assert.deepEqual(
        (await Whiteboards.findOneAsync(boardId))?.versionsPrunedBefore,
        hourAgo(3, 20),
      );

      // Once the hunt is archived, only the newest ten (and resets) stay
      const more = [];
      for (let i = 1; i <= 12; i++) {
        more.push(await fake(new Date(now.getTime() - i * MINUTE)));
      }
      await Whiteboards.updateAsync(boardId, { $set: { archived: true } });
      await pruneWhiteboardVersions(now);
      assert.sameMembers(
        (await versions()).map((v) => v._id),
        [...more.slice(0, 10), reset],
      );
    });

    it("sweeps headerless chunks older than an hour and keeps newer ones", async () => {
      const real = await fake(new Date(now.getTime() - 10 * MINUTE));
      const orphan = async (age: number) => {
        const version = Random.id();
        await WhiteboardVersionChunks.insertAsync({
          hunt: huntId,
          board: boardId,
          version,
          index: 0,
          data: new Uint8Array([1]),
          createdAt: new Date(now.getTime() - age),
        });
        return version;
      };
      const old = await orphan(2 * HOUR);
      const fresh = await orphan(10 * MINUTE);

      await pruneWhiteboardVersions(now);

      const left = await WhiteboardVersionChunks.find({}).fetchAsync();
      assert.sameMembers(
        left.map((c) => c.version),
        [real, fresh],
      );
      assert.notInclude(
        left.map((c) => c.version),
        old,
      );
    });
  });
});
