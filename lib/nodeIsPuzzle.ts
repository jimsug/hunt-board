import type {
  BoardCommentContentNodeType,
  BoardCommentPuzzleNodeType,
} from "./models/BoardComments";

export default function nodeIsPuzzle(
  node: BoardCommentContentNodeType,
): node is BoardCommentPuzzleNodeType {
  return "type" in node && node.type === "puzzle";
}
