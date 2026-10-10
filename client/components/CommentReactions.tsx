import { reactToBoardComment } from "client/methods";
import { reactionEmoji } from "lib/isReaction";
import type { BoardCommentType } from "lib/models/BoardComments";
import React, { useCallback, useMemo, useState } from "react";
import Overlay from "react-bootstrap/Overlay";
import styled from "styled-components";

// A comment's reactions, as Jolly Roger's ChatMessageReactions showed a chat
// message's: a pill per emoji that adds or takes back the viewer's own, and
// a picker for reacting with something new. The picker offers a short row
// of emoji in place of the full emoji-picker-react list.

type ReactionMessage = Pick<
  BoardCommentType,
  "_id" | "sender" | "content" | "parentId"
>;

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "✅", "❎", "❗", "❓"];

const ReactionContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
`;

const ReactionPill = styled.button<{ $mine: boolean }>`
  background-color: ${({ $mine, theme }) =>
    $mine
      ? theme.colors.ownReactionBackground
      : theme.colors.fancyEditorBackground};
  color: ${({ theme }) => theme.colors.text};
  padding: 2px 8px;
  margin: 2px 4px 2px 0;
  border-radius: 16px;
  cursor: pointer;
  border: 1px solid
    ${({ $mine, theme }) =>
      $mine ? theme.colors.ownReactionBorder : "transparent"};
`;

const Picker = styled.div`
  z-index: 1000;
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  background-color: ${({ theme }) => theme.colors.background};
  border: 1px solid ${({ theme }) => theme.colors.border};
  box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
`;

const PickerButton = styled.button`
  border: none;
  background: none;
  border-radius: 4px;
  font-size: 18px;
  line-height: 1;
  padding: 4px;

  &:hover {
    background: ${({ theme }) => theme.colors.chatActionHoverBackground};
  }
`;

const ReactionPillButton = ({
  emoji,
  mine,
  title,
  count,
  disabled,
  onToggle,
}: {
  emoji: string;
  mine: boolean;
  // Who reacted, one name per line
  title: string;
  count: number;
  disabled: boolean;
  onToggle: (emoji: string) => void;
}) => {
  const toggle = useCallback(() => onToggle(emoji), [onToggle, emoji]);
  return (
    <ReactionPill
      type="button"
      $mine={mine}
      title={title}
      disabled={disabled}
      onClick={toggle}
    >
      {emoji}
      {count > 1 ? ` ${count}` : ""}
    </ReactionPill>
  );
};

const PickerChoice = ({
  emoji,
  onPick,
}: {
  emoji: string;
  onPick: (emoji: string) => void;
}) => {
  const pick = useCallback(() => onPick(emoji), [onPick, emoji]);
  return (
    <PickerButton type="button" onClick={pick} aria-label={emoji}>
      {emoji}
    </PickerButton>
  );
};

const CommentReactions = ({
  messageId,
  reactions,
  displayNames,
  selfUserId,
  pickerTarget,
  showPicker,
  onHidePicker,
  onError,
  disabled = false,
}: {
  messageId: string;
  reactions: ReactionMessage[];
  displayNames: Map<string, string>;
  selfUserId: string;
  // The button that opens the picker, which the picker sits above
  pickerTarget: React.RefObject<HTMLElement | null>;
  showPicker: boolean;
  onHidePicker: () => void;
  onError: (error: unknown) => void;
  // Shows the reactions without letting the viewer add or take one back.
  disabled?: boolean;
}) => {
  // emoji -> the users who reacted with it
  const reactionsByEmoji = useMemo(() => {
    const byEmoji = new Map<string, Set<string>>();
    reactions.forEach((reaction) => {
      if (!reaction.sender) {
        return;
      }
      const emoji = reactionEmoji(reaction);
      let users = byEmoji.get(emoji);
      if (!users) {
        users = new Set();
        byEmoji.set(emoji, users);
      }
      users.add(reaction.sender);
    });
    return byEmoji;
  }, [reactions]);

  // The pills wait while a reaction is on its way to the server
  const [callsInFlight, setCallsInFlight] = useState(0);
  const toggleReaction = useCallback(
    (emoji: string) => {
      const mine = reactionsByEmoji.get(emoji)?.has(selfUserId) ?? false;
      setCallsInFlight((count) => count + 1);
      void reactToBoardComment
        .callPromise({ messageId, emoji, on: !mine })
        .catch((error: unknown) => onError(error))
        .finally(() => setCallsInFlight((count) => count - 1));
    },
    [reactionsByEmoji, selfUserId, messageId, onError],
  );

  const pickReaction = useCallback(
    (emoji: string) => {
      toggleReaction(emoji);
      onHidePicker();
    },
    [toggleReaction, onHidePicker],
  );

  return (
    <>
      <Overlay
        target={pickerTarget}
        show={showPicker}
        placement="top-start"
        rootClose
        onHide={onHidePicker}
      >
        {({
          placement: _placement,
          arrowProps: _arrowProps,
          show: _show,
          popper: _popper,
          hasDoneInitialMeasure: _hasDoneInitialMeasure,
          ...overlayProps
        }) => (
          <Picker {...overlayProps} className="nodrag nowheel nopan">
            {QUICK_REACTIONS.map((emoji) => (
              <PickerChoice key={emoji} emoji={emoji} onPick={pickReaction} />
            ))}
          </Picker>
        )}
      </Overlay>
      {reactionsByEmoji.size > 0 && (
        <ReactionContainer>
          {[...reactionsByEmoji].map(([emoji, users]) => (
            <ReactionPillButton
              key={emoji}
              emoji={emoji}
              mine={users.has(selfUserId)}
              title={[...users]
                .map((userId) => displayNames.get(userId) ?? "???")
                .toSorted()
                .join("\n")}
              count={users.size}
              disabled={disabled || callsInFlight > 0}
              onToggle={toggleReaction}
            />
          ))}
        </ReactionContainer>
      )}
    </>
  );
};

export default CommentReactions;
