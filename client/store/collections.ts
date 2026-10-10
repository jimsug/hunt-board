import type { BoardCommentType } from "lib/models/BoardComments";
import BoardCommentsModel from "lib/models/BoardComments";
import type { PuzzleType } from "lib/models/Puzzles";
import PuzzlesModel from "lib/models/Puzzles";
import type { TagType } from "lib/models/Tags";
import TagsModel from "lib/models/Tags";
import type { WhiteboardEdgeType } from "lib/models/WhiteboardEdges";
import WhiteboardEdgesModel from "lib/models/WhiteboardEdges";
import type { WhiteboardNodeType } from "lib/models/WhiteboardNodes";
import WhiteboardNodesModel from "lib/models/WhiteboardNodes";
import type { WhiteboardType } from "lib/models/Whiteboards";
import WhiteboardsModel from "lib/models/Whiteboards";
import type { WhiteboardVersionType } from "lib/models/WhiteboardVersions";
import WhiteboardVersionsModel from "lib/models/WhiteboardVersions";
import type {
  Change,
  Presence,
  Snapshot,
  Welcome,
  WhiteboardLiveState,
} from "lib/protocol";
import { Collection } from "./collection";

// The client's copy of each server collection, under the names the board's
// code used for Jolly Roger's models, plus presence and the people seen on
// the board. Fed by applyWelcome and applyMessage from the session.

export const Whiteboards = new Collection<WhiteboardType>(
  WhiteboardsModel.name,
);
export const WhiteboardNodes = new Collection<WhiteboardNodeType>(
  WhiteboardNodesModel.name,
);
export const WhiteboardEdges = new Collection<WhiteboardEdgeType>(
  WhiteboardEdgesModel.name,
);
export const WhiteboardVersions = new Collection<WhiteboardVersionType>(
  WhiteboardVersionsModel.name,
);
export const BoardComments = new Collection<BoardCommentType>(
  BoardCommentsModel.name,
);
export const Puzzles = new Collection<PuzzleType>(PuzzlesModel.name);
export const Tags = new Collection<TagType>(TagsModel.name);

// Someone's tab on the board, keyed by its connection, as the server's live
// and presence messages carry it. The viewer's own tab is left out, as Jolly
// Roger's presence publication left it out.
export type WhiteboardPresenceType = {
  _id: string;
  board: string;
  user: string;
  name: string;
} & Partial<WhiteboardLiveState>;

export const WhiteboardPresence = new Collection<WhiteboardPresenceType>(
  "presence",
);

// The people seen on the board this session, by id, for names on cursors,
// comments, locks and versions. Jolly Roger had every user's profile; here a
// name is only known once its owner has been on the board.
export interface UserType {
  _id: string;
  displayName: string;
}

export const Users = new Collection<UserType>("users");

const byName = new Map<string, Collection<{ _id: string }>>(
  [
    Whiteboards,
    WhiteboardNodes,
    WhiteboardEdges,
    WhiteboardVersions,
    BoardComments,
    Puzzles,
    Tags,
  ].map((collection) => [collection.name, collection as never]),
);

// Which connection is this tab's, so its own presence isn't shown back to it
let ownConnection: string | undefined;

function rememberUser(user: string, name: string) {
  if (Users.findOne(user)?.displayName !== name) {
    Users.set({ _id: user, displayName: name });
  }
}

export function applySnapshot(boardId: string, snapshot: Snapshot) {
  Whiteboards.replaceAll([snapshot.board as WhiteboardType]);
  WhiteboardNodes.replaceAll(snapshot.nodes as WhiteboardNodeType[]);
  WhiteboardEdges.replaceAll(snapshot.edges as WhiteboardEdgeType[]);
  WhiteboardVersions.replaceAll(snapshot.versions as WhiteboardVersionType[]);
  BoardComments.replaceAll(snapshot.comments as BoardCommentType[]);
  if (snapshot.puzzles) Puzzles.replaceAll(snapshot.puzzles as PuzzleType[]);
  if (snapshot.tags) Tags.replaceAll(snapshot.tags as TagType[]);
  // A fresh socket gets everyone's presence again with its first presence
  // message
  WhiteboardPresence.replaceAll(
    WhiteboardPresence.all().filter((p) => p.board === boardId),
  );
}

export function applyWelcome(message: Welcome) {
  ownConnection = message.connection;
  rememberUser(message.user, message.name);
  if (message.snapshot) applySnapshot(message.board, message.snapshot);
}

export function applyChange(change: Change) {
  const collection = byName.get(change.collection);
  if (!collection) return;
  if (change.doc) collection.set(change.doc as { _id: string });
  else collection.remove(change.id);
}

type LivePayload = {
  connection: string;
  user: string;
  name: string;
} & Partial<WhiteboardLiveState>;

function presenceDoc(
  boardId: string,
  live: LivePayload,
): WhiteboardPresenceType {
  const { connection, ...rest } = live;
  return { _id: connection, board: boardId, ...rest };
}

export function applyLive(boardId: string, live: LivePayload) {
  rememberUser(live.user, live.name);
  if (live.connection === ownConnection) return;
  WhiteboardPresence.set(presenceDoc(boardId, live));
}

export function applyPresence(boardId: string, message: Presence) {
  const users = message.users as LivePayload[];
  for (const live of users) rememberUser(live.user, live.name);
  WhiteboardPresence.replaceAll(
    users
      .filter((live) => live.connection !== ownConnection)
      .map((live) => presenceDoc(boardId, live)),
  );
}

// Empties the board's collections, for a socket that won't come back.
export function clearBoard() {
  for (const collection of byName.values()) collection.clear();
  WhiteboardPresence.clear();
}
