import type { Claims } from "lib/access";
import { ServiceError } from "lib/compat/error";
import type { MethodArgs, MethodName } from "lib/protocol";
import { Protocol } from "lib/protocol";
import { withUser } from "lib/typedModel/userContext";
import type { ZodType } from "zod";
import {
  deleteComment,
  editComment,
  postComment,
  react,
  setCommentResolved,
} from "./comments";
import {
  deleteEdges,
  deleteNodes,
  setLayoutLocked,
  upsertEdges,
  upsertNodes,
} from "./whiteboardEdits";
import { setEditPolicy } from "./whiteboardPolicy";
import { placeByTags, resetLayout } from "./whiteboardReset";
import type { ExportConnection } from "./whiteboardVersions";
import {
  exportBoard,
  fetchVersion,
  restoreItems,
  restoreVersion,
} from "./whiteboardVersions";

// The calls a client can make on its socket's board, by the names the
// protocol gives them, each checked against its schema and run as the
// caller (so the models stamp createdBy and updatedBy with them), as
// Meteor's methods did.

// What a method may need beyond its arguments: the connection asking, for
// an export that spans several calls.
export interface CallContext {
  connection?: ExportConnection;
}

type Handler<N extends MethodName> = (
  claims: Claims,
  boardId: string,
  args: MethodArgs<N>,
  context: CallContext,
) => Promise<unknown>;

const handlers: { [N in MethodName]: Handler<N> } = {
  upsertNodes: (claims, boardId, { nodes }) =>
    upsertNodes(claims, boardId, nodes),
  upsertEdges: (claims, boardId, { edges }) =>
    upsertEdges(claims, boardId, edges),
  deleteNodes: (claims, boardId, { nodeIds }) =>
    deleteNodes(claims, boardId, nodeIds),
  deleteEdges: (claims, boardId, { edgeIds }) =>
    deleteEdges(claims, boardId, edgeIds),
  placeByTags: (claims, boardId, { nodeIds }) =>
    placeByTags(claims, boardId, nodeIds),
  resetLayout: (claims, boardId, { putBack }) =>
    resetLayout(claims, boardId, putBack),
  restoreVersion: (claims, boardId, { versionId }) =>
    restoreVersion(claims, boardId, versionId),
  restoreItems: async (claims, boardId, { versionId, nodeIds }) => ({
    restored: await restoreItems(claims, boardId, versionId, nodeIds),
  }),
  fetchVersion: (claims, boardId, { versionId, index }) =>
    fetchVersion(claims, boardId, versionId, index),
  exportBoard: (claims, boardId, { index, hash }, { connection }) =>
    exportBoard(claims, boardId, index, hash, connection ?? null),
  setEditPolicy: (claims, boardId, { editPolicy, editors }) =>
    setEditPolicy(claims, boardId, editPolicy, editors),
  setLayoutLocked: (claims, boardId, { locked }) =>
    setLayoutLocked(claims, boardId, locked),
  "comment.post": (claims, boardId, args) => postComment(claims, boardId, args),
  "comment.edit": (claims, boardId, { messageId, text }) =>
    editComment(claims, boardId, messageId, text),
  "comment.delete": (claims, boardId, { messageId }) =>
    deleteComment(claims, boardId, messageId),
  "comment.resolve": (claims, boardId, { messageId, resolved }) =>
    setCommentResolved(claims, boardId, messageId, resolved),
  "comment.react": (claims, boardId, { messageId, emoji, on }) =>
    react(claims, boardId, messageId, emoji, on),
};

export const isMethodName = (name: string): name is MethodName =>
  name !== "live" && Object.hasOwn(handlers, name);

// Checks args against the call's schema, in the shape check() refused with.
export function parseArgs<N extends keyof typeof Protocol>(
  name: N,
  args: unknown,
): MethodArgs<N> {
  const result = (Protocol[name] as ZodType).safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join(".");
    throw new ServiceError(
      400,
      `Match error: ${issue?.message ?? "invalid arguments"}${
        path ? ` in field ${path}` : ""
      }`,
    );
  }
  return result.data as MethodArgs<N>;
}

export async function callMethod(
  name: string,
  claims: Claims,
  boardId: string,
  args: unknown,
  context: CallContext = {},
): Promise<unknown> {
  if (!isMethodName(name)) {
    throw new ServiceError(404, `Method '${name}' not found`);
  }
  const parsed = parseArgs(name, args);
  const handler = handlers[name] as Handler<typeof name>;
  return withUser(claims.user, () => handler(claims, boardId, parsed, context));
}
