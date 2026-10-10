import { z } from "zod";
import { foreignKey } from "../typedModel/customTypes";
import type { ModelType } from "../typedModel/Model";
import Model from "../typedModel/Model";
import withCommon from "../typedModel/withCommon";

// Who may edit the board. Unset means "members". Everyone in the hunt can
// view the board and comment on it whatever this says.
export const WhiteboardEditPolicies = [
  "members",
  "operators",
  "operatorsAndEditors",
] as const;
export type WhiteboardEditPolicy = (typeof WhiteboardEditPolicies)[number];

const Whiteboard = withCommon(
  z.object({
    hunt: foreignKey,
    // The puzzle the board is scoped to, for a puzzle's board; unset on the
    // hunt's board, the one placement puts cards on.
    puzzle: foreignKey.optional(),
    // Set by Jolly Roger once the hunt is archived. Access is the token's
    // business; this only lets history thin sooner.
    archived: z.boolean().optional(),
    editPolicy: z.enum(WhiteboardEditPolicies).optional(),
    // The people besides operators who may edit under "operatorsAndEditors".
    // Kept under the other policies, so switching back doesn't lose it.
    editors: foreignKey.array().optional(),
    // Set when pruning drops versions from the board's history: the newest
    // one it dropped was taken then.
    versionsPrunedBefore: z.date().optional(),
    // When a reset or restore last finished rewriting the board. Edits after
    // it never extend or join a version from before it.
    lastRewrittenAt: z.date().optional(),
  }),
);

const Whiteboards = new Model("jr_whiteboards", Whiteboard);
// One board per scope: the hunt's own (no puzzle) and one per puzzle
Whiteboards.addIndex({ hunt: 1, puzzle: 1 }, { unique: true });
export type WhiteboardType = ModelType<typeof Whiteboards>;

export default Whiteboards;
