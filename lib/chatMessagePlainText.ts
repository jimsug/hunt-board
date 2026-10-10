import type { BoardCommentContentType } from "./models/BoardComments";
import nodeIsMention from "./nodeIsMention";
import nodeIsPuzzle from "./nodeIsPuzzle";
import nodeIsText from "./nodeIsText";

// How a comment flattens: where mentioned names and linked titles come from
// (anything they can't find reads as ???), whether mentions are padded with
// a space either side, what a puzzle link becomes, and what goes between
// nodes.
type FlattenOptions = {
  displayName: (userId: string) => string | undefined;
  puzzleTitle: (puzzleId: string) => string | undefined;
  spacedMentions: boolean;
  puzzleLink: (title: string) => string;
  separator: string;
};

function flatten(
  content: BoardCommentContentType,
  {
    displayName,
    puzzleTitle,
    spacedMentions,
    puzzleLink,
    separator,
  }: FlattenOptions,
): string {
  const mention = (name: string) =>
    spacedMentions ? ` @${name} ` : `@${name}`;
  return content.children
    .map((child) => {
      if (nodeIsText(child)) {
        return child.text;
      }
      if (nodeIsMention(child)) {
        return mention(displayName(child.userId) ?? "???");
      }
      if (nodeIsPuzzle(child)) {
        return puzzleLink(puzzleTitle(child.puzzleId) ?? "???");
      }
      child satisfies never;
      return "";
    })
    .join(separator);
}

// Flattens a comment to one line of text for places that can't render it
// (the Comments panel's rows). Mentions and puzzle links are shown by name
// when the caller can resolve them.
export default function chatMessagePlainText(
  content: BoardCommentContentType,
  displayNames?: Map<string, string>,
  puzzleTitles?: Map<string, string>,
): string {
  return flatten(content, {
    displayName: (userId) => displayNames?.get(userId),
    puzzleTitle: (puzzleId) => puzzleTitles?.get(puzzleId),
    spacedMentions: false,
    puzzleLink: (title) => `[${title}]`,
    separator: "",
  });
}

// The first line of some text that has anything on it, trimmed, or "" when
// there is none. Comment lists and toasts show a message by its first line.
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
