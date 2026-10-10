import type {
  BoardCommentContentNodeType,
  BoardCommentMentionNodeType,
} from "./models/BoardComments";

export default function nodeIsMention(
  node: BoardCommentContentNodeType,
): node is BoardCommentMentionNodeType {
  return "type" in node && node.type === "mention";
}
