import type { Claims } from "lib/access";
import { isOperator } from "lib/access";
import { ServiceError } from "lib/compat/error";
import type { WhiteboardEditPolicy } from "lib/models/Whiteboards";
import Whiteboards from "lib/models/Whiteboards";
import { Id } from "lib/typedModel/regexes";
import { MAX_WHITEBOARD_EDITORS } from "lib/whiteboard/limits";
import Logger from "./logger";
import { loadBoardAccess } from "./whiteboardShared";

// Sets who may edit a board. Only the hunt's operators may: on a hunt that
// makes every member an operator, any member could otherwise lock everyone
// else out. (Jolly Roger told its assigned operators from default-role ones;
// the token only says operator or not.) The board's change reaches the room,
// which clears the live edits of anyone who can no longer edit.
export async function setEditPolicy(
  claims: Claims,
  boardId: string,
  editPolicy: WhiteboardEditPolicy,
  editors: string[],
) {
  const { board } = await loadBoardAccess(claims, boardId);
  if (!isOperator(claims)) {
    throw new ServiceError(
      403,
      "Only the hunt's assigned operators can change who edits the whiteboard",
    );
  }
  if (!claims.mayEdit) {
    throw new ServiceError(403, "This hunt is archived");
  }

  const listed = [...new Set(editors)];
  if (!listed.every((id) => Id.test(id))) {
    throw new ServiceError(400, "Invalid user id");
  }
  if (listed.length > MAX_WHITEBOARD_EDITORS) {
    throw new ServiceError(400, "Too many people on the list");
  }

  await Whiteboards.updateAsync(board._id, {
    $set: { editPolicy, editors: listed },
  });
  Logger.info("Whiteboard edit policy changed", {
    board: board._id,
    editPolicy,
    editors: listed.length,
  });
}
