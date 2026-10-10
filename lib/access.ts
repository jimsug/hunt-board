import type { WhiteboardType } from "./models/Whiteboards";

// Who may do what on a board, worked out from the token Jolly Roger minted
// for the iframe rather than from users and hunts. The token's scope picks
// the board, its mayEdit is the ceiling (false once the hunt is archived),
// and the board's own edit policy decides the rest.

export interface BoardScope {
  hunt: string;
  puzzle?: string;
}

export interface Claims {
  v: 1;
  scope: BoardScope;
  user: string;
  name: string;
  mayEdit: boolean;
  // Milliseconds since the epoch
  exp: number;
  // An operator of the hunt, for the edit policies that single them out.
  // Jolly Roger sets it; absent means a plain member.
  operator?: boolean;
}

export type BoardAccess = "edit" | "comment" | "view" | "none";
export type BoardAccessReason =
  | "archived"
  | "operators"
  | "operatorsAndEditors";

// The id the service writes under when nothing was asked for by a person
// (seeding a board, say). Shaped like any other id so the schemas take it.
export const SERVICE_USER = "huntboardservice2";

export const isOperator = (claims: Pick<Claims, "operator">) =>
  claims.operator === true;

export function scopeMatches(
  scope: BoardScope,
  board: Pick<WhiteboardType, "hunt" | "puzzle">,
) {
  return (
    scope.hunt === board.hunt &&
    (scope.puzzle ?? undefined) === (board.puzzle ?? undefined)
  );
}

export function boardAccess(
  claims: Claims,
  board: Pick<WhiteboardType, "hunt" | "puzzle" | "editPolicy" | "editors">,
): { access: BoardAccess; reason?: BoardAccessReason } {
  if (!scopeMatches(claims.scope, board)) {
    return { access: "none" };
  }
  if (!claims.mayEdit) {
    return { access: "view", reason: "archived" };
  }
  const policy = board.editPolicy ?? "members";
  switch (policy) {
    case "members":
      return { access: "edit" };
    case "operators":
      return isOperator(claims)
        ? { access: "edit" }
        : { access: "comment", reason: policy };
    case "operatorsAndEditors":
      return isOperator(claims) ||
        (board.editors?.includes(claims.user) ?? false)
        ? { access: "edit" }
        : { access: "comment", reason: policy };
    default:
      return policy satisfies never;
  }
}
