import { faPuzzlePiece } from "@fortawesome/free-solid-svg-icons/faPuzzlePiece";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Link } from "client/compat/router";
import ChatMarkdown from "client/components/ChatMarkdown";
import { Puzzles, useTracker } from "client/store";
import type { BoardCommentContentType } from "lib/models/BoardComments";
import nodeIsMention from "lib/nodeIsMention";
import nodeIsPuzzle from "lib/nodeIsPuzzle";
import type { Solvedness } from "lib/solvedness";
import { computeSolvedness } from "lib/solvedness";
import { useTranslation } from "react-i18next";
import styled, { css } from "styled-components";

// A comment's content, as Jolly Roger's ChatMessage drew a chat message:
// markdown text, @-mentions, and links to puzzles coloured by how solved
// they are. Images and role mentions don't exist on the board.

export const MentionSpan = styled.span<{
  $isSelf: boolean;
}>`
  padding: 2px 3px 3px;
  margin: 0 1px;
  vertical-align: baseline;
  display: inline-block;
  overflow-wrap: break-word;
  border-radius: 4px;
  color: ${({ theme }) => theme.colors.mentionSpanText};
  background-color: ${({ theme }) => theme.colors.mentionSpanBackground};
  ${({ $isSelf }) =>
    $isSelf &&
    css`
      background-color: ${({ theme }) => theme.colors.selfMentionSpanBackground};
      color: ${({ theme }) => theme.colors.selfMentionSpanText};
    `}
  font-size: 0.8rem;
`;

export const PuzzleSpan = styled.span<{
  $solvedness: Solvedness;
}>`
  padding: 2px 3px 3px;
  margin: 0 1px;
  vertical-align: baseline;
  display: inline-block;
  overflow-wrap: break-word;
  border-radius: 4px;
  color: ${({ theme }) => theme.colors.puzzleSpanText};
  background-color: ${({ $solvedness, theme }) =>
    theme.colors.solvedness[$solvedness]};
  font-size: 0.8rem;
`;

const PuzzleMention = ({ puzzleId }: { puzzleId: string }) => {
  const puzzle = useTracker(() => Puzzles.findOne(puzzleId), [puzzleId]);
  if (!puzzle) {
    return <PuzzleSpan $solvedness="noAnswers">{puzzleId}</PuzzleSpan>;
  }
  return (
    <PuzzleSpan $solvedness={computeSolvedness(puzzle)}>
      <FontAwesomeIcon icon={faPuzzlePiece} />{" "}
      <Link to={`/hunts/${puzzle.hunt}/puzzles/${puzzle._id}`}>
        {puzzle.title}
      </Link>
    </PuzzleSpan>
  );
};

const DeletedMessage = styled.div`
  color: ${({ theme }) => theme.colors.textSecondary};
  font-style: italic;
`;

const CommentText = ({
  message,
  displayNames,
  selfUserId,
  deleted = false,
}: {
  message: BoardCommentContentType;
  displayNames: Map<string, string>;
  selfUserId: string;
  // Its sender deleted it, which leaves this in its place
  deleted?: boolean;
}) => {
  const { t } = useTranslation();
  if (deleted) {
    return (
      <DeletedMessage>{t("chat.deleted", "Message deleted")}</DeletedMessage>
    );
  }

  const children = message.children.map((child, i) => {
    if (nodeIsMention(child)) {
      const displayName = displayNames.get(child.userId);
      return (
        <MentionSpan key={i} $isSelf={child.userId === selfUserId}>
          @{displayName ?? child.userId}
        </MentionSpan>
      );
    } else if (nodeIsPuzzle(child)) {
      return <PuzzleMention key={i} puzzleId={child.puzzleId} />;
    } else {
      return <ChatMarkdown key={i} text={child.text} safeLinks />;
    }
  });

  return <div>{children}</div>;
};

export default CommentText;
