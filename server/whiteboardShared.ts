import type { Claims } from "lib/access";
import { boardAccess } from "lib/access";
import { ServiceError } from "lib/compat/error";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import { MAX_COORDINATE } from "lib/whiteboard/limits";
import "./changes";
import type { FlagName } from "./flags";
import Flags from "./flags";
import { assertWhiteboardEnabled } from "./whiteboard";

// Permission gates and helpers for the other whiteboard modules. Of those it
// imports only whiteboard.ts, which imports only whiteboardComments.ts, a
// leaf, so there's no cycle. Importing changes.ts here is what hooks the
// broadcast seam onto the models, for anything that imports this.

export const inRange = (n: number) =>
  Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE;

// [x, y, pressure] on the board, with the pressure between 0 and 1.
export function isInkPoint(point: number[]) {
  const [x = Number.NaN, y = Number.NaN, pressure = Number.NaN] = point;
  return (
    point.length === 3 &&
    inRange(x) &&
    inRange(y) &&
    pressure >= 0 &&
    pressure <= 1
  );
}

export const lockedError = () => new ServiceError(403, "That's locked");

// A modifier of whichever of $set and $unset has anything in it, or
// undefined when neither does and there's nothing to write.
export function modifier(
  $set: Record<string, unknown>,
  $unset: Record<string, "">,
) {
  const sets = Object.keys($set).length > 0;
  const unsets = Object.keys($unset).length > 0;
  if (!sets && !unsets) return undefined;
  return { ...(sets ? { $set } : {}), ...(unsets ? { $unset } : {}) };
}

export const tooMuchInkError = () =>
  new ServiceError(400, "This board has as much drawing as it can hold");

// How many points the ink on a board holds, for MAX_INK_POINTS_PER_BOARD.
// Summed by the database, so the points aren't sent here, though it still
// reads every ink document on the board to count them.
export async function inkPointsOnBoard(boardId: string) {
  const [result] = await WhiteboardNodes.rawCollection()
    .aggregate<{ total: number }>([
      { $match: { board: boardId, type: "ink" } },
      {
        $group: {
          _id: null,
          total: { $sum: { $size: { $ifNull: ["$points", []] } } },
        },
      },
    ])
    .toArray();
  return result?.total ?? 0;
}

// The board, for sending its contents to a room: only to a token for its
// scope, and not while disable.whiteboard, or the given flag, is on.
// Otherwise undefined.
export async function boardForClaims(
  claims: Claims,
  boardId: string,
  alsoOff?: FlagName,
) {
  const board = await Whiteboards.findOneAsync(boardId);
  if (!board) return undefined;
  if (boardAccess(claims, board).access === "none") return undefined;
  if (await Flags.activeAsync("disable.whiteboard")) return undefined;
  if (alsoOff && (await Flags.activeAsync(alsoOff))) return undefined;
  return board;
}

// What a lock stops on a node. Folding a frame changes no geometry, so it's
// still allowed.
export const LOCKED_FIELDS = [
  "position",
  "parent",
  "width",
  "height",
  "text",
  "label",
  "color",
  "hidden",
] as const;

const archived = () => new ServiceError(403, "This hunt is archived");

// Finds the board by its id and works out what the caller may do on it.
// Read fresh on every call, so a change to the edit policy applies to the
// next one; a change to the caller's hunt or roles comes with their next
// token.
export async function loadBoardAccess(claims: Claims, boardId: string) {
  await assertWhiteboardEnabled();
  const board = await Whiteboards.findOneAsync(boardId);
  if (!board) {
    throw new ServiceError(404, "Unknown whiteboard");
  }
  const { access, reason } = boardAccess(claims, board);
  if (access === "none") {
    throw new ServiceError(
      403,
      `User ${claims.user} is not a member of hunt ${board.hunt}`,
    );
  }
  return { board, claims, access, reason };
}

// Comments, replies, reactions and resolving are open to everyone in the
// hunt, whatever the edit policy, until the hunt is archived.
export async function assertMayCommentOnBoard(claims: Claims, boardId: string) {
  const loaded = await loadBoardAccess(claims, boardId);
  if (loaded.access === "view") throw archived();
  return loaded;
}

export async function assertMayEditBoard(claims: Claims, boardId: string) {
  const loaded = await assertMayCommentOnBoard(claims, boardId);
  if (loaded.access !== "edit") {
    throw new ServiceError(
      403,
      loaded.reason === "operatorsAndEditors"
        ? "Only operators and people they've chosen can edit this whiteboard"
        : "Only operators can edit this whiteboard",
    );
  }
  return loaded;
}
