import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { isServiceError } from "lib/compat/error";
import FixtureHunt from "lib/fixtureHunt";
import Whiteboards from "lib/models/Whiteboards";
import { z } from "zod";
import type { Config } from "./config";
import Logger from "./logger";
import { activityOf } from "./rooms";
import { createTestHandler } from "./testMode";
import { deleteBoard, ensureBoard } from "./whiteboard";

// What the service answers over plain HTTP: the API Jolly Roger calls with
// the shared secret, the health check, and the built client. Everything
// else is a 404.

const DIST_DIR = path.resolve(import.meta.dir, "../dist");

const ScopeBody = z.strictObject({
  scope: z.strictObject({
    hunt: z.string().min(1),
    puzzle: z.string().min(1).optional(),
  }),
});

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const notFound = () => json(404, { error: "Not found" });

const BOARD_ID = /^[A-Za-z0-9]{1,32}$/;

// What the iframe loads while the client hasn't been built
const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>hunt-board</title></head>
<body><p>The board client hasn't been built yet.</p></body>
</html>
`;

export interface HttpOptions {
  config: Config;
  // Where the built client is, for tests
  distDir?: string;
}

export function createHttpHandler({ config, distDir = DIST_DIR }: HttpOptions) {
  const secret = Buffer.from(config.jrSharedSecret, "utf8");
  // The board page may only be framed by Jolly Roger
  const pageHeaders = {
    "content-security-policy": `frame-ancestors ${config.jrUrl}`,
    "cache-control": "no-store",
  };

  function authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return false;
    const given = Buffer.from(header.slice("Bearer ".length), "utf8");
    return given.length === secret.length && timingSafeEqual(given, secret);
  }

  const boardUrl = (id: string) => `${config.publicUrl}/boards/${id}`;
  // Answers nothing unless TEST_MODE=1
  const testRoutes = createTestHandler({ config, huntId: FixtureHunt._id });

  async function createBoard(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Body must be JSON" });
    }
    const parsed = ScopeBody.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: "Body must be { scope: { hunt, puzzle? } }" });
    }
    const id = await ensureBoard(parsed.data.scope);
    return json(200, { id, url: boardUrl(id) });
  }

  async function removeBoard(id: string): Promise<Response> {
    const board = await Whiteboards.findOneAsync(id);
    if (!board) return notFound();
    await deleteBoard(id);
    return new Response(null, { status: 204 });
  }

  async function activity(id: string): Promise<Response> {
    const board = await Whiteboards.findOneAsync(id);
    if (!board) return notFound();
    return json(200, { users: await activityOf(id) });
  }

  // A file under dist/, or undefined if there's no such file (or the path
  // tries to leave dist/)
  async function staticFile(pathname: string) {
    const relative = path
      .normalize(decodeURIComponent(pathname))
      .replace(/^(\.\.(\/|\\|$))+/, "");
    const file = path.join(distDir, relative);
    if (!file.startsWith(`${distDir}${path.sep}`)) return undefined;
    const handle = Bun.file(file);
    if (!(await handle.exists())) return undefined;
    return handle;
  }

  async function page(): Promise<Response> {
    const index = await staticFile("/index.html");
    if (!index) {
      return new Response(PLACEHOLDER_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", ...pageHeaders },
      });
    }
    return new Response(index, {
      headers: { "content-type": "text/html; charset=utf-8", ...pageHeaders },
    });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const { method } = req;

    const test = await testRoutes(req);
    if (test) return test;

    if (pathname === "/healthz") {
      return method === "GET" || method === "HEAD"
        ? json(200, { ok: true })
        : json(405, { error: "Method not allowed" });
    }

    const boardRoute = /^\/boards\/([^/]+)(\/activity)?$/.exec(pathname);
    // The board page is GET /boards/:id; the rest of /boards is the API
    const isPage =
      boardRoute !== null &&
      boardRoute[2] === undefined &&
      (method === "GET" || method === "HEAD");
    const isApi = pathname === "/boards" || (boardRoute !== null && !isPage);
    if (isApi) {
      if (!authorized(req)) {
        return json(401, { error: "Unauthorized" });
      }
      if (pathname === "/boards") {
        return method === "POST"
          ? createBoard(req)
          : json(405, { error: "Method not allowed" });
      }
      const id = boardRoute?.[1] ?? "";
      if (!BOARD_ID.test(id)) return notFound();
      if (boardRoute?.[2]) {
        return method === "GET"
          ? activity(id)
          : json(405, { error: "Method not allowed" });
      }
      return method === "DELETE"
        ? removeBoard(id)
        : json(405, { error: "Method not allowed" });
    }

    if (method !== "GET" && method !== "HEAD") return notFound();
    if (boardRoute || pathname === "/") return page();
    const file = await staticFile(pathname);
    if (!file) return notFound();
    if (file.type.startsWith("text/html")) {
      return new Response(file, { headers: pageHeaders });
    }
    // The build hashes what it puts under assets/; anything else may change
    // on the next deploy
    return new Response(file, {
      headers: {
        "cache-control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (error) {
      if (isServiceError(error)) {
        return json(
          error.error >= 400 && error.error < 600 ? error.error : 400,
          {
            error: error.reason,
          },
        );
      }
      Logger.error("An HTTP request failed", {
        method: req.method,
        url: req.url,
        error,
      });
      return json(500, { error: "Internal error" });
    }
  };
}
