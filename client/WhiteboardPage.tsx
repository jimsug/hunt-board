import type { WhiteboardAccess, WhiteboardAccessReason } from "client/access";
import type { BoardFocus } from "client/components/whiteboard/BoardFocusContext";
import BoardFocusContext from "client/components/whiteboard/BoardFocusContext";
import WhiteboardCanvas from "client/components/whiteboard/WhiteboardCanvas";
import { useWhiteboardHideInk } from "client/hooks/persisted-state";
import type { Session } from "client/session";
import { connection, useTracker, Whiteboards, welcome } from "client/store";
import {
  BOARD_TARGET_PARAMS,
  boardTargetFromParams,
} from "lib/whiteboard/links";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "usehooks-ts";

// The board page, as Jolly Roger's WhiteboardPage was without the puzzle
// page round it: the canvas, with what the viewer may do worked out from
// the welcome and the board, and a note in place of the board when the
// socket has closed for good.

// Jolly Roger's PuzzlePage breakpoint: its narrowest sidebar and document
// side by side.
const MinimumDesktopWidth = 576;

// A phone, upright or on its side: narrower than PuzzlePage's own breakpoint,
// or a touch screen too short for the toolbar and a thread. A compact board
// can be looked at and commented on, but not edited.
const compactQuery = `(max-width: ${MinimumDesktopWidth - 1}px), (pointer: coarse) and (max-height: 575px)`;

// The page's query string, read once and rewritten in place as links are
// followed (React Router's useSearchParams, without the router).
function useSearchParams() {
  const [params, setParams] = useState(
    () => new URLSearchParams(window.location.search),
  );
  const update = useCallback(
    (change: (params: URLSearchParams) => URLSearchParams) => {
      setParams((current) => {
        const next = change(new URLSearchParams(current));
        const query = next.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
        );
        return next;
      });
    },
    [],
  );
  return [params, update] as const;
}

const WhiteboardPage = ({ session }: { session: Session }) => {
  const { t } = useTranslation();
  const current = useTracker(() => welcome.get(), []);
  const state = useTracker(() => connection.get(), []);
  const boardId = current?.board;
  const board = useTracker(
    () => (boardId ? Whiteboards.findOne(boardId) : undefined),
    [boardId],
  );
  const connected = state.status === "open";
  const compact = useMediaQuery(compactQuery);
  // A touch screen, which edits by touch unless it's compact.
  const coarse = useMediaQuery("(pointer: coarse)");

  // What the welcome and the board's policy make of the viewer. The server
  // re-sends the welcome when the token is renewed and the board document
  // when its policy changes, so this follows both.
  const editPolicy = board?.editPolicy ?? "members";
  let access: WhiteboardAccess = current?.access ?? "none";
  let accessReason: WhiteboardAccessReason | undefined;
  if (current && !current.mayEdit && access !== "none") {
    accessReason = "archived";
  } else if (access === "comment" && editPolicy !== "members") {
    accessReason = editPolicy;
  }
  if (access !== "none" && !connected) {
    // Nothing holds an edit made while disconnected, so the board is
    // view-only until the socket is back.
    access = "view";
    accessReason = "offline";
  } else if (access === "edit" && compact) {
    access = "comment";
    accessReason = "narrow";
  }
  const isOperator = current?.operator ?? false;
  const isAssignedOperator = current?.assignedOperator ?? false;

  // Ink is left out of the snapshot for a viewer who hides it, which takes
  // a fresh socket.
  const [hideInk, setHideInk] = useWhiteboardHideInk();
  useEffect(() => {
    session.setHideInk(hideInk);
  }, [session, hideInk]);

  const [searchParams, setSearchParams] = useSearchParams();
  const initialComment = searchParams.get("comment") ?? undefined;
  const clearInitialComment = useCallback(
    () =>
      setSearchParams((params) => {
        params.delete("comment");
        return params;
      }),
    [setSearchParams],
  );
  // A ?puzzle=, ?node= or ?v= link, read once per link. Each of them is
  // dropped once it's been shown, as is a ?v= that doesn't make sense.
  const puzzleParam = searchParams.get("puzzle") ?? undefined;
  const nodeParam = searchParams.get("node") ?? undefined;
  const viewParam = searchParams.get("v") ?? undefined;
  const initialTarget = useMemo(
    () =>
      boardTargetFromParams({
        puzzle: puzzleParam,
        node: nodeParam,
        v: viewParam,
      }),
    [puzzleParam, nodeParam, viewParam],
  );
  const clearInitialTarget = useCallback(
    () =>
      setSearchParams((params) => {
        BOARD_TARGET_PARAMS.forEach((name) => params.delete(name));
        return params;
      }),
    [setSearchParams],
  );
  const hasBadView = !initialTarget && !!viewParam;
  useEffect(() => {
    if (hasBadView) clearInitialTarget();
  }, [hasBadView, clearInitialTarget]);
  const focusRef = useRef<((threadId: string) => void) | undefined>(undefined);
  const boardFocus: BoardFocus = useMemo(
    () => ({
      focusComment: (threadId) => {
        if (focusRef.current) return focusRef.current(threadId);
        setSearchParams((params) => {
          params.set("comment", threadId);
          return params;
        });
      },
    }),
    [setSearchParams],
  );

  if (state.status === "expired") {
    return (
      <Alert variant="warning" className="jr-board-message">
        {t(
          "whiteboard.service.expired",
          "Your session on the board has ended. Reload to continue.",
        )}
      </Alert>
    );
  }
  if (state.status === "closed") {
    let message: string;
    switch (state.code) {
      case 4503:
        message = t("whiteboard.disabled", "The whiteboard is turned off.");
        break;
      case 4404:
        message = t(
          "whiteboard.service.noBoard",
          "There's no board for this hunt yet.",
        );
        break;
      case 4403:
        message = t(
          "whiteboard.service.forbidden",
          "You can't open this board.",
        );
        break;
      default:
        message = t(
          "whiteboard.service.closed",
          "The board couldn't be opened. Reload to try again.",
        );
    }
    return (
      <Alert variant="info" className="jr-board-message">
        {message}
      </Alert>
    );
  }
  if (!current || !board || !boardId) {
    return (
      <div className="jr-board-message">
        {t("common.loading", "loading")}...
      </div>
    );
  }

  return (
    <BoardFocusContext value={boardFocus}>
      <div className="jr-board-page">
        <div className="jr-board-canvas">
          <WhiteboardCanvas
            boardId={boardId}
            huntId={board.hunt}
            access={access}
            accessReason={accessReason}
            mayChangeEditPolicy={isAssignedOperator && access !== "view"}
            editPolicy={editPolicy}
            editors={board.editors ?? []}
            isOperator={isOperator}
            showMiniMap={!compact}
            compact={compact}
            coarse={coarse && !compact}
            boardLoaded={connected}
            hideInk={hideInk}
            onHideInkChange={setHideInk}
            focusRef={focusRef}
            initialComment={initialComment}
            onInitialCommentShown={clearInitialComment}
            initialTarget={initialTarget}
            onInitialTargetShown={clearInitialTarget}
          />
        </div>
      </div>
    </BoardFocusContext>
  );
};

export default WhiteboardPage;
