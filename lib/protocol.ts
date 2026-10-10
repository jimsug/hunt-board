import { z } from "zod";
import {
  WhiteboardArrowHeads,
  WhiteboardPathStyles,
} from "./models/WhiteboardEdges";
import {
  WhiteboardColors,
  WhiteboardNodeKinds,
  WhiteboardShapes,
  WhiteboardStrokeWidths,
} from "./models/WhiteboardNodes";
import { WhiteboardEditPolicies } from "./models/Whiteboards";

// The argument shapes of every call a client can make, one schema per call,
// shared with the client for typing. They mirror the check() patterns the
// methods had in Jolly Roger: the board is the socket's, so none of them
// carries a boardId, and an unknown key is refused as check() refused it.

const point = z.strictObject({ x: z.number(), y: z.number() });

// An ink sample's shape, [x, y, pressure]. Whether it's on the board is up
// to isInkPoint.
export const InkPoint = z.tuple([z.number(), z.number(), z.number()]);

const Ids = z.string().array();

// Creates or updates nodes on a board. New nodes carry a client-generated _id
// so the client can refer to them before the server echoes them back. Fields
// left out are left alone; null clears a field.
export const NodeInput = z.strictObject({
  _id: z.string(),
  type: z.enum(WhiteboardNodeKinds).optional(),
  puzzle: z.string().optional(),
  position: point.optional(),
  parent: z.string().nullable().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  hidden: z.boolean().optional(),
  // Frames only: true folds the frame for everyone, false opens it.
  collapsed: z.boolean().optional(),
  // Existing nodes only, not points: true locks the node for the caller,
  // false unlocks it (for whoever locked it, or an operator).
  locked: z.boolean().optional(),
  text: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  color: z.enum(WhiteboardColors).nullable().optional(),
  points: InkPoint.array().optional(),
  strokeWidth: z.enum(WhiteboardStrokeWidths).optional(),
  stroke: z.string().optional(),
  // New image nodes only: an upload to the image bucket and its size in
  // pixels.
  image: z
    .strictObject({ url: z.string(), width: z.number(), height: z.number() })
    .optional(),
  // New shape nodes only: which shape.
  shape: z.enum(WhiteboardShapes).optional(),
});
export type WhiteboardNodeInput = z.infer<typeof NodeInput>;

export const EdgeInput = z.strictObject({
  _id: z.string(),
  source: z.string().optional(),
  target: z.string().optional(),
  label: z.string().nullable().optional(),
  pathStyle: z.enum(WhiteboardPathStyles).optional(),
  arrowHead: z.enum(WhiteboardArrowHeads).optional(),
  // null clears it, back to the theme's text colour.
  color: z.enum(WhiteboardColors).nullable().optional(),
  dashed: z.boolean().optional(),
  // Only false, which puts back a feeder arrow someone deleted. Nothing else
  // can be hidden or unhidden from here.
  hidden: z.boolean().optional(),
});
export type WhiteboardEdgeInput = z.infer<typeof EdgeInput>;

// Where a new comment is pinned.
export const CommentAnchorInput = z.strictObject({
  node: z.string().optional(),
  x: z.number(),
  y: z.number(),
});
export type CommentAnchorInput = z.infer<typeof CommentAnchorInput>;

export const BoardView = z.strictObject({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

export const Live = z.strictObject({
  cursor: point.nullable(),
  // Positions are relative to `parent`, the frame the node is in (or the
  // board), so others can tell a drag apart from a later move between frames.
  drag: z
    .strictObject({
      node: z.string(),
      x: z.number(),
      y: z.number(),
      parent: z.string().nullable().optional(),
    })
    .array()
    .nullable(),
  stroke: z
    .strictObject({
      color: z.enum(WhiteboardColors),
      strokeWidth: z.enum(WhiteboardStrokeWidths),
      points: InkPoint.array(),
    })
    .nullable(),
  // The nodes selected, and the node or line whose text is being typed in.
  // Optional so a tab still running an older client isn't refused.
  selection: z.string().array().nullable().optional(),
  editing: z.string().nullable().optional(),
  // Refreshed every EDITING_KEEPALIVE_MS while editing is set, so the
  // presence changes while someone types.
  editingAt: z.date().nullable().optional(),
  // What the sender is looking at (the point at the centre of their canvas,
  // and their zoom), null while their tab is hidden, and who they're
  // following, if anyone. Optional for the same reason.
  view: BoardView.nullable().optional(),
  followedUser: z.string().nullable().optional(),
});
export type WhiteboardLiveState = z.infer<typeof Live>;

export const Protocol = {
  upsertNodes: z.strictObject({ nodes: NodeInput.array() }),
  upsertEdges: z.strictObject({ edges: EdgeInput.array() }),
  deleteNodes: z.strictObject({ nodeIds: Ids }),
  deleteEdges: z.strictObject({ edgeIds: Ids }),
  // Node ids, not puzzle ids
  placeByTags: z.strictObject({ nodeIds: Ids }),
  resetLayout: z.strictObject({ putBack: z.boolean() }),
  restoreVersion: z.strictObject({ versionId: z.string() }),
  restoreItems: z.strictObject({ versionId: z.string(), nodeIds: Ids }),
  // One chunk of a version's gzipped payload, by index
  fetchVersion: z.strictObject({
    versionId: z.string(),
    index: z.number().int(),
  }),
  // One chunk of the board as it is now, in a version's payload format
  exportBoard: z.strictObject({
    index: z.number().int(),
    hash: z.string().optional(),
  }),
  setEditPolicy: z.strictObject({
    editPolicy: z.enum(WhiteboardEditPolicies),
    editors: Ids,
  }),
  setLayoutLocked: z.strictObject({ locked: z.boolean() }),
  // A new comment pinned at anchor, or a reply (at any depth) to parentId
  "comment.post": z.strictObject({
    text: z.string(),
    parentId: z.string().optional(),
    anchor: CommentAnchorInput.optional(),
  }),
  "comment.edit": z.strictObject({ messageId: z.string(), text: z.string() }),
  // A root comment goes with its whole thread; a reply is emptied in place
  "comment.delete": z.strictObject({ messageId: z.string() }),
  "comment.resolve": z.strictObject({
    messageId: z.string(),
    resolved: z.boolean(),
  }),
  // on adds the caller's reaction with that emoji (once), off takes it back
  "comment.react": z.strictObject({
    messageId: z.string(),
    emoji: z.string(),
    on: z.boolean(),
  }),
  live: Live,
} as const;

export type MethodName = Exclude<keyof typeof Protocol, "live">;
export type MethodArgs<N extends keyof typeof Protocol> = z.infer<
  (typeof Protocol)[N]
>;

// The token's claims, as Jolly Roger signs them.
export const ClaimsSchema = z.strictObject({
  v: z.literal(1),
  scope: z.strictObject({ hunt: z.string(), puzzle: z.string().optional() }),
  user: z.string(),
  name: z.string(),
  mayEdit: z.boolean(),
  exp: z.number(),
  operator: z.boolean().optional(),
});
