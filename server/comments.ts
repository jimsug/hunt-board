import type { Claims } from "lib/access";
import { isOperator } from "lib/access";
import { ServiceError } from "lib/compat/error";
import isReaction, { reactionEmoji } from "lib/isReaction";
import type { BoardCommentContentType } from "lib/models/BoardComments";
import BoardComments, { contentFromMessage } from "lib/models/BoardComments";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import nodeIsText from "lib/nodeIsText";
import type { CommentAnchorInput } from "lib/protocol";
import { assertCoordinate, UNCOMMENTABLE_TYPES } from "./whiteboardEdits";
import { assertMayCommentOnBoard } from "./whiteboardShared";
import withLock from "./withLock";

// A board's comments: in Jolly Roger they were chat messages on the board's
// hidden puzzle, pinned to the board, and the rules here are those of the
// chat methods they went through (send, edit, delete, remove reaction) and
// the board's own (resolve, delete a thread), on BoardComments instead.

// A reply (or reaction) that joins a comment thread adds to the board, so it
// needs a board that can be commented on, as a new comment does. A resolved
// thread would otherwise reopen on a board nobody can resolve it on again.
export async function assertMayReplyInThread(
  claims: Claims,
  boardId: string,
  parentId: string,
) {
  const parent = await BoardComments.findOneAsync(parentId, {
    projection: { board: 1, comment: 1, thread: 1 },
  });
  if (parent?.board === boardId && (parent.comment || parent.thread)) {
    await assertMayCommentOnBoard(claims, boardId);
  }
}

// Checks a new comment's pin before it's sent. It has to be on the board,
// either loose or on a node that's still showing.
export async function assertValidCommentAnchor(
  claims: Claims,
  boardId: string,
  anchor: CommentAnchorInput,
) {
  const { board } = await assertMayCommentOnBoard(claims, boardId);
  assertCoordinate(anchor.x);
  assertCoordinate(anchor.y);
  if (anchor.node !== undefined) {
    const node = await WhiteboardNodes.findOneAsync(anchor.node);
    if (
      !node ||
      node.board !== board._id ||
      node.hidden ||
      UNCOMMENTABLE_TYPES.has(node.type)
    ) {
      throw new ServiceError(400, "Comments can't be pinned there");
    }
  }
}

const isBlank = (content: BoardCommentContentType) =>
  content.children.every(
    (child) => nodeIsText(child) && child.text.trim() === "",
  );

// Writes a message to the board, as sendChatMessageInternal did: a reply at
// any depth belongs to its thread, a reaction lands once per emoji per
// person, and a reply reopens a resolved thread. The caller has checked the
// anchor or the right to reply. Returns the message's id.
async function sendMessage({
  boardId,
  huntId,
  content,
  sender,
  parentId,
  comment,
}: {
  boardId: string;
  huntId: string;
  content: BoardCommentContentType;
  sender: string;
  parentId?: string;
  comment?: CommentAnchorInput;
}) {
  // A reply at any depth in a comment thread belongs to that thread.
  let thread: string | undefined;
  if (parentId !== undefined) {
    const parent = await BoardComments.findOneAsync(parentId, {
      projection: { board: 1, comment: 1, thread: 1, deletedAt: 1 },
    });
    if (parent?.board !== boardId) {
      throw new ServiceError(
        400,
        `Message ${parentId} is not on board ${boardId}`,
      );
    }
    // A deleted message can still be replied to, but its reactions went with
    // its content and none are shown on it
    if (parent.deletedAt && isReaction({ content, parentId })) {
      throw new ServiceError(400, "That message has been deleted");
    }
    thread = parent.comment ? parent._id : parent.thread;
  }

  const insert = () =>
    BoardComments.insertAsync({
      board: boardId,
      hunt: huntId,
      content,
      sender,
      timestamp: new Date(),
      createdBy: sender,
      ...(parentId ? { parentId } : {}),
      ...(comment ? { comment } : {}),
      ...(thread ? { thread } : {}),
    });

  let msgId: string;
  if (parentId !== undefined && isReaction({ content, parentId })) {
    // One reaction per emoji per user on a message: a double click or a
    // second tab reacting again lands on the existing one. The lock keeps two
    // at once from both missing the other and inserting. The board is in the
    // selector so the { deleted, board } index serves the lookup.
    const emoji = reactionEmoji({ content, parentId });
    const reaction = await withLock(
      `board-comment:${parentId}:reactions:${sender}`,
      async () => {
        const existing = await BoardComments.find(
          { board: boardId, parentId, sender },
          { projection: { content: 1, parentId: 1 } },
        ).fetchAsync();
        const duplicate = existing.find(
          (message) => isReaction(message) && reactionEmoji(message) === emoji,
        );
        return duplicate
          ? { id: duplicate._id, isNew: false }
          : { id: await insert(), isNew: true };
      },
    );
    if (!reaction.isNew) {
      return reaction.id;
    }
    // A delete that set deletedAt after the check above may have looked for
    // reactions before this one was inserted, so it is taken back here
    // instead
    const parentNow = await BoardComments.findOneAsync(parentId, {
      projection: { deletedAt: 1 },
    });
    if (parentNow?.deletedAt) {
      await BoardComments.removeAsync(reaction.id);
      throw new ServiceError(400, "That message has been deleted");
    }
    msgId = reaction.id;
  } else if (thread) {
    // Under the thread's lock, which deleteComment holds while it checks
    // for replies and deletes, so a reply either counts or is refused.
    const rootId = thread;
    msgId = await withLock(`board-comment:${rootId}:thread`, async () => {
      const root = await BoardComments.findOneAsync(rootId, {
        projection: { _id: 1 },
      });
      if (!root) {
        throw new ServiceError(404, "That comment has been deleted");
      }
      return insert();
    });
  } else {
    msgId = await insert();
  }

  // Replying to a resolved thread reopens it. Reacting to it doesn't.
  if (thread && !isReaction({ content, parentId })) {
    await BoardComments.updateAsync(
      { _id: thread, "comment.resolvedAt": { $exists: true } },
      { $unset: { "comment.resolvedAt": 1, "comment.resolvedBy": 1 } },
    );
  }

  return msgId;
}

