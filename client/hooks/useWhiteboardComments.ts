import { BoardComments, useTracker } from "client/store";
import isReaction from "lib/isReaction";
import type { BoardCommentType } from "lib/models/BoardComments";
import type { CommentThread } from "lib/whiteboard/comments";
import { groupThreads } from "lib/whiteboard/comments";
import { useCallback, useMemo } from "react";
import { useWhiteboardCommentsSeen } from "./persisted-state";

type BoardThread = CommentThread<BoardCommentType>;

// The board's comment threads, from the comments the snapshot and its
// changes bring.
export default function useWhiteboardComments(boardId: string) {
  const messages = useTracker(
    () =>
      BoardComments.find(
        { board: boardId },
        { sort: { timestamp: 1 } },
      ).fetch(),
    [boardId],
  );
  return useMemo(() => groupThreads(messages, isReaction), [messages]);
}

// When this viewer last read each thread, so pins can show what's new.
export function useSeenComments(
  boardId: string,
  threads: Map<string, BoardThread>,
) {
  const [seen, setSeen] = useWhiteboardCommentsSeen(boardId);

  const markSeen = useCallback(
    (threadId: string, at: number) => {
      if ((seen[threadId] ?? 0) >= at) return;
      // Forget threads that have since been deleted.
      setSeen((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([id]) => threads.has(id)),
        ),
        [threadId]: at,
      }));
    },
    [seen, setSeen, threads],
  );
  return [seen, markSeen] as const;
}
