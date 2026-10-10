import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import { Random } from "lib/compat/random";
import FixtureHunt from "lib/fixtureHunt";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import { MAX_INK_POINTS_PER_BOARD } from "lib/whiteboard/limits";
import type { Service } from "../../server/app";
import { startService } from "../../server/app";
import { closeRooms } from "../../server/rooms";
import { verifyToken } from "../../server/token";
import { inkPointsOnBoard } from "../../server/whiteboardShared";
import {
  huntId,
  resetDatabase,
  setUpDatabase,
  tearDownDatabase,
} from "./harness";
import { SECRET, testConfig } from "./service";

// The acceptance harness's endpoints: there only with TEST_MODE=1.

describe("test mode", () => {
  let off: Service;
  let on: Service;

  beforeAll(async () => {
    await setUpDatabase();
    off = startService({ config: testConfig(), port: 0 });
    on = startService({ config: testConfig({ testMode: true }), port: 0 });
  });
  afterAll(async () => {
    await off.stop();
    await on.stop();
    delete process.env.S3_IMAGE_BUCKET_NAME;
    delete process.env.S3_IMAGE_BUCKET_REGION;
    await tearDownDatabase();
  });
  beforeEach(async () => {
    await closeRooms(() => {});
    await resetDatabase();
  });

  const post = (service: Service, p: string, body?: unknown) =>
    fetch(`${service.url}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("has no /test routes without the flag", async () => {
    for (const p of ["/test/reset", "/test/token", "/test/fixture"]) {
      const res = await post(off, p, {});
      assert.equal(res.status, 404, p);
    }
    const get = await fetch(`${off.url}/test/reset`);
    assert.equal(get.status, 404);
  });

  it("resets to the fixture hunt and its board", async () => {
    const stale = await Whiteboards.insertAsync({
      _id: Random.id(),
      hunt: Random.id(),
      createdBy: Random.id(),
    });
    const res = await post(on, "/test/reset");
    assert.equal(res.status, 200);
    const { boardId } = (await res.json()) as {
      boardId: string;
      huntId: string;
    };
    assert.isUndefined(await Whiteboards.findOneAsync(stale));
    const board = await Whiteboards.findOneAsync(boardId);
    assert.equal(board?.hunt, huntId);
    assert.equal(
      await Puzzles.find({ hunt: huntId }).countAsync(),
      FixtureHunt.puzzles.length,
    );
    // Seeded and placed
    assert.isAbove(
      await WhiteboardNodes.find({
        board: boardId,
        type: "puzzle",
      }).countAsync(),
      0,
    );
  });

  it("mints a token for any user with the secret", async () => {
    const res = await post(on, "/test/token", {
      user: "someoneXXXXXXXXX1",
      name: "Someone",
      operator: true,
      mayEdit: false,
    });
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    const claims = verifyToken(token, SECRET);
    assert.equal(claims.user, "someoneXXXXXXXXX1");
    assert.equal(claims.name, "Someone");
    assert.isTrue(claims.operator);
    assert.isFalse(claims.mayEdit);
    assert.deepEqual(claims.scope, { hunt: huntId });

    const bad = await post(on, "/test/token", { nope: true });
    assert.equal(bad.status, 400);
  });

  it("writes puzzles and tags as the feed would, and places them", async () => {
    const reset = await post(on, "/test/reset");
    const { boardId } = (await reset.json()) as { boardId: string };

    const made = await post(on, "/test/fixture", {
      op: "puzzle",
      title: "Stand-in",
      tags: ["group:stand-ins"],
    });
    assert.equal(made.status, 200);
    const { puzzleId } = (await made.json()) as { puzzleId: string };
    const tag = await Tags.findOneAsync({
      hunt: huntId,
      name: "group:stand-ins",
    });
    assert.ok(tag);
    const puzzle = await Puzzles.findOneAsync(puzzleId);
    assert.deepEqual(puzzle?.tags, [tag._id]);
    const card = await WhiteboardNodes.findOneAsync({
      board: boardId,
      puzzle: puzzleId,
    });
    assert.ok(card);

    await post(on, "/test/fixture", {
      op: "puzzle",
      puzzleId,
      addTags: ["stuck"],
      answers: ["ANSWER"],
    });
    const changed = await Puzzles.findOneAsync(puzzleId);
    assert.lengthOf(changed?.tags ?? [], 2);
    assert.deepEqual(changed?.answers, ["ANSWER"]);

    await post(on, "/test/fixture", { op: "puzzle", puzzleId, deleted: true });
    assert.isTrue(
      (await WhiteboardNodes.findOneAsync({ board: boardId, puzzle: puzzleId }))
        ?.hidden,
    );
    await post(on, "/test/fixture", {
      op: "puzzle",
      puzzleId,
      deleted: false,
    });
    assert.isUndefined(
      (await WhiteboardNodes.findOneAsync({ board: boardId, puzzle: puzzleId }))
        ?.hidden,
    );
  });

  it("fills the ink budget, clears versions and sets the image bucket", async () => {
    const reset = await post(on, "/test/reset");
    const { boardId } = (await reset.json()) as { boardId: string };
    const filled = await post(on, "/test/fixture", {
      op: "fillInk",
      boardId,
      spare: 7,
    });
    assert.equal(filled.status, 200);
    const { nodeId } = (await filled.json()) as { nodeId: string };
    assert.ok(await WhiteboardNodes.findOneAsync(nodeId));
    assert.equal(await inkPointsOnBoard(boardId), MAX_INK_POINTS_PER_BOARD - 7);

    const cleared = await post(on, "/test/fixture", {
      op: "clearVersions",
      boardId,
    });
    assert.equal(cleared.status, 200);

    await post(on, "/test/fixture", { op: "imageBucket", on: true });
    assert.equal(process.env.S3_IMAGE_BUCKET_NAME, "jr-test-images");
    await post(on, "/test/fixture", { op: "imageBucket", on: false });
    assert.isUndefined(process.env.S3_IMAGE_BUCKET_NAME);

    const bad = await post(on, "/test/fixture", { op: "nothing" });
    assert.equal(bad.status, 400);
  });
});
