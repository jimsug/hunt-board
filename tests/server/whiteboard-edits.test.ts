import { afterAll, beforeAll, beforeEach, describe, it, spyOn } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { ServiceError } from "lib/compat/error";
import { Random } from "lib/compat/random";
import Puzzles from "lib/models/Puzzles";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import type { WhiteboardNodeInput } from "lib/protocol";
import { POINT_SIZE } from "lib/whiteboard/layout";
import {
  MAX_BATCH,
  MAX_EDGES_PER_BOARD,
  MAX_FRAME_DEPTH,
  MAX_IMAGES_PER_BOARD,
  MAX_NODES_PER_BOARD,
} from "lib/whiteboard/limits";
import Locks from "../../server/models/Locks";
import WhiteboardVersionChunks from "../../server/models/WhiteboardVersionChunks";
import { ensureBoard } from "../../server/whiteboard";
import {
  deleteEdges,
  deleteNodes,
  upsertEdges,
  upsertNodes,
} from "../../server/whiteboardEdits";
import {
  fillInk,
  IMAGE_BUCKET,
  inBucket,
  lockThief,
  uploadUrl,
  withImageBucket,
  withoutImageBucket,
  zigzag,
} from "./fixtures";
import {
  archived,
  call,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setUpDatabase,
  spyOnMethod,
  tearDownDatabase,
} from "./harness";

