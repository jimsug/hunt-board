import type {
  BoardCommentContentNodeType,
  BoardCommentTextNodeType,
} from "./models/BoardComments";

export default function nodeIsText(
  node: BoardCommentContentNodeType,
): node is BoardCommentTextNodeType {
  return "text" in node;
}
