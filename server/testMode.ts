import type { Claims } from "lib/access";
import { SERVICE_USER } from "lib/access";
import { Random } from "lib/compat/random";
import { db } from "lib/db";
import { seedFixtureHunt } from "lib/fixtureHunt";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import { Id } from "lib/typedModel/regexes";
import { withUser } from "lib/typedModel/userContext";
import { MAX_INK_POINTS_PER_BOARD } from "lib/whiteboard/limits";
import { z } from "zod";
import type { Config } from "./config";
import WhiteboardVersionChunks from "./models/WhiteboardVersionChunks";
import { closeRooms } from "./rooms";
import { signToken } from "./token";
import {
  deferredSyncsDone,
  deferSyncPuzzlesOnBoard,
  ensureBoard,
} from "./whiteboard";
import { inkPointsOnBoard } from "./whiteboardShared";

// The endpoints the acceptance harness drives, served only with TEST_MODE=1:
// without it nothing under /test exists. They stand in for what the browser
// tests reached through Jolly Roger's methods: resetting the database,
// minting a token for any user (the browser never holds the secret), and
// the puzzle and tag writes the feed would bring.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const TOKEN_LIFETIME_MS = 5 * 60 * 1000;

const TokenBody = z.strictObject({
  user: z.string().regex(Id),
  name: z.string().min(1).optional(),
  operator: z.boolean().optional(),
  mayEdit: z.boolean().optional(),
  scope: z
    .strictObject({ hunt: z.string().min(1), puzzle: z.string().optional() })
    .optional(),
});

// What Jolly Roger could do to a puzzle (its tags by name, as the tag
// methods took them), mirrored into the copy and, unless sync is off,
// handed to placement as the feed hands every change. A missing puzzleId
// makes a new puzzle.
const PuzzleBody = z.strictObject({
  op: z.literal("puzzle"),
  puzzleId: z.string().optional(),
  title: z.string().min(1).optional(),
  tags: z.string().array().optional(),
  addTags: z.string().array().optional(),
  removeTags: z.string().array().optional(),
  answers: z.string().array().optional(),
  expectedAnswerCount: z.number().int().optional(),
  deleted: z.boolean().optional(),
  replacedBy: z.string().optional(),
  sync: z.boolean().optional(),
});

const FixtureBody = z.discriminatedUnion("op", [
  PuzzleBody,
  // One ink node out of the way with as many points as leave the board
  // `spare` short of its ink budget
  z.strictObject({
    op: z.literal("fillInk"),
    boardId: z.string(),
    spare: z.number().int().nonnegative(),
  }),
  // The board's history, afresh
  z.strictObject({ op: z.literal("clearVersions"), boardId: z.string() }),
  // Whether there's an image bucket, as the environment would say
  z.strictObject({
    op: z.literal("imageBucket"),
    on: z.boolean(),
    bucketName: z.string().optional(),
    bucketRegion: z.string().optional(),
  }),
]);

async function tagIdsByName(huntId: string, names: string[]) {
  const ids: string[] = [];
  for (const name of names) {
    const existing = await Tags.findOneAsync({ hunt: huntId, name });
    if (existing) {
      ids.push(existing._id);
      continue;
    }
    ids.push(
      await Tags.insertAsync({
        _id: Random.id(),
        hunt: huntId,
        name,
        createdBy: SERVICE_USER,
      }),
    );
  }
  return ids;
}

async function writePuzzle(huntId: string, body: z.infer<typeof PuzzleBody>) {
  const puzzleId = body.puzzleId ?? Random.id();
  const existing = await Puzzles.findOneAllowingDeletedAsync(puzzleId);
  if (!existing) {
    await Puzzles.insertAsync({
      _id: puzzleId,
      hunt: huntId,
      title: body.title ?? "Untitled",
      tags: await tagIdsByName(huntId, body.tags ?? []),
      answers: body.answers ?? [],
      expectedAnswerCount: body.expectedAnswerCount ?? 1,
      createdBy: SERVICE_USER,
    });
  } else {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    if (body.title !== undefined) $set.title = body.title;
    if (body.answers !== undefined) $set.answers = body.answers;
    if (body.expectedAnswerCount !== undefined) {
      $set.expectedAnswerCount = body.expectedAnswerCount;
    }
    if (body.replacedBy !== undefined) $set.replacedBy = body.replacedBy;
    if (body.tags !== undefined) {
      $set.tags = await tagIdsByName(huntId, body.tags);
    } else if (body.addTags || body.removeTags) {
      const added = await tagIdsByName(huntId, body.addTags ?? []);
      const removed = new Set(body.removeTags ?? []);
      $set.tags = [
        ...existing.tags.filter((id) => !removed.has(id)),
        ...added.filter((id) => !existing.tags.includes(id)),
      ];
    }
    if (body.deleted === true) $set.deleted = true;
    if (body.deleted === false) $unset.deleted = "";
    const mod = {
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    };
    if (Object.keys(mod).length > 0) {
      await Puzzles.updateAsync({ _id: puzzleId }, mod);
    }
  }
  if (body.sync !== false) {
    deferSyncPuzzlesOnBoard(huntId, [puzzleId]);
    await deferredSyncsDone();
  }
  return puzzleId;
}