describe("whiteboard edits", () => {
  let operator: Claims;
  let member: Claims;
  let outsider: Claims;
  let boardId: string;

  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  beforeEach(async () => {
    await resetDatabase();
    withoutImageBucket();
    operator = makeUser(true);
    member = makeUser();
    outsider = { ...makeUser(), scope: { hunt: Random.id() } };
    await makeFixtureHunt(operator.user);
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
  });

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
  // Through the method, so its argument check applies
  const upsertViaMethod = (claims: Claims, nodes: unknown[]) =>
    call("upsertNodes", claims, boardId, { nodes });
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

  describe("edits", () => {
    it("records who made and edited a sticky, but not who moved it", async () => {
      const _id = await addSticky(member, { x: 0, y: 0 }, { text: "hello" });
      await upsertNodes(operator, boardId, [{ _id, text: "hello there" }]);
      await upsertNodes(member, boardId, [{ _id, position: { x: 50, y: 50 } }]);

      const sticky = (await node(_id))!;
      assert.deepEqual(
        sticky.contributors.map((c) => c.user),
        [member.user, operator.user],
      );
      assert.equal(sticky.text, "hello there");
      assert.equal(sticky.createdBy, member.user);
    });

    it("clears a node's colour when sent null", async () => {
      const _id = Random.id();
      await upsertNodes(member, boardId, [
        { _id, type: "text", position: { x: 0, y: 0 }, color: "red" },
      ]);
      await upsertNodes(member, boardId, [{ _id, color: null }]);
      const text = (await node(_id))!;
      assert.isUndefined(text.color);
      assert.lengthOf(text.contributors, 2);
    });

    it("ignores contributors sent by the client", async () => {
      const _id = Random.id();
      await upsertNodes(member, boardId, [
        {
          ...stickyInput(0, 0, { _id }),
          contributors: [{ user: outsider.user, at: new Date() }],
        } as never,
      ]);
      const sticky = (await node(_id))!;
      assert.deepEqual(
        sticky.contributors.map((c) => c.user),
        [member.user],
      );
      await rejects(
        upsertViaMethod(member, [
          { _id, contributors: [{ user: outsider.user, at: new Date() }] },
        ]),
        /Unknown key/,
      );
    });

    it("caps the contributor log at 50", async () => {
      const _id = await addSticky(member, { x: 0, y: 0 }, { text: "0" });
      for (let i = 1; i <= 55; i++) {
        await upsertNodes(member, boardId, [{ _id, text: `${i}` }]);
      }
      const sticky = (await node(_id))!;
      assert.lengthOf(sticky.contributors, 50);
      // The creator is never dropped.
      assert.equal(sticky.contributors[0]!.user, member.user);
    });

    it("applies nothing from a batch that refers to a missing node", async () => {
      const kept = Random.id();
      await rejects(
        upsertNodes(member, boardId, [
          stickyInput(0, 0, { _id: kept }),
          { _id: Random.id(), text: "edit to a node that's gone" },
        ]),
        /type and a position/,
      );
      assert.notOk(await node(kept));
    });

    it("rejects people outside the hunt", async () => {
      await rejects(
        upsertNodes(outsider, boardId, [stickyInput(0, 0)]),
        /member/,
      );
      await rejects(deleteNodes(outsider, boardId, []), /member/);
      await rejects(upsertEdges(outsider, boardId, []), /member/);
      await rejects(deleteEdges(outsider, boardId, []), /member/);
    });

    it("rejects edits in an archived hunt", async () => {
      await rejects(
        upsertNodes(archived(member), boardId, [stickyInput(0, 0)]),
        /archived/,
      );
      await rejects(deleteNodes(archived(operator), boardId, []), /archived/);
    });

    it("rejects nodes from another board", async () => {
      const _id = await WhiteboardNodes.insertAsync({
        hunt: huntId,
        board: Random.id(),
        type: "sticky",
        position: { x: 0, y: 0 },
        createdBy: member.user,
      });
      await rejects(
        upsertNodes(member, boardId, [{ _id, text: "hijack" }]),
        /another board/,
      );
      await deleteNodes(member, boardId, [_id]);
      assert.ok(await node(_id));
    });

    it("only puts this hunt's puzzles on the board", async () => {
      const elsewhere = await Puzzles.insertAsync({
        hunt: Random.id(),
        title: "Another hunt's",
        tags: [],
        answers: [],
        expectedAnswerCount: 1,
        createdBy: operator.user,
      });
      // Jolly Roger's own board puzzle, should the feed carry it
      const backing = await Puzzles.insertAsync({
        hunt: huntId,
        title: "Whiteboard",
        tags: [],
        answers: [],
        expectedAnswerCount: 0,
        kind: "whiteboard",
        createdBy: operator.user,
      });
      for (const puzzle of [elsewhere, backing]) {
        await rejects(
          upsertNodes(member, boardId, [
            {
              _id: Random.id(),
              type: "puzzle",
              puzzle,
              position: { x: 0, y: 0 },
            },
          ]),
          /Unknown puzzle/,
        );
      }
    });

    it("rejects out-of-range and oversized input", async () => {
      const sticky = stickyInput(0, 0);
      await rejects(
        upsertNodes(member, boardId, [
          { ...sticky, position: { x: 1e9, y: 0 } },
        ]),
        /out of range/,
      );
      await rejects(
        upsertNodes(member, boardId, [
          { ...sticky, position: { x: Number.NaN, y: 0 } },
        ]),
        /out of range/,
      );
      await rejects(
        upsertNodes(member, boardId, [
          { ...sticky, position: { x: 0, y: 0 }, width: 1e9 },
        ]),
        /Size out of range/,
      );
      await rejects(
        upsertNodes(member, boardId, [
          { ...sticky, position: { x: 0, y: 0 }, text: "x".repeat(2001) },
        ]),
        /too long/,
      );
      await rejects(
        upsertNodes(member, boardId, [
          {
            _id: Random.id(),
            type: "ink",
            position: { x: 0, y: 0 },
            strokeWidth: "thin",
            points: Array.from({ length: 501 }, (_, i) => [i, 0, 0.5]),
          },
        ]),
        /too many/,
      );
      await rejects(
        upsertNodes(member, boardId, [{ ...sticky, _id: "not an id!" }]),
        /Invalid node id/,
      );
      // Through the method, the schema refuses a point with the wrong arity
      await rejects(
        upsertViaMethod(member, [
          {
            _id: Random.id(),
            type: "ink",
            position: { x: 0, y: 0 },
            strokeWidth: "thin",
            points: [[1, 2]],
          },
        ]),
        /Match error/,
      );
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          type: { $in: ["sticky", "ink"] },
        }).countAsync(),
        0,
      );
    });

    it("caps the batch size and the size of a board", async () => {
      await rejects(
        upsertNodes(
          member,
          boardId,
          Array.from({ length: MAX_BATCH + 1 }, () => stickyInput(0, 0)),
        ),
        /Too many nodes/,
      );

      await fillNodesToCap(0);
      await rejects(
        upsertNodes(member, boardId, [stickyInput(0, 0)]),
        /board is full/,
      );
    });

    it("hides puzzle cards and seeded frames, and removes the rest", async () => {
      const card = (await WhiteboardNodes.findOneAsync({
        board: boardId,
        type: "puzzle",
        parent: { $exists: true },
      }))!;
      const seededFrame = (await WhiteboardNodes.findOneAsync(card.parent))!;
      const sticky = await addSticky(member, { x: 0, y: 0 });

      await deleteNodes(member, boardId, [card._id, sticky]);
      assert.isTrue((await node(card._id))?.hidden);
      assert.notOk(await node(sticky));

      await deleteNodes(member, boardId, [seededFrame._id]);
      assert.isTrue((await node(seededFrame._id))?.hidden);
      // Its cards moved out of it, keeping their place on the board
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          parent: seededFrame._id,
        }).countAsync(),
        0,
      );
      const freed = (await node(card._id))!;
      assert.equal(freed.parent, seededFrame.parent);
      assert.deepEqual(freed.position, {
        x: card.position.x + seededFrame.position.x,
        y: card.position.y + seededFrame.position.y,
      });

      // Feeder arrows are hidden; drawn lines go
      const auto = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      const a = Random.id();
      const b = Random.id();
      await upsertNodes(member, boardId, [
        stickyInput(0, 0, { _id: a }),
        stickyInput(300, 0, { _id: b }),
      ]);
      const drawn = Random.id();
      await upsertEdges(member, boardId, [
        { _id: drawn, source: a, target: b },
      ]);
      await deleteEdges(member, boardId, [auto._id, drawn]);
      assert.isTrue((await edge(auto._id))?.hidden);
      assert.notOk(await edge(drawn));
    });

    it("keeps a deleted frame's contents where they were", async () => {
      const frame = Random.id();
      await upsertNodes(member, boardId, [
        {
          _id: frame,
          type: "frame",
          position: { x: 100, y: 100 },
          width: 500,
          height: 500,
        },
      ]);
      const sticky = await addSticky(
        member,
        { x: 10, y: 20 },
        { parent: frame },
      );
      await deleteNodes(member, boardId, [frame]);

      assert.notOk(await node(frame));
      const moved = (await node(sticky))!;
      assert.notOk(moved.parent);
      assert.deepEqual(moved.position, { x: 110, y: 120 });
    });

    it("moves a nested frame's contents into the frame around it", async () => {
      const outer = Random.id();
      const inner = Random.id();
      await upsertNodes(member, boardId, [
        { _id: outer, type: "frame", position: { x: 100, y: 100 } },
      ]);
      await upsertNodes(member, boardId, [
        {
          _id: inner,
          type: "frame",
          position: { x: 30, y: 40 },
          parent: outer,
        },
      ]);
      const sticky = await addSticky(member, { x: 5, y: 6 }, { parent: inner });
      await deleteNodes(member, boardId, [inner]);
      const moved = (await node(sticky))!;
      assert.equal(moved.parent, outer);
      assert.deepEqual(moved.position, { x: 35, y: 46 });
    });

    it("won't put a frame inside itself", async () => {
      const outer = Random.id();
      const inner = Random.id();
      await upsertNodes(member, boardId, [
        { _id: outer, type: "frame", position: { x: 0, y: 0 } },
      ]);
      await upsertNodes(member, boardId, [
        { _id: inner, type: "frame", position: { x: 0, y: 0 }, parent: outer },
      ]);
      await rejects(
        upsertNodes(member, boardId, [{ _id: outer, parent: inner }]),
        /itself/,
      );
    });

    it("won't nest anything more than MAX_FRAME_DEPTH frames deep", async () => {
      const chain = Array.from({ length: MAX_FRAME_DEPTH }, () => Random.id());
      await upsertNodes(
        member,
        boardId,
        chain.map((_id, i) => ({
          _id,
          type: "frame" as const,
          position: { x: 0, y: 0 },
          parent: chain[i - 1],
        })),
      );
      const deepest = chain.at(-1)!;
      const inner = Random.id();
      await upsertNodes(member, boardId, [
        {
          _id: inner,
          type: "frame",
          position: { x: 0, y: 0 },
          parent: deepest,
        },
      ]);
      await rejects(
        upsertNodes(member, boardId, [stickyInput(0, 0, { parent: inner })]),
        /nested/,
      );

      // Wrapping the chain in one more frame would push its far end too deep
      const wrapper = Random.id();
      await upsertNodes(member, boardId, [
        { _id: wrapper, type: "frame", position: { x: 0, y: 0 } },
      ]);
      await rejects(
        upsertNodes(member, boardId, [{ _id: chain[0]!, parent: wrapper }]),
        /nested/,
      );
      assert.notOk((await WhiteboardNodes.findOneAsync(chain[0]))?.parent);
    });

    it("takes back a frame move that closes a loop with a concurrent one", async () => {
      const a = Random.id();
      const b = Random.id();
      await upsertNodes(member, boardId, [
        { _id: a, type: "frame", position: { x: 0, y: 0 } },
        { _id: b, type: "frame", position: { x: 500, y: 0 } },
      ]);
      // Another tab's move of b into a lands after this call has checked a's
      // new parent, but before its own write.
      const update = WhiteboardNodes.updateAsync.bind(WhiteboardNodes);
      const stub = spyOn(WhiteboardNodes, "updateAsync").mockImplementation(
        update,
      );
      stub.mockImplementationOnce(async (...args) => {
        await update(b, { $set: { parent: a } });
        return update(...args);
      });
      try {
        await rejects(
          upsertNodes(member, boardId, [
            { _id: a, parent: b, position: { x: 10, y: 10 } },
          ]),
          /itself/,
        );
      } finally {
        stub.mockRestore();
      }
      const saved = (await node(a))!;
      assert.notOk(saved.parent);
      assert.deepEqual(saved.position, { x: 0, y: 0 });
    });

    it("deletes a whole ink stroke when one segment goes", async () => {
      const stroke = Random.id();
      const segment = (x: number) => ({
        _id: Random.id(),
        type: "ink" as const,
        position: { x, y: 0 },
        strokeWidth: "thin" as const,
        stroke,
        points: [
          [0, 0, 0.5],
          [1, 1, 0.5],
        ] as [number, number, number][],
      });
      const a = segment(0);
      const b = segment(10);
      await upsertNodes(member, boardId, [a, b]);
      assert.deepEqual(
        (await node(a._id))?.contributors.map((c) => c.user),
        [member.user],
      );
      await deleteNodes(member, boardId, [a._id]);
      assert.equal(
        await WhiteboardNodes.find({ board: boardId, stroke }).countAsync(),
        0,
      );
    });

    describe("ink budget", () => {
      it("stores a new stroke simplified, keeping its ends and its pressure", async () => {
        const straight = {
          ...zigzag(0),
          points: Array.from(
            { length: 100 },
            (_, i): [number, number, number] => [i * 2, 10, i === 99 ? 1 : 0.2],
          ),
        };
        const bent = zigzag(10);
        await upsertNodes(member, boardId, [straight, bent]);
        assert.deepEqual((await node(straight._id))?.points, [
          [0, 10, 0.2],
          [198, 10, 1],
        ]);
        assert.deepEqual((await node(bent._id))?.points, bent.points);
      });

      it("refuses a whole batch that would take the board past its ink budget", async () => {
        await fillInk(boardId, 15, member.user);
        const note = stickyInput(0, 0);
        const stroke = zigzag(20);
        await rejects(
          upsertViaMethod(member, [note, stroke]),
          /as much drawing as it can hold/,
        );
        assert.notOk(await node(note._id));
        assert.notOk(await node(stroke._id));

        // What's left fits, counted once simplified
        const long = {
          ...zigzag(0),
          points: Array.from(
            { length: 300 },
            (_, i): [number, number, number] => [i, 0, 0.5],
          ),
        };
        await upsertNodes(member, boardId, [zigzag(10), long, note]);
        assert.ok(await node(long._id));
        // Anything but ink still goes on a board with no ink to spare
        await upsertNodes(member, boardId, [stickyInput(0, 0)]);
        await upsertNodes(member, boardId, [
          { _id: note._id, position: { x: 50, y: 50 } },
        ]);
        await rejects(
          upsertNodes(member, boardId, [zigzag(4)]),
          /as much drawing as it can hold/,
        );
      });

      it("stores a highlighter stroke and counts it like any other", async () => {
        await fillInk(boardId, 15, member.user);
        const marker = { ...zigzag(20), strokeWidth: "marker" as const };
        await rejects(
          upsertViaMethod(member, [marker]),
          /as much drawing as it can hold/,
        );
        assert.notOk(await node(marker._id));

        const fits = { ...zigzag(10), strokeWidth: "marker" as const };
        await upsertViaMethod(member, [fits]);
        const stored = (await node(fits._id))!;
        assert.equal(stored.strokeWidth, "marker");
        assert.deepEqual(stored.points, fits.points);
        await rejects(
          upsertNodes(member, boardId, [
            { ...zigzag(6), strokeWidth: "marker" },
          ]),
          /as much drawing as it can hold/,
        );
      });
    });

    it("only joins nodes on the same board with arrows", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      await rejects(
        upsertEdges(member, boardId, [
          { _id: Random.id(), source: a, target: Random.id() },
        ]),
        /this board/,
      );
    });

    it("keeps feeder arrows on their tags", async () => {
      const auto = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      const sticky = await addSticky(member, { x: 0, y: 0 });
      await rejects(
        upsertEdges(member, boardId, [{ _id: auto._id, target: sticky }]),
        /follow their tags/,
      );
      // Restyling one is fine, and isn't attributed to anyone
      await upsertEdges(member, boardId, [{ _id: auto._id, dashed: true }]);
      const saved = (await edge(auto._id))!;
      assert.isTrue(saved.dashed);
      assert.lengthOf(saved.contributors, 0);
    });

    it("puts back a hidden feeder arrow, and hides or unhides nothing else", async () => {
      const auto = (await WhiteboardEdges.findOneAsync({
        board: boardId,
        auto: true,
      }))!;
      await deleteEdges(member, boardId, [auto._id]);
      assert.isTrue((await edge(auto._id))?.hidden);

      // Hiding goes through deleteEdges, not here
      await rejects(
        call("upsertEdges", member, boardId, {
          edges: [{ _id: auto._id, hidden: true }],
        }),
        /Only a feeder arrow can be put back/,
      );

      const [a, b] = [Random.id(), Random.id()];
      await upsertNodes(member, boardId, [
        stickyInput(0, 0, { _id: a }),
        stickyInput(300, 0, { _id: b }),
      ]);
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: b }]);
      await rejects(
        upsertEdges(member, boardId, [{ _id: line, hidden: false }]),
        /Only a feeder arrow can be put back/,
      );
      await rejects(
        upsertEdges(member, boardId, [
          { _id: Random.id(), source: a, target: b, hidden: false },
        ]),
        /Only a feeder arrow can be put back/,
      );
      // A refused batch writes nothing
      await rejects(
        upsertEdges(member, boardId, [
          { _id: auto._id, hidden: false },
          { _id: line, hidden: false },
        ]),
        /Only a feeder arrow can be put back/,
      );
      assert.isTrue((await edge(auto._id))?.hidden);

      await call("upsertEdges", member, boardId, {
        edges: [{ _id: auto._id, hidden: false }],
      });
      const restored = (await edge(auto._id))!;
      assert.isUndefined(restored.hidden);
      assert.lengthOf(restored.contributors, 0);
    });

    describe("images", () => {
      // Where an upload for one of the hunt's puzzles would be
      const puzzleId = Random.id();
      const stored = () => uploadUrl(huntId, puzzleId);
      const imageInput = (url: string) => ({
        _id: Random.id(),
        type: "image" as const,
        position: { x: 10, y: 20 },
        width: 240,
        height: 120,
        image: { url, width: 800, height: 400 },
      });

      beforeEach(withImageBucket);

      it("takes an image uploaded for the board, with its size", async () => {
        const input = imageInput(stored());
        await upsertViaMethod(member, [input]);
        const node = (await WhiteboardNodes.findOneAsync(input._id))!;
        assert.equal(node.type, "image");
        assert.deepEqual(node.image, input.image);
        assert.equal(node.width, 240);
        assert.equal(node.height, 120);
        assert.deepEqual(
          node.contributors.map((c) => c.user),
          [member.user],
        );
      });

      it("refuses an image uploaded in another hunt, which purging that hunt would take", async () => {
        const input = imageInput(
          inBucket(`${Random.id()}/${Random.id()}/${Random.id()}`),
        );
        await rejects(
          upsertNodes(member, boardId, [input]),
          /That image isn't one we stored/,
        );
        assert.notOk(await node(input._id));
      });

      it("refuses an image from anywhere else", async () => {
        const elsewhere = [
          "https://example.com/cat.png",
          "data:image/png;base64,iVBORw0KGgo=",
          inBucket(`${puzzleId}/${Random.id()}`),
          inBucket(`chat/${puzzleId}/${Random.id()}`),
          inBucket(`${huntId}/${puzzleId}/${Random.id()}/more`),
          inBucket(`${huntId}/${puzzleId}/../${Random.id()}`),
          `https://s3.${IMAGE_BUCKET.bucketRegion}.amazonaws.com/another-bucket/${huntId}/${puzzleId}/${Random.id()}`,
        ];
        for (const url of elsewhere) {
          const input = imageInput(url);
          await rejects(
            upsertNodes(member, boardId, [input]),
            /That image isn't one we stored/,
          );
          assert.notOk(await node(input._id));
        }
      });

      it("refuses every image when there's no bucket", async () => {
        const url = stored();
        withoutImageBucket();
        await rejects(
          upsertNodes(member, boardId, [imageInput(url)]),
          /That image isn't one we stored/,
        );
      });

      it("needs an image and a size on an image node, and no image on anything else", async () => {
        const { image: _image, ...bare } = imageInput(stored());
        await rejects(
          upsertNodes(member, boardId, [bare]),
          /need an image and a size/,
        );
        const { width: _width, ...unsized } = imageInput(stored());
        await rejects(
          upsertNodes(member, boardId, [unsized]),
          /need an image and a size/,
        );
        await rejects(
          upsertNodes(member, boardId, [
            { ...imageInput(stored()), type: "sticky" },
          ]),
          /Only image nodes have an image/,
        );
      });

      it("caps the images on a board", async () => {
        await upsertNodes(
          member,
          boardId,
          Array.from({ length: MAX_IMAGES_PER_BOARD }, () =>
            imageInput(stored()),
          ),
        );
        const extra = imageInput(stored());
        await rejects(
          upsertNodes(member, boardId, [extra]),
          /can't take any more images/,
        );
        assert.notOk(await node(extra._id));
        // Other nodes still go in
        await upsertNodes(member, boardId, [stickyInput(0, 0)]);
      });

      it("never changes an image once it's on the board", async () => {
        const input = imageInput(stored());
        await upsertNodes(member, boardId, [input]);
        await rejects(
          upsertNodes(member, boardId, [
            { _id: input._id, image: { ...input.image, url: stored() } },
          ]),
          /An image can't be changed/,
        );
        await rejects(
          upsertNodes(member, boardId, [
            { _id: input._id, image: { ...input.image, width: 1 } },
          ]),
          /An image can't be changed/,
        );
        // The same image with a new size on the board is just a resize
        await upsertNodes(member, boardId, [
          { _id: input._id, image: input.image, width: 480, height: 240 },
        ]);
        const node = (await WhiteboardNodes.findOneAsync(input._id))!;
        assert.deepEqual(node.image, input.image);
        assert.equal(node.width, 480);

        const sticky = await addSticky(member, { x: 0, y: 0 });
        await rejects(
          upsertNodes(member, boardId, [{ _id: sticky, image: input.image }]),
          /Only image nodes have an image/,
        );
      });

      it("locks, and deletes without touching the upload", async () => {
        const input = imageInput(stored());
        await upsertNodes(member, boardId, [input]);
        await upsertNodes(member, boardId, [{ _id: input._id, locked: true }]);
        await rejects(
          upsertNodes(operator, boardId, [
            { _id: input._id, position: { x: 0, y: 0 } },
          ]),
          /locked/,
        );
        await upsertNodes(member, boardId, [{ _id: input._id, locked: false }]);
        await deleteNodes(member, boardId, [input._id]);
        assert.notOk(await node(input._id));
      });
    });

    describe("shapes", () => {
      const shapeInput = (shape: "rect" | "ellipse" = "rect") => ({
        _id: Random.id(),
        type: "shape" as const,
        position: { x: 10, y: 20 },
        width: 160,
        height: 120,
        shape,
      });

      it("takes a rectangle or an ellipse, with its size and colour", async () => {
        const rect = { ...shapeInput("rect"), color: "blue" as const };
        const ellipse = shapeInput("ellipse");
        await upsertViaMethod(member, [rect, ellipse]);
        const stored = (await node(rect._id))!;
        assert.equal(stored.type, "shape");
        assert.equal(stored.shape, "rect");
        assert.equal(stored.color, "blue");
        assert.equal(stored.width, 160);
        assert.equal(stored.height, 120);
        assert.deepEqual(
          stored.contributors.map((c) => c.user),
          [member.user],
        );
        const clear = (await node(ellipse._id))!;
        assert.equal(clear.shape, "ellipse");
        assert.isUndefined(clear.color);
      });

      it("refuses a shape it doesn't know, writing nothing", async () => {
        const note = stickyInput(0, 0);
        const star = { ...shapeInput(), shape: "star" as "rect" };
        await rejects(upsertViaMethod(member, [note, star]), /Match error/);
        await rejects(
          upsertNodes(member, boardId, [note, star]),
          /Unknown shape/,
        );
        assert.notOk(await node(note._id));
        assert.notOk(await node(star._id));
      });

      it("needs a shape and a size on a shape node, and no shape on anything else", async () => {
        const { shape: _shape, ...bare } = shapeInput();
        await rejects(
          upsertNodes(member, boardId, [bare]),
          /need a shape and a size/,
        );
        const { height: _height, ...unsized } = shapeInput();
        await rejects(
          upsertNodes(member, boardId, [unsized]),
          /need a shape and a size/,
        );
        await rejects(
          upsertNodes(member, boardId, [{ ...shapeInput(), type: "sticky" }]),
          /Only shape nodes have a shape/,
        );
      });

      it("never changes a shape once it's on the board", async () => {
        const input = shapeInput("rect");
        await upsertNodes(member, boardId, [input]);
        await rejects(
          upsertNodes(member, boardId, [{ _id: input._id, shape: "ellipse" }]),
          /A shape can't be changed/,
        );
        // The same shape alongside a resize and a new colour is fine
        await upsertNodes(member, boardId, [
          {
            _id: input._id,
            shape: "rect",
            width: 300,
            height: 40,
            color: "green",
          },
        ]);
        const node = (await WhiteboardNodes.findOneAsync(input._id))!;
        assert.equal(node.shape, "rect");
        assert.equal(node.width, 300);
        assert.equal(node.color, "green");

        const sticky = await addSticky(member, { x: 0, y: 0 });
        await rejects(
          upsertNodes(member, boardId, [{ _id: sticky, shape: "rect" }]),
          /Only shape nodes have a shape/,
        );
      });

      it("counts shapes within the node cap", async () => {
        await fillNodesToCap(0);
        await rejects(
          upsertNodes(member, boardId, [shapeInput()]),
          /This board is full/,
        );
      });

      it("locks, and is deleted outright", async () => {
        const input = shapeInput();
        await upsertNodes(member, boardId, [input]);
        await upsertNodes(member, boardId, [{ _id: input._id, locked: true }]);
        await rejects(
          upsertNodes(operator, boardId, [
            { _id: input._id, position: { x: 0, y: 0 } },
          ]),
          /locked/,
        );
        await upsertNodes(member, boardId, [{ _id: input._id, locked: false }]);
        await deleteNodes(member, boardId, [input._id]);
        assert.notOk(await node(input._id));
      });
    });

    describe("hard caps", () => {
      // Runs the batches while the test holds the board's lock, and lets
      // them have it only once each is queued for it, so every one has
      // passed its checks before any counts the board. whileQueued, if
      // given, runs once they're all waiting. Returns what each came to:
      // "accepted", or the error it was refused with.
      const raceForLock = async (
        batches: (() => Promise<unknown>)[],
        whileQueued?: () => Promise<unknown>,
      ) => {
        const lockName = `whiteboard:${boardId}`;
        const held = await Locks.insertAsync({ name: lockName });
        const insertLock = Locks.insertAsync.bind(Locks);
        let queued = 0;
        let allQueued!: () => void;
        const waiting = new Promise<void>((resolve) => {
          allQueued = resolve;
        });
        const stub = spyOn(Locks, "insertAsync").mockImplementation(
          (...args: Parameters<typeof insertLock>) => {
            if (args[0].name === lockName) {
              queued += 1;
              if (queued === batches.length) allQueued();
            }
            return insertLock(...args);
          },
        );
        try {
          const results = batches.map((batch) =>
            batch().then(
              () => "accepted",
              (error: unknown) => error,
            ),
          );
          await waiting;
          await whileQueued?.();
          await Locks.removeAsync(held);
          return await Promise.all(results);
        } finally {
          stub.mockRestore();
          await Locks.removeAsync(held);
        }
      };

      const accepted = (results: unknown[]) =>
        results.filter((r) => r === "accepted").length;
      const refusal = (results: unknown[]) =>
        (results.find((r) => r !== "accepted") as ServiceError).reason;

      it("lets only one of two batches that together pass the node cap in", async () => {
        await fillNodesToCap(1);
        const results = await raceForLock([
          () => upsertNodes(member, boardId, [stickyInput(0, 0)]),
          () => upsertNodes(operator, boardId, [stickyInput(0, 0)]),
        ]);
        assert.equal(accepted(results), 1);
        assert.match(refusal(results), /board is full/);
        assert.equal(
          await WhiteboardNodes.find({ board: boardId }).countAsync(),
          MAX_NODES_PER_BOARD,
        );
      });

      it("lets only one of two batches that together pass the ink budget in", async () => {
        await fillInk(boardId, 15, member.user);
        const strokes = [zigzag(10), zigzag(10)];
        const results = await raceForLock(
          strokes.map((s) => () => upsertNodes(member, boardId, [s])),
        );
        assert.equal(accepted(results), 1);
        assert.match(refusal(results), /as much drawing as it can hold/);
        assert.equal(
          await WhiteboardNodes.find({
            _id: { $in: strokes.map((s) => s._id) },
          }).countAsync(),
          1,
        );
      });

      it("lets only one of two batches that together pass the image cap in", async () => {
        withImageBucket();
        const puzzleId = Random.id();
        const image = () => ({
          _id: Random.id(),
          type: "image" as const,
          position: { x: 10, y: 20 },
          width: 240,
          height: 120,
          image: { url: uploadUrl(huntId, puzzleId), width: 800, height: 400 },
        });
        await WhiteboardNodes.insertManyAsync(
          Array.from({ length: MAX_IMAGES_PER_BOARD - 1 }, () => {
            const { _id: _ignored, ...doc } = image();
            return {
              ...doc,
              hunt: huntId,
              board: boardId,
              createdBy: member.user,
            };
          }),
        );
        const results = await raceForLock([
          () => upsertNodes(member, boardId, [image()]),
          () => upsertNodes(operator, boardId, [image()]),
        ]);
        assert.equal(accepted(results), 1);
        assert.match(refusal(results), /can't take any more images/);
        assert.equal(
          await WhiteboardNodes.find({
            board: boardId,
            type: "image",
          }).countAsync(),
          MAX_IMAGES_PER_BOARD,
        );
      });

      it("lets only one of two batches that together pass the line cap in", async () => {
        const [a, b] = [stickyInput(0, 0), stickyInput(0, 0)];
        await upsertNodes(member, boardId, [a, b]);
        await fillEdgesToCap(a._id, b._id, 1);
        const line = () => ({ _id: Random.id(), source: a._id, target: b._id });
        const results = await raceForLock([
          () => upsertEdges(member, boardId, [line()]),
          () => upsertEdges(operator, boardId, [line()]),
        ]);
        assert.equal(accepted(results), 1);
        assert.match(refusal(results), /too many arrows/);
        assert.equal(
          await WhiteboardEdges.find({ board: boardId }).countAsync(),
          MAX_EDGES_PER_BOARD,
        );
      });

      it("refuses readably, with nothing written, when another server takes the lock while it counts", async () => {
        // Another server takes the lock the moment this one counts the
        // board's nodes.
        const thief = lockThief(boardId);
        const find = WhiteboardNodes.find.bind(WhiteboardNodes);
        const stub = spyOnMethod(WhiteboardNodes, "find").mockImplementation(
          (...args: Parameters<typeof find>) => {
            const cursor = find(...args);
            const selector = args[0] as Record<string, unknown> | undefined;
            if (
              selector?.board === boardId &&
              Object.keys(selector).length === 1
            ) {
              const counted = cursor.countAsync.bind(cursor);
              cursor.countAsync = async () => {
                await thief.steal();
                return counted();
              };
            }
            return cursor;
          },
        );
        const note = stickyInput(0, 0);
        try {
          await rejects(
            upsertNodes(member, boardId, [note]),
            /The board was busy; try again/,
          );
          assert.ok(thief.held);
        } finally {
          stub.mockRestore();
          await thief.letGo();
        }
        assert.notOk(await node(note._id));
      });

      it("writes nothing from a batch whose last node has a bad parent, puzzle or loop", async () => {
        const frame = {
          _id: Random.id(),
          type: "frame" as const,
          position: { x: 0, y: 0 },
          width: 400,
          height: 400,
        };
        const moved = stickyInput(0, 0);
        await upsertNodes(member, boardId, [frame, moved]);
        const before = await WhiteboardNodes.find({
          board: boardId,
        }).fetchAsync();

        const fresh = stickyInput(0, 0);
        const tries: [WhiteboardNodeInput, RegExp][] = [
          [
            stickyInput(0, 0, { parent: moved._id }),
            /Parent must be a frame on this board/,
          ],
          [
            {
              _id: Random.id(),
              type: "puzzle",
              position: { x: 0, y: 0 },
              puzzle: Random.id(),
            },
            /Unknown puzzle/,
          ],
        ];
        for (const [last, error] of tries) {
          await rejects(
            upsertNodes(member, boardId, [
              fresh,
              { _id: moved._id, position: { x: 900, y: 900 } },
              last,
            ]),
            error,
          );
        }
        const inner = {
          _id: Random.id(),
          type: "frame" as const,
          position: { x: 10, y: 10 },
          width: 100,
          height: 100,
          parent: frame._id,
        };
        await rejects(
          upsertNodes(member, boardId, [
            fresh,
            inner,
            { _id: frame._id, parent: inner._id },
          ]),
          /A frame can't contain itself/,
        );
        assert.sameDeepMembers(
          await WhiteboardNodes.find({ board: boardId }).fetchAsync(),
          before,
        );
      });

      it("records no version for a batch the caps refuse", async () => {
        await fillNodesToCap(0);
        const versions = await WhiteboardVersions.find({
          board: boardId,
        }).countAsync();
        await rejects(
          upsertNodes(member, boardId, [stickyInput(0, 0)]),
          /board is full/,
        );
        assert.equal(
          await WhiteboardVersions.find({ board: boardId }).countAsync(),
          versions,
        );
      });

      it("takes back the version it recorded if it loses the lock before writing", async () => {
        // Another server takes the lock just after this one stores the
        // version.
        const thief = lockThief(boardId);
        const insertVersion =
          WhiteboardVersions.insertAsync.bind(WhiteboardVersions);
        const stub = spyOn(
          WhiteboardVersions,
          "insertAsync",
        ).mockImplementation(
          async (...args: Parameters<typeof insertVersion>) => {
            const id = await insertVersion(...args);
            await thief.steal();
            return id;
          },
        );
        const note = stickyInput(0, 0);
        try {
          await rejects(
            upsertNodes(member, boardId, [note]),
            /The board was busy; try again/,
          );
          assert.ok(thief.held);
        } finally {
          stub.mockRestore();
          await thief.letGo();
        }
        assert.notOk(await node(note._id));
        assert.equal(
          await WhiteboardVersions.find({ board: boardId }).countAsync(),
          0,
        );
        assert.equal(
          await WhiteboardVersionChunks.find({ board: boardId }).countAsync(),
          0,
        );
      });

      it("refuses, writing nothing, a batch that makes a node or a line twice", async () => {
        const note = stickyInput(0, 0);
        await rejects(
          upsertNodes(member, boardId, [
            note,
            { ...note, position: { x: 50, y: 50 } },
          ]),
          /can only be in a batch once/,
        );
        assert.notOk(await node(note._id));

        const [a, b] = [stickyInput(0, 0), stickyInput(0, 0)];
        await upsertNodes(member, boardId, [a, b]);
        const line = { _id: Random.id(), source: a._id, target: b._id };
        await rejects(
          upsertEdges(member, boardId, [line, line]),
          /can only be in a batch once/,
        );
        assert.notOk(await edge(line._id));
      });

      it("refuses, writing nothing, a second card for a puzzle", async () => {
        const card = (await WhiteboardNodes.findOneAsync({
          board: boardId,
          type: "puzzle",
        }))!;
        const newCard = () => ({
          _id: Random.id(),
          type: "puzzle" as const,
          position: { x: 0, y: 0 },
          puzzle: card.puzzle!,
        });
        const fresh = stickyInput(0, 0);
        await rejects(
          upsertNodes(member, boardId, [fresh, newCard()]),
          /That puzzle is already on the board/,
        );
        // Two in one batch, for a puzzle not on the board
        await WhiteboardNodes.removeAsync(card._id);
        await rejects(
          upsertNodes(member, boardId, [fresh, newCard(), newCard()]),
          /That puzzle is already on the board/,
        );
        assert.notOk(await node(fresh._id));
        assert.notOk(
          await WhiteboardNodes.findOneAsync({
            board: boardId,
            puzzle: card.puzzle,
          }),
        );
      });

      it("writes nothing from a line batch whose last line is bad", async () => {
        const [a, b] = [stickyInput(0, 0), stickyInput(0, 0)];
        await upsertNodes(member, boardId, [a, b]);
        const before = await WhiteboardEdges.find({
          board: boardId,
        }).countAsync();
        const versions = await WhiteboardVersions.find({
          board: boardId,
        }).countAsync();
        const good = { _id: Random.id(), source: a._id, target: b._id };
        const otherBoard = await WhiteboardNodes.insertAsync({
          hunt: huntId,
          board: Random.id(),
          type: "sticky",
          position: { x: 0, y: 0 },
          createdBy: member.user,
        });
        const tries: [{ source: string; target: string }, RegExp][] = [
          [{ source: a._id, target: otherBoard }, /join nodes on this board/],
          [{ source: a._id, target: a._id }, /two different ends/],
        ];
        for (const [ends, error] of tries) {
          await rejects(
            upsertEdges(member, boardId, [good, { _id: Random.id(), ...ends }]),
            error,
          );
        }
        assert.equal(
          await WhiteboardEdges.find({ board: boardId }).countAsync(),
          before,
        );
        assert.equal(
          await WhiteboardVersions.find({ board: boardId }).countAsync(),
          versions,
        );
      });

      it("checks again, once it has the lock, what a reset or restore may have taken away", async () => {
        const frame = {
          _id: Random.id(),
          type: "frame" as const,
          position: { x: 0, y: 0 },
          width: 400,
          height: 400,
        };
        const [a, b] = [stickyInput(0, 0), stickyInput(0, 0)];
        await upsertNodes(member, boardId, [frame, a, b]);
        const child = stickyInput(0, 0, { parent: frame._id });
        const line = { _id: Random.id(), source: a._id, target: b._id };
        const results = await raceForLock(
          [
            () => upsertNodes(member, boardId, [child]),
            () => upsertEdges(member, boardId, [line]),
          ],
          () =>
            WhiteboardNodes.removeAsync({
              _id: { $in: [frame._id, b._id] },
            }),
        );
        assert.match(
          (results[0] as ServiceError).reason,
          /Parent must be a frame on this board/,
        );
        assert.match(
          (results[1] as ServiceError).reason,
          /join nodes on this board/,
        );
        assert.notOk(await node(child._id));
        assert.notOk(await edge(line._id));
      });

      it("checks again, once it has the lock, that the editor may still edit", async () => {
        const results = await raceForLock(
          [() => upsertNodes(member, boardId, [stickyInput(0, 0)])],
          () =>
            Whiteboards.updateAsync(boardId, {
              $set: { editPolicy: "operators" },
            }),
        );
        assert.instanceOf(results[0], ServiceError);
        assert.equal(
          await WhiteboardNodes.find({
            board: boardId,
            type: "sticky",
          }).countAsync(),
          0,
        );
      });

      it("takes a node whose parent is a frame made earlier in the batch", async () => {
        const frame = {
          _id: Random.id(),
          type: "frame" as const,
          position: { x: 0, y: 0 },
          width: 400,
          height: 400,
        };
        const child = stickyInput(0, 0, { parent: frame._id });
        const existing = stickyInput(0, 0);
        await upsertNodes(member, boardId, [existing]);
        await upsertNodes(member, boardId, [
          frame,
          child,
          { _id: existing._id, parent: frame._id },
        ]);
        assert.equal((await node(child._id))?.parent, frame._id);
        assert.equal((await node(existing._id))?.parent, frame._id);
      });
    });

    describe("collapsing frames", () => {
      const seededFrame = async () =>
        (await WhiteboardNodes.findOneAsync({
          board: boardId,
          type: "frame",
          tag: { $exists: true },
        }))!;

      it("collapses and expands a frame without making it manual", async () => {
        const frame = await seededFrame();
        assert.notOk(frame.manual);
        await upsertViaMethod(member, [{ _id: frame._id, collapsed: true }]);
        const collapsed = (await node(frame._id))!;
        assert.isTrue(collapsed.collapsed);
        assert.notOk(collapsed.manual);
        assert.deepEqual(collapsed.contributors, frame.contributors);
        assert.equal(collapsed.width, frame.width);
        assert.equal(collapsed.height, frame.height);

        await upsertNodes(member, boardId, [
          { _id: frame._id, collapsed: false },
        ]);
        const expanded = (await node(frame._id))!;
        assert.notProperty(expanded, "collapsed");
        assert.notOk(expanded.manual);
      });

      it("refuses collapsed on a sticky", async () => {
        const sticky = Random.id();
        await rejects(
          upsertNodes(member, boardId, [
            stickyInput(0, 0, { _id: sticky, collapsed: true }),
          ]),
          /Only frames can be collapsed/,
        );
        assert.notOk(await node(sticky));
        await upsertNodes(member, boardId, [
          stickyInput(0, 0, { _id: sticky }),
        ]);
        await rejects(
          upsertNodes(member, boardId, [{ _id: sticky, collapsed: false }]),
          /Only frames can be collapsed/,
        );
      });

      it("refuses a batch with a non-frame collapse before writing any of it", async () => {
        const frame = await seededFrame();
        const sticky = await addSticky(member, { x: 0, y: 0 });
        await rejects(
          upsertNodes(member, boardId, [
            { _id: frame._id, position: { x: 12345, y: 12345 } },
            { _id: sticky, collapsed: true },
          ]),
          /Only frames can be collapsed/,
        );
        assert.deepEqual((await node(frame._id))?.position, frame.position);
      });

      it("refuses collapsing to someone who can't edit", async () => {
        const frame = await seededFrame();
        await Whiteboards.updateAsync(boardId, {
          $set: { editPolicy: "operators" },
        });
        await rejects(
          upsertNodes(member, boardId, [{ _id: frame._id, collapsed: true }]),
          /Only operators/,
        );
        await rejects(
          upsertNodes(outsider, boardId, [{ _id: frame._id, collapsed: true }]),
          /member/,
        );
        assert.notOk((await node(frame._id))?.collapsed);

        await Whiteboards.updateAsync(boardId, { $unset: { editPolicy: 1 } });
        await rejects(
          upsertNodes(archived(operator), boardId, [
            { _id: frame._id, collapsed: true },
          ]),
          /archived/,
        );
      });

      it("keeps collapsed when a frame is re-inserted", async () => {
        const frame = Random.id();
        await upsertNodes(member, boardId, [
          {
            _id: frame,
            type: "frame",
            position: { x: 0, y: 0 },
            width: 400,
            height: 300,
            collapsed: true,
          },
        ]);
        assert.isTrue((await node(frame))?.collapsed);
        const open = Random.id();
        await upsertNodes(member, boardId, [
          {
            _id: open,
            type: "frame",
            position: { x: 500, y: 0 },
            width: 400,
            height: 300,
            collapsed: false,
          },
        ]);
        assert.notProperty((await node(open))!, "collapsed");
      });

      it("opens a seeded frame when it's taken off the board", async () => {
        const frame = await seededFrame();
        await upsertNodes(member, boardId, [
          { _id: frame._id, collapsed: true },
        ]);
        await deleteNodes(member, boardId, [frame._id]);
        const hidden = (await node(frame._id))!;
        assert.isTrue(hidden.hidden);
        assert.notProperty(hidden, "collapsed");

        await upsertNodes(member, boardId, [
          { _id: frame._id, hidden: false, parent: null },
        ]);
        assert.notOk((await node(frame._id))?.collapsed);
      });

      it("records no version for a collapse-only batch", async () => {
        const frame = await seededFrame();
        await WhiteboardVersions.removeAsync({ board: boardId });
        await upsertNodes(member, boardId, [
          { _id: frame._id, collapsed: true },
        ]);
        await upsertNodes(member, boardId, [
          { _id: frame._id, collapsed: false },
        ]);
        assert.equal(
          await WhiteboardVersions.find({ board: boardId }).countAsync(),
          0,
        );

        // Anything else in the batch is an edit like any other
        await upsertNodes(member, boardId, [
          { _id: frame._id, collapsed: true, position: { x: 10, y: 10 } },
        ]);
        assert.equal(
          await WhiteboardVersions.find({ board: boardId }).countAsync(),
          1,
        );
      });
    });
  });

  describe("lines", () => {
    const point = async (x: number, size?: number) => {
      const _id = Random.id();
      await upsertNodes(member, boardId, [
        {
          _id,
          type: "point",
          position: { x, y: 0 },
          width: size,
          height: size,
        },
      ]);
      return _id;
    };
    const exists = async (id: string) => !!(await node(id));

    it("clears a line's colour when sent null", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      const b = await addSticky(member, { x: 300, y: 0 });
      const line = Random.id();
      await upsertEdges(member, boardId, [
        { _id: line, source: a, target: b, color: "red" },
      ]);
      await upsertEdges(member, boardId, [{ _id: line, color: null }]);
      assert.isUndefined((await edge(line))?.color);
    });

    it("keeps a free end small whatever size is asked for", async () => {
      const p = await point(0, 500);
      const node = (await WhiteboardNodes.findOneAsync(p))!;
      assert.equal(node.width, POINT_SIZE);
      assert.equal(node.height, POINT_SIZE);
    });

    it("removes a free line's ends when the line is deleted", async () => {
      const a = await point(0);
      const b = await point(100);
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: b }]);
      await deleteEdges(member, boardId, [line]);
      assert.isFalse(await exists(a));
      assert.isFalse(await exists(b));
    });

    it("removes a free end that's no longer used after re-attaching", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      const b = await addSticky(member, { x: 300, y: 0 });
      const p = await point(100);
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: p }]);
      await upsertEdges(member, boardId, [{ _id: line, target: b }]);
      assert.isFalse(await exists(p));
      assert.equal((await edge(line))?.target, b);
    });

    it("removes a dangling line with the thing it was attached to", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      const p = await point(100);
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: p }]);
      await deleteNodes(member, boardId, [a]);
      assert.notOk(await edge(line));
      assert.isFalse(await exists(p));
    });

    it("won't join a line's end to its other end", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      const b = await addSticky(member, { x: 300, y: 0 });
      const line = Random.id();
      await upsertEdges(member, boardId, [{ _id: line, source: a, target: b }]);
      await rejects(
        upsertEdges(member, boardId, [{ _id: line, target: a }]),
        /two different ends/,
      );
    });

    it("records who drew and restyled a line, but not who moved its ends", async () => {
      const a = await addSticky(member, { x: 0, y: 0 });
      const b = await addSticky(member, { x: 300, y: 0 });
      const c = await addSticky(member, { x: 600, y: 0 });
      const line = Random.id();
      await upsertEdges(member, boardId, [
        { _id: line, source: a, target: b, pathStyle: "straight" },
      ]);
      await upsertEdges(operator, boardId, [
        { _id: line, arrowHead: "both", dashed: true },
      ]);
      const mover = makeUser();
      await upsertEdges(mover, boardId, [{ _id: line, target: c }]);
      const saved = (await edge(line))!;
      assert.deepEqual(
        saved.contributors.map((x) => x.user),
        [member.user, operator.user],
      );
      assert.equal(saved.pathStyle, "straight");
      assert.equal(saved.arrowHead, "both");
      assert.isTrue(saved.dashed);
    });
  });
});
