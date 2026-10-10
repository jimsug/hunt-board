import { ViewportPortal } from "@xyflow/react";
import { userColors } from "client/components/Avatar";
import useDocumentVisible from "client/hooks/useDocumentVisible";
import { useWhiteboardZoom } from "client/hooks/useWhiteboardDetail";
import useWhiteboardNames from "client/hooks/useWhiteboardNames";
import { useTracker, WhiteboardPresence } from "client/store";
import { inkPath } from "lib/whiteboard/ink";
import React, { useEffect, useState } from "react";
import styled, { css, useTheme } from "styled-components";
import colors from "./colors";
import { markerBlend, strokeOpacity } from "./marker";

const IDLE_AFTER = 10_000;
// Each hop glides for as long as the gap since the last one, so the cursor
// never sits still between updates, within these bounds.
const MIN_HOP_MS = 60;
const MAX_HOP_MS = 250;

const Cursor = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
  transition:
    transform var(--hop, 120ms) linear,
    opacity 600ms ease;
  z-index: 1000;
`;

const NamePill = styled.div<{ $background: string; $text: string }>`
  position: absolute;
  left: 14px;
  top: 16px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;
  background: ${({ $background }) => $background};
  color: ${({ $text }) => $text};
`;

const StrokeSvg = styled.svg<{ $marker: boolean }>`
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
  opacity: 0.6;
  ${({ $marker, theme }) =>
    $marker &&
    css`
      mix-blend-mode: ${markerBlend(theme)};
    `}
`;

// Where a tab's pointer was, when it got there, and how long the hop there
// is drawn over (the gap since the hop before).
interface PointerSeen {
  key: string;
  at: number;
  hop: number;
}

// Other people's pointers and their half-drawn ink. Everything is placed in
// flow coordinates, so it lines up whatever each person's zoom or screen size.
// Pointers move constantly, so only this layer follows them.
const CursorLayer = ({
  boardId,
  liveEnabled,
}: {
  boardId: string;
  liveEnabled: boolean;
}) => {
  const presence = useTracker(
    () =>
      liveEnabled ? WhiteboardPresence.find({ board: boardId }).fetch() : [],
    [boardId, liveEnabled],
  );
  const zoom = useWhiteboardZoom();
  const theme = useTheme();
  const visible = useDocumentVisible();
  const [now, setNow] = useState(Date.now());
  // When each tab's pointer last moved, so idle ones can fade out. Tabs that
  // have gone are forgotten.
  const [lastMoved, setLastMoved] = useState(
    () => new Map<string, PointerSeen>(),
  );
  useEffect(() => {
    setLastMoved((previous) => {
      const next = new Map<string, PointerSeen>();
      const now = Date.now();
      presence.forEach((doc) => {
        const key = JSON.stringify(doc.cursor);
        const seen = previous.get(doc._id);
        if (seen?.key === key) {
          next.set(doc._id, seen);
          return;
        }
        const hop = seen
          ? Math.min(MAX_HOP_MS, Math.max(MIN_HOP_MS, now - seen.at))
          : MIN_HOP_MS;
        next.set(doc._id, { key, at: now, hop });
      });
      return next;
    });
  }, [presence]);

  // Ticks while anyone's pointer is on the board and this tab can be seen, so
  // idle ones fade out.
  const anyCursors = presence.some((doc) => doc.cursor);
  useEffect(() => {
    if (!anyCursors || !visible) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [anyCursors, visible]);

  const names = useWhiteboardNames(presence.map((doc) => doc.user));

  return (
    <ViewportPortal>
      {presence.map((doc) => {
        const [background, text] = userColors(doc.user);
        const stroke = doc.stroke ? (
          <StrokeSvg
            key={`${doc._id}-stroke`}
            $marker={doc.stroke.strokeWidth === "marker"}
          >
            <path
              d={inkPath(doc.stroke.points, doc.stroke.strokeWidth, false)}
              fill={colors.stroke[doc.stroke.color] ?? theme.colors.text}
              fillOpacity={strokeOpacity(doc.stroke.strokeWidth)}
            />
          </StrokeSvg>
        ) : null;
        if (!doc.cursor) return stroke;
        const seen = lastMoved.get(doc._id);
        const idle = now - (seen?.at ?? now) > IDLE_AFTER;
        return (
          <React.Fragment key={doc._id}>
            {stroke}
            <Cursor
              style={
                {
                  transform: `translate(${doc.cursor.x}px, ${doc.cursor.y}px) scale(${1 / zoom})`,
                  opacity: idle ? 0 : 1,
                  "--hop": `${seen?.hop ?? MIN_HOP_MS}ms`,
                } as React.CSSProperties
              }
            >
              <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden>
                <path
                  d="M1 1 L1 17 L5.5 13 L9 21 L12 19.5 L8.5 12 L15 12 Z"
                  fill={background}
                  stroke={theme.colors.whiteboardCursorOutline}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <NamePill $background={background} $text={text}>
                {names.get(doc.user)}
              </NamePill>
            </Cursor>
          </React.Fragment>
        );
      })}
    </ViewportPortal>
  );
};

export default React.memo(CursorLayer);