async function fillInk(boardId: string, spare: number) {
  const board = await Whiteboards.findOneAsync(boardId);
  if (!board) return undefined;
  const count = MAX_INK_POINTS_PER_BOARD - (await inkPointsOnBoard(boardId));
  return WhiteboardNodes.insertAsync({
    _id: Random.id(),
    hunt: board.hunt,
    board: boardId,
    type: "ink",
    position: { x: -90000, y: -90000 },
    width: 10,
    height: 10,
    strokeWidth: "thin",
    points: Array.from(
      { length: Math.max(0, count - spare) },
      (): [number, number, number] => [0, 0, 0.5],
    ),
    createdBy: SERVICE_USER,
  });
}

export interface TestModeOptions {
  config: Config;
  // The hunt the reset seeds
  huntId: string;
}

// The /test/* routes, or undefined for anything else (and for everything
// while test mode is off).
export function createTestHandler({ config, huntId }: TestModeOptions) {
  return async function handle(req: Request): Promise<Response | undefined> {
    if (!config.testMode) return undefined;
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/test/")) return undefined;
    if (req.method !== "POST")
      return json(405, { error: "Method not allowed" });

    let body: unknown = {};
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { error: "Body must be JSON" });
      }
    }

    switch (pathname) {
      case "/test/reset": {
        await closeRooms((member) => member.close(1001, "Reset"));
        await deferredSyncsDone();
        for (const collection of await db().collections()) {
          await collection.deleteMany({});
        }
        await withUser(SERVICE_USER, () => seedFixtureHunt(SERVICE_USER));
        const boardId = await ensureBoard({ hunt: huntId });
        await deferredSyncsDone();
        return json(200, { boardId, huntId });
      }
      case "/test/token": {
        const parsed = TokenBody.safeParse(body);
        if (!parsed.success) return json(400, { error: "Bad token request" });
        const claims: Claims = {
          v: 1,
          scope: parsed.data.scope ?? { hunt: huntId },
          user: parsed.data.user,
          name: parsed.data.name ?? parsed.data.user,
          mayEdit: parsed.data.mayEdit ?? true,
          exp: Date.now() + TOKEN_LIFETIME_MS,
          ...(parsed.data.operator ? { operator: true } : {}),
        };
        return json(200, { token: signToken(claims, config.jrSharedSecret) });
      }
      case "/test/fixture": {
        const parsed = FixtureBody.safeParse(body);
        if (!parsed.success) return json(400, { error: "Bad fixture request" });
        const fixture = parsed.data;
        return withUser(SERVICE_USER, async () => {
          switch (fixture.op) {
            case "puzzle":
              return json(200, {
                puzzleId: await writePuzzle(huntId, fixture),
              });
            case "fillInk": {
              const nodeId = await fillInk(fixture.boardId, fixture.spare);
              return nodeId
                ? json(200, { nodeId })
                : json(404, { error: "Unknown whiteboard" });
            }
            case "clearVersions":
              await WhiteboardVersions.removeAsync({ board: fixture.boardId });
              await WhiteboardVersionChunks.removeAsync({
                board: fixture.boardId,
              });
              return json(200, {});
            case "imageBucket":
              if (fixture.on) {
                process.env.S3_IMAGE_BUCKET_NAME =
                  fixture.bucketName ?? "jr-test-images";
                process.env.S3_IMAGE_BUCKET_REGION =
                  fixture.bucketRegion ?? "us-east-1";
              } else {
                delete process.env.S3_IMAGE_BUCKET_NAME;
                delete process.env.S3_IMAGE_BUCKET_REGION;
              }
              return json(200, {});
            default:
              return json(400, { error: "Unknown fixture" });
          }
        });
      }
      default:
        return json(404, { error: "Not found" });
    }
  };
}
