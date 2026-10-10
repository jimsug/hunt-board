import { z } from "zod";
import { allowedEmptyString, foreignKey } from "../typedModel/customTypes";
import type { ModelType } from "../typedModel/Model";
import SoftDeletedModel from "../typedModel/SoftDeletedModel";
import withCommon from "../typedModel/withCommon";

// A board's comments, replies and reactions, which in Jolly Roger were chat
// messages on the board's hidden puzzle. The fields keep chat's names, so
// the comment code reads the same here.

const UserMentionBlock = z.object({
  type: z.literal("mention"),
  userId: foreignKey,
});
export type BoardCommentMentionNodeType = z.infer<typeof UserMentionBlock>;

// A link to a puzzle in the hunt, rendered with its current title and
// solvedness.
const PuzzleBlock = z.object({
  type: z.literal("puzzle"),
  puzzleId: foreignKey,
});
export type BoardCommentPuzzleNodeType = z.infer<typeof PuzzleBlock>;

const TextBlock = z.object({
  text: allowedEmptyString,
});
export type BoardCommentTextNodeType = z.infer<typeof TextBlock>;

const ContentNode = z.union([UserMentionBlock, PuzzleBlock, TextBlock]);
export type BoardCommentContentNodeType = z.infer<typeof ContentNode>;

export const BoardCommentContent = z.object({
  type: z.literal("message"),
  children: ContentNode.array(),
});
export type BoardCommentContentType = z.infer<typeof BoardCommentContent>;

export function contentFromMessage(msg: string): BoardCommentContentType {
  return {
    type: "message" as const,
    children: [{ text: msg }],
  };
}

// Where a comment is pinned. With node, x and y are an offset from the
// node's top-left corner in board units; without, they're board coordinates.
const CommentAnchor = z.object({
  node: foreignKey.optional(),
  // The node a free pin came off when that node left the board, so a
  // restore that brings the node back can put the pin back on it.
  detachedFrom: foreignKey.optional(),
  x: z.number(),
  y: z.number(),
  resolvedAt: z.date().optional(),
  resolvedBy: foreignKey.optional(),
});
export type BoardCommentAnchorType = z.infer<typeof CommentAnchor>;

const BoardComment = withCommon(
  z.object({
    hunt: foreignKey,
    board: foreignKey,
    // What it says. A reaction's content is a single emoji (see isReaction).
    content: BoardCommentContent,
    // Who wrote it. Optional as chat's was, so the comment code and its
    // tests read the same; the server always sets it.
    sender: foreignKey.optional(),
    // When it was sent. Orders a thread.
    timestamp: z.date(),
    // The message this one replies to (or, for a reaction, the message it
    // reacts to). Always another message on the same board.
    parentId: foreignKey.optional(),
    // Set on the message that starts a comment thread. Replies and reactions
    // carry thread instead.
    comment: CommentAnchor.optional(),
    // The comment a reply (at any depth) belongs to. Written only by the
    // server.
    thread: foreignKey.optional(),
    // When the sender last changed the message's content.
    editedAt: z.date().optional(),
    // When the sender deleted the message. The content is emptied and
    // reactions go, but the message stays (shown as "Message deleted") so
    // that replies to it keep their place. Unlike `deleted`, which hides a
    // message from every finder, this one is still sent to the board.
    deletedAt: z.date().optional(),
  }),
);
const BoardComments = new SoftDeletedModel("board_comments", BoardComment);
BoardComments.addIndex({ deleted: 1, board: 1 });
BoardComments.addIndex({ hunt: 1, createdAt: 1 });
BoardComments.addIndex(
  { thread: 1 },
  { partialFilterExpression: { thread: { $exists: true } } },
);
BoardComments.addIndex(
  { board: 1, "comment.node": 1 },
  { partialFilterExpression: { comment: { $exists: true } } },
);
export type BoardCommentType = ModelType<typeof BoardComments>;

export default BoardComments;
