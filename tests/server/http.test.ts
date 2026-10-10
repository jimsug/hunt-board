import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert } from "chai";
import { Random } from "lib/compat/random";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import type { Service } from "../../server/app";
import { closeRooms } from "../../server/rooms";
import { ensureBoard } from "../../server/whiteboard";
import {
  huntId,
  makeFixtureHunt,
  makeUser,
  resetDatabase,
  setUpDatabase,
  tearDownDatabase,
} from "./harness";
import {
  authed,
  JR_URL,
  PUBLIC_URL,
  SECRET,
  startTestService,
  TestClient,
  tokenFor,
} from "./service";

describe("http", () => {
  let service: Service;
  let distDir: string;

  beforeAll(async () => {
    await setUpDatabase();
    distDir = await mkdtemp(path.join(tmpdir(), "hunt-board-dist-"));
  });
  afterAll(async () => {
    await service?.stop();
    await tearDownDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await closeRooms(() => {});
    if (!service) service = startTestService({ distDir });
  });

  const url = (p: string) => `${service.url}${p}`;
  const post = (p: string, body: unknown, headers: HeadersInit = authed()) =>
    fetch(url(p), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  describe("auth", () => {
    it("refuses the API without a secret", async () => {
      const res = await post("/boards", { scope: { hunt: huntId } }, {});
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Unauthorized" });
      assert.isNull(res.headers.get("content-security-policy"));
    });

    it("refuses a wrong secret", async () => {
      for (const header of [
        "Bearer nope",
        `Bearer ${SECRET}x`,
        `Bearer ${SECRET.slice(0, -1)}`,
        SECRET,
        `Basic ${SECRET}`,
      ]) {
        const res = await post(
          "/boards",
          { scope: { hunt: huntId } },
          { authorization: header },
        );
        assert.equal(res.status, 401, header);
      }
      assert.equal(
        (await fetch(url("/boards/abc"), { method: "DELETE" })).status,
        401,
      );
      assert.equal((await fetch(url("/boards/abc/activity"))).status, 401);
    });
  });

  describe("POST /boards", () => {
    it("creates a board for the scope, once", async () => {
      const operator = makeUser(true);
      await makeFixtureHunt(operator.user);
      const first = await post("/boards", { scope: { hunt: huntId } });
      assert.equal(first.status, 200);
      const { id, url: boardUrl } = (await first.json()) as {
        id: string;
        url: string;
      };
      assert.match(id, /^[A-Za-z0-9]{17}$/);
      assert.equal(boardUrl, `${PUBLIC_URL}/boards/${id}`);
      const board = await Whiteboards.findOneAsync(id);
      assert.equal(board?.hunt, huntId);
      assert.isUndefined(board?.puzzle);
      // The hunt's board gets a card per puzzle
      assert.isAbove(
        await WhiteboardNodes.find({ board: id, type: "puzzle" }).countAsync(),
        0,
      );

      const again = await post("/boards", { scope: { hunt: huntId } });
      assert.deepEqual(await again.json(), { id, url: boardUrl });
      assert.equal(await Whiteboards.find({ hunt: huntId }).countAsync(), 1);
    });

    it("gives a puzzle its own board", async () => {
      const puzzle = Random.id();
      const res = await post("/boards", { scope: { hunt: huntId, puzzle } });
      const { id } = (await res.json()) as { id: string };
      const board = await Whiteboards.findOneAsync(id);
      assert.equal(board?.puzzle, puzzle);
      const huntBoard = await post("/boards", { scope: { hunt: huntId } });
      assert.notEqual(((await huntBoard.json()) as { id: string }).id, id);
    });

    it("refuses a malformed body", async () => {
      assert.equal((await post("/boards", { hunt: huntId })).status, 400);
      assert.equal(
        (await post("/boards", { scope: { hunt: huntId, extra: 1 } })).status,
        400,
      );
      assert.equal(
        (await post("/boards", { scope: { hunt: "" } })).status,
        400,
      );
      const notJson = await fetch(url("/boards"), {
        method: "POST",
        headers: authed(),
        body: "nope",
      });
      assert.equal(notJson.status, 400);
    });

    it("only takes POST", async () => {
      assert.equal(
        (await fetch(url("/boards"), { headers: authed() })).status,
        405,
      );
    });
  });

  describe("DELETE /boards/:id", () => {
    it("deletes the board and what's on it", async () => {
      const operator = makeUser(true);
      await makeFixtureHunt(operator.user);
      const id = await ensureBoard({ hunt: huntId });
      const res = await fetch(url(`/boards/${id}`), {
        method: "DELETE",
        headers: authed(),
      });
      assert.equal(res.status, 204);
      assert.isUndefined(await Whiteboards.findOneAsync(id));
      assert.equal(await WhiteboardNodes.find({ board: id }).countAsync(), 0);
    });

    it("404s an unknown board", async () => {
      const res = await fetch(url(`/boards/${Random.id()}`), {
        method: "DELETE",
        headers: authed(),
      });
      assert.equal(res.status, 404);
    });
  });

  describe("GET /boards/:id/activity", () => {
    it("lists who's on the board", async () => {
      const id = await ensureBoard({ hunt: huntId });
      const empty = await fetch(url(`/boards/${id}/activity`), {
        headers: authed(),
      });
      assert.deepEqual(await empty.json(), { users: [] });

      const user = makeUser();
      const client = await TestClient.connect(service.url);
      await client.hello(tokenFor(user.user, { name: "Ada" }));
      const res = await fetch(url(`/boards/${id}/activity`), {
        headers: authed(),
      });
      assert.equal(res.status, 200);
      const { users } = (await res.json()) as {
        users: { user: string; name: string; lastSeen: string }[];
      };
      assert.lengthOf(users, 1);
      assert.equal(users[0]?.user, user.user);
      assert.equal(users[0]?.name, "Ada");
      assert.closeTo(Date.parse(users[0]?.lastSeen ?? ""), Date.now(), 5000);
      await client.close();
    });

    it("404s an unknown board", async () => {
      const res = await fetch(url(`/boards/${Random.id()}/activity`), {
        headers: authed(),
      });
      assert.equal(res.status, 404);
    });
  });

  describe("GET /healthz", () => {
    it("answers without auth", async () => {
      const res = await fetch(url("/healthz"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });
  });

  describe("the page", () => {
    it("serves a placeholder with the framing policy while there's no build", async () => {
      const res = await fetch(url("/boards/anything"));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(
        res.headers.get("content-security-policy"),
        `frame-ancestors ${JR_URL}`,
      );
      assert.include(await res.text(), "hasn't been built");
    });

    it("serves the built client and its assets", async () => {
      await writeFile(
        path.join(distDir, "index.html"),
        "<!doctype html><p>built</p>",
      );
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(distDir, "assets"), { recursive: true });
      await writeFile(path.join(distDir, "assets", "app.js"), "console.log(1)");
      try {
        const page = await fetch(url(`/boards/${Random.id()}`));
        assert.include(await page.text(), "built");
        assert.equal(
          page.headers.get("content-security-policy"),
          `frame-ancestors ${JR_URL}`,
        );
        const root = await fetch(url("/"));
        assert.include(await root.text(), "built");
        const asset = await fetch(url("/assets/app.js"));
        assert.equal(asset.status, 200);
        assert.equal(await asset.text(), "console.log(1)");
        assert.isNull(asset.headers.get("content-security-policy"));
        assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
      } finally {
        const { rm } = await import("node:fs/promises");
        await rm(path.join(distDir, "index.html"));
        await rm(path.join(distDir, "assets"), { recursive: true });
      }
    });

    it("doesn't leave dist", async () => {
      assert.equal((await fetch(url("/../package.json"))).status, 404);
      assert.equal((await fetch(url("/%2e%2e/package.json"))).status, 404);
      assert.equal(
        (await fetch(url("/assets/../../package.json"))).status,
        404,
      );
    });
  });

  describe("404s", () => {
    it("answers nothing else", async () => {
      assert.equal((await fetch(url("/nope"))).status, 404);
      assert.equal((await fetch(url("/boards/x/y/z"))).status, 404);
      assert.equal(
        (
          await fetch(url("/boards/x/activity"), {
            method: "POST",
            headers: authed(),
          })
        ).status,
        405,
      );
      assert.equal((await fetch(url("/nope"), { method: "POST" })).status, 404);
      assert.equal((await fetch(url("/ws"))).status, 426);
    });
  });
});
