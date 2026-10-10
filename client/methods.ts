import { ServiceError } from "lib/compat/error";
import type { MethodArgs, MethodName, WhiteboardLiveState } from "lib/protocol";
import type { Session } from "./session";

// The calls the board makes, in the shape of Jolly Roger's TypedMethod
// objects (call with a callback, or callPromise), so the code that makes
// them reads the same. Each takes the method's arguments with the boardId
// the Meteor methods wanted, and leaves the boardId out: the socket's board
// is implied.

type WithBoard<A> = A & { boardId?: string };

type Callback<Return> = (error?: ServiceError, result?: Return) => void;

let current: Session | undefined;

// The session the calls go through, set by the page when it opens one
export function setSession(session: Session | undefined) {
  current = session;
}

function stripBoard(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const { boardId: _boardId, ...rest } = args as { boardId?: string };
  return rest;
}

export class TypedCall<N extends MethodName, Return> {
  constructor(readonly name: N) {}

  call(args: WithBoard<MethodArgs<N>>, callback?: Callback<Return>): void {
    void this.callPromise(args).then(
      (result) => callback?.(undefined, result),
      (error: unknown) => {
        callback?.(
          error instanceof ServiceError
            ? error
            : new ServiceError(500, String(error)),
        );
      },
    );
  }

  async callPromise(args: WithBoard<MethodArgs<N>>): Promise<Return> {
    if (!current) throw new ServiceError(503, "Not connected");
    return (await current.call(this.name, stripBoard(args))) as Return;
  }
}

const method = <N extends MethodName, Return = void>(name: N) =>
  new TypedCall<N, Return>(name);

export const upsertWhiteboardNodes = method("upsertNodes");
export const upsertWhiteboardEdges = method("upsertEdges");
export const deleteWhiteboardNodes = method("deleteNodes");
export const deleteWhiteboardEdges = method("deleteEdges");
export const placeWhiteboardCardsByTags = method("placeByTags");
export const resetWhiteboardLayout = method("resetLayout");
export const restoreWhiteboardVersion = method("restoreVersion");
export const restoreWhiteboardItems = method<
  "restoreItems",
  { restored: boolean }
>("restoreItems");
export const fetchWhiteboardVersion = method<"fetchVersion", Uint8Array>(
  "fetchVersion",
);
export const exportWhiteboard = method<
  "exportBoard",
  { data: Uint8Array; chunkCount: number; hash: string }
>("exportBoard");
export const setWhiteboardEditPolicy = method("setEditPolicy");
export const setWhiteboardLayoutLocked = method("setLayoutLocked");
export const postBoardComment = method<"comment.post", string>("comment.post");
export const editBoardComment = method("comment.edit");
export const deleteBoardComment = method("comment.delete");
export const setBoardCommentResolved = method("comment.resolve");
export const reactToBoardComment = method("comment.react");

// A live update isn't a call: nothing answers it. Shaped like one so
// useWhiteboardLive reads as it did.
export const setWhiteboardLive = {
  call(args: WithBoard<WhiteboardLiveState>): void {
    current?.sendLive(stripBoard(args) as WhiteboardLiveState);
  },
};