// A new comment pinned at anchor, or a reply to parentId. One or the other:
// every message on the board is in a thread.
export async function postComment(
  claims: Claims,
  boardId: string,
  {
    text,
    parentId,
    anchor,
  }: { text: string; parentId?: string; anchor?: CommentAnchorInput },
) {
  const content = contentFromMessage(text);
  if (isBlank(content)) {
    throw new ServiceError(400, "A comment can't be empty");
  }
  if (anchor) {
    if (parentId !== undefined) {
      throw new ServiceError(400, "A reply can't start a comment thread");
    }
    await assertValidCommentAnchor(claims, boardId, anchor);
  } else if (parentId !== undefined) {
    await assertMayReplyInThread(claims, boardId, parentId);
  } else {
    throw new ServiceError(400, "A comment needs a pin or a parent");
  }
  const { board } = await assertMayCommentOnBoard(claims, boardId);
  return sendMessage({
    boardId,
    huntId: board.hunt,
    content,
    sender: claims.user,
    parentId,
    comment: anchor,
  });
}

// Adds the caller's reaction to a message, once per emoji, or takes it
// back. Taking one back is a hard delete: it undoes a click, so there's
// nothing worth keeping to undelete.
export async function react(
  claims: Claims,
  boardId: string,
  messageId: string,
  emoji: string,
  on: boolean,
) {
  const content = contentFromMessage(emoji);
  if (!isReaction({ content, parentId: messageId })) {
    throw new ServiceError(400, "A reaction is an emoji");
  }
  if (on) {
    await assertMayReplyInThread(claims, boardId, messageId);
    const { board } = await assertMayCommentOnBoard(claims, boardId);
    return sendMessage({
      boardId,
      huntId: board.hunt,
      content,
      sender: claims.user,
      parentId: messageId,
    });
  }
  // Only the sender's own reactions are looked at, so someone else's answers
  // the same as none
  const own = await BoardComments.find(
    { board: boardId, parentId: messageId, sender: claims.user },
    { projection: { content: 1, parentId: 1 } },
  ).fetchAsync();
  const wanted = reactionEmoji({ content, parentId: messageId });
  const mine = own.filter(
    (message) => isReaction(message) && reactionEmoji(message) === wanted,
  );
  if (mine.length > 0) {
    await BoardComments.removeAsync({ _id: { $in: mine.map((m) => m._id) } });
  }
  return undefined;
}

// Changes a message's text. Only the sender may; looking the message up by
// sender means someone else's answers the same as an unknown id.
export async function editComment(
  claims: Claims,
  boardId: string,
  messageId: string,
  text: string,
) {
  const message = await BoardComments.findOneAsync({
    _id: messageId,
    board: boardId,
    sender: claims.user,
  });
  if (!message) {
    throw new ServiceError(404, "Unknown message");
  }
  if (message.deletedAt) {
    throw new ServiceError(400, "That message has been deleted");
  }
  if (isReaction(message)) {
    throw new ServiceError(400, "A reaction can't be edited");
  }
  // A comment or a reply in a comment thread is part of the board, so it
  // needs a board that can still be commented on, as a new reply does
  await assertMayCommentOnBoard(claims, boardId);

  const contentObj = contentFromMessage(text);
  if (isBlank(contentObj)) {
    throw new ServiceError(400, "A message can't be edited to nothing");
  }
  // A reply that became only an emoji would turn into a reaction and
  // vanish from the history
  if (
    message.parentId &&
    isReaction({ content: contentObj, parentId: message.parentId })
  ) {
    throw new ServiceError(400, "A reply can't be edited into a reaction");
  }

  // Only the content and when it changed are written, so a reply or comment
  // pin stays as it is. A delete that lands first wins.
  await BoardComments.updateAsync(
    { _id: messageId, deletedAt: { $exists: false } },
    { $set: { content: contentObj, editedAt: new Date() } },
  );
}

async function rootCommentForWrite(
  claims: Claims,
  boardId: string,
  messageId: string,
) {
  const message = await BoardComments.findOneAsync(messageId);
  if (!message?.comment || message.board !== boardId) {
    throw new ServiceError(404, "Unknown comment");
  }
  await assertMayCommentOnBoard(claims, boardId);
  return message;
}

export async function setCommentResolved(
  claims: Claims,
  boardId: string,
  messageId: string,
  resolved: boolean,
) {
  await rootCommentForWrite(claims, boardId, messageId);
  if (!resolved) {
    await BoardComments.updateAsync(messageId, {
      $unset: { "comment.resolvedAt": 1, "comment.resolvedBy": 1 },
    });
    return;
  }

  // Resolving twice keeps the first resolution.
  await BoardComments.updateAsync(
    { _id: messageId, "comment.resolvedAt": { $exists: false } },
    {
      $set: {
        "comment.resolvedAt": new Date(),
        "comment.resolvedBy": claims.user,
      },
    },
  );
}

// Authors can take back a comment until someone else replies to it. Operators
// can always delete one. The whole thread goes with it. Replies are written
// under the thread's lock (see sendMessage), so one can't land between the
// check for replies and the delete.
export async function deleteThread(
  claims: Claims,
  boardId: string,
  messageId: string,
) {
  const userId = claims.user;
  const message = await rootCommentForWrite(claims, boardId, messageId);
  await withLock(`board-comment:${messageId}:thread`, async () => {
    if (!isOperator(claims)) {
      if (message.sender !== userId) {
        throw new ServiceError(403, "Only its author can delete a comment");
      }
      const othersReplies = await BoardComments.find({
        thread: messageId,
        sender: { $ne: userId },
      }).fetchAsync();
      if (othersReplies.some((reply) => !isReaction(reply))) {
        throw new ServiceError(
          403,
          "Someone has replied, so only an operator can delete this comment",
        );
      }
    }

    await BoardComments.destroyAsync({
      $or: [{ _id: messageId }, { thread: messageId }],
    });
  });
}

// Empties a reply in place, as deleting a chat message did: the message
// stays, so replies to it keep their place and their links back to it, and
// its reactions go with it. Only the sender may.
export async function deleteReply(
  claims: Claims,
  boardId: string,
  messageId: string,
) {
  const message = await BoardComments.findOneAsync({
    _id: messageId,
    board: boardId,
    sender: claims.user,
  });
  if (!message) {
    throw new ServiceError(404, "Unknown message");
  }
  if (isReaction(message)) {
    throw new ServiceError(400, "A reaction is taken back, not deleted");
  }
  if (message.deletedAt) {
    return;
  }
  await assertMayCommentOnBoard(claims, boardId);

  await BoardComments.updateAsync(
    { _id: messageId, deletedAt: { $exists: false } },
    {
      $set: {
        content: { type: "message", children: [] },
        deletedAt: new Date(),
      },
      $unset: { editedAt: 1 },
    },
  );

  // Reactions are shown on the message, so they go with it. Hard deletes,
  // as when a reaction is taken back.
  const reactions = (
    await BoardComments.find(
      { board: boardId, parentId: messageId },
      { projection: { content: 1, parentId: 1 } },
    ).fetchAsync()
  ).filter((reply) => isReaction(reply));
  if (reactions.length > 0) {
    await BoardComments.removeAsync({
      _id: { $in: reactions.map((reaction) => reaction._id) },
    });
  }
}

// Deletes a comment: a thread's root takes the thread with it, a reply is
// emptied in place.
export async function deleteComment(
  claims: Claims,
  boardId: string,
  messageId: string,
) {
  const message = await BoardComments.findOneAsync(messageId, {
    projection: { comment: 1 },
  });
  if (message?.comment) {
    await deleteThread(claims, boardId, messageId);
  } else {
    await deleteReply(claims, boardId, messageId);
  }
}
