import type { Claims } from "lib/access";
import { boardAccess, isOperator } from "lib/access";
import { ServiceError } from "lib/compat/error";
import BoardComments from "lib/models/BoardComments";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import type { WhiteboardType } from "lib/models/Whiteboards";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import type {
  ServerMessage,
  Snapshot,
  WhiteboardLiveState,
} from "lib/protocol";
import type { Change } from "./changes";
import { onChange } from "./changes";
import type { LivePresence, RoomLive } from "./live";
import {
  applyLive,
  clearLiveEditsOfNonEditors,
  createRoomLive,
  joinLive,
  leaveLive,
  presenceOf,
  setLiveClaims,
} from "./live";
import Logger from "./logger";
import { assertWhiteboardEnabled } from "./whiteboard";

// A room per board: the sockets on it, their presence, and a subscription
// to the change seam that forwards each change to the board's documents
// down to them. Made on the first join, loading the board; dropped a little
// after the last leave, so a reload doesn't load the board twice.

// What the room needs of a socket. The websocket layer supplies it.
export interface RoomMember {
  id: string;
  claims: Claims;
  hideInk: boolean;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Seat {
  member: RoomMember;
  // Messages that arrived while the member's snapshot was being read, sent
  // after the welcome so the client sees nothing before it
  pending: ServerMessage[] | null;
}

export interface Room {
  id: string;
  live: RoomLive;
  seats: Map<string, Seat>;
  // The ids of the documents the room has sent down, so a removal is only
  // forwarded for a document the room had, and ink is told from the rest
  // once it's gone
  known: Set<string>;
  ink: Set<string>;
  // When each person was last seen doing something, for the activity feed
  lastSeen: Map<string, { name: string; at: Date }>;
  unsubscribe: () => void;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

// How long an empty room is kept before it's dropped
export let ROOM_GRACE_MS = 5000;
export function setRoomGrace(ms: number) {
  ROOM_GRACE_MS = ms;
}

const rooms = new Map<string, Promise<Room>>();

export const roomCount = () => rooms.size;

// The room for a board if it's loaded (or loading)
export async function roomFor(boardId: string): Promise<Room | undefined> {
  return rooms.get(boardId);
}

async function loadRoom(boardId: string): Promise<Room> {
  const board = await Whiteboards.findOneAsync(boardId);
  if (!board) throw new ServiceError(404, "Unknown whiteboard");
  const room: Room = {
    id: boardId,
    live: createRoomLive(board),
    seats: new Map(),
    known: new Set([boardId]),
    ink: new Set(),
    lastSeen: new Map(),
    unsubscribe: () => {},
    dropTimer: null,
  };
  room.unsubscribe = onChange((change) => {
    try {
      forward(room, change);
    } catch (error) {
      Logger.error("Failed to forward a change to a room", {
        board: boardId,
        collection: change.collection,
        error,
      });
    }
  });
  return room;
}

function dropRoom(room: Room) {
  if (room.dropTimer) clearTimeout(room.dropTimer);
  room.dropTimer = null;
  room.unsubscribe();
  rooms.delete(room.id);
}

function deliver(seat: Seat, message: ServerMessage) {
  if (seat.pending) seat.pending.push(message);
  else seat.member.send(message);
}

function broadcast(room: Room, message: ServerMessage, except?: string) {
  for (const seat of room.seats.values()) {
    if (seat.member.id !== except) deliver(seat, message);
  }
}

const presenceMessage = (room: Room): ServerMessage => ({
  t: "presence",
  users: presenceOf(room.live),
});

const liveMessage = (presence: LivePresence): ServerMessage => ({
  t: "live",
  ...presence,
});

function noteSeen(room: Room, claims: Claims) {
  room.lastSeen.set(claims.user, { name: claims.name, at: new Date() });
}

// Everything the member's client needs to show the board as it is now.
export async function snapshot(
  board: WhiteboardType,
  claims: Claims,
  { hideInk = false }: { hideInk?: boolean } = {},
): Promise<Snapshot> {
  if (boardAccess(claims, board).access === "none") {
    throw new ServiceError(403, "Not a member of this hunt");
  }
  const boardId = board._id;
  const nodes = await WhiteboardNodes.find({
    board: boardId,
    ...(hideInk ? { type: { $ne: "ink" } } : {}),
  }).fetchAsync();
  const edges = await WhiteboardEdges.find({ board: boardId }).fetchAsync();
  const versions = await WhiteboardVersions.find(
    { board: boardId },
    { sort: { createdAt: -1 } },
  ).fetchAsync();
  const comments = await BoardComments.find({ board: boardId }).fetchAsync();
  const isHuntBoard = board.puzzle === undefined;
  return {
    board,
    nodes,
    edges,
    versions,
    comments,
    ...(isHuntBoard
      ? {
          puzzles: await Puzzles.find({ hunt: board.hunt }).fetchAsync(),
          tags: await Tags.find({ hunt: board.hunt }).fetchAsync(),
        }
      : {}),
  };
}

function remember(room: Room, docs: { _id: string; type?: unknown }[]) {
  for (const doc of docs) {
    room.known.add(doc._id);
    if (doc.type === "ink") room.ink.add(doc._id);
  }
}

// Puts the member in the room (loading it if need be), sends them the
// welcome with the snapshot, then whatever changed while it was read, and
// tells the room they're here.
export async function joinRoom(
  boardId: string,
  member: RoomMember,
): Promise<Room> {
  await assertWhiteboardEnabled();
  let loading = rooms.get(boardId);
  if (!loading) {
    loading = loadRoom(boardId);
    rooms.set(boardId, loading);
    loading.catch(() => rooms.delete(boardId));
  }
  const room = await loading;
  if (room.dropTimer) {
    clearTimeout(room.dropTimer);
    room.dropTimer = null;
  }
  const board = room.live.board;
  const { access } = boardAccess(member.claims, board);
  if (access === "none")
    throw new ServiceError(403, "Not a member of this hunt");

  const seat: Seat = { member, pending: [] };
  room.seats.set(member.id, seat);
  joinLive(room.live, member.id, member.claims);
  noteSeen(room, member.claims);
  try {
    const snap = await snapshot(board, member.claims, {
      hideInk: member.hideInk,
    });
    remember(room, snap.nodes as { _id: string; type?: unknown }[]);
    for (const docs of [
      snap.edges,
      snap.versions,
      snap.comments,
      snap.puzzles ?? [],
      snap.tags ?? [],
    ]) {
      remember(room, docs as { _id: string }[]);
    }
    member.send(welcomeFor(room, member, snap));
  } catch (error) {
    leaveRoom(room, member.id);
    throw error;
  }
  const pending = seat.pending ?? [];
  seat.pending = null;
  for (const message of pending) member.send(message);
  broadcast(room, presenceMessage(room));
  return room;
}

function welcomeFor(
  room: Room,
  member: RoomMember,
  snap?: Snapshot,
): ServerMessage {
  const { claims } = member;
  return {
    t: "welcome",
    user: claims.user,
    name: claims.name,
    mayEdit: claims.mayEdit,
    access: boardAccess(claims, room.live.board).access,
    operator: isOperator(claims),
    board: room.id,
    connection: member.id,
    ...(snap ? { snapshot: snap } : {}),
  };
}

// Takes the member out. The room goes once it's been empty for the grace.
export function leaveRoom(room: Room, memberId: string) {
  if (!room.seats.delete(memberId)) return;
  leaveLive(room.live, memberId);
  broadcast(room, presenceMessage(room));
  if (room.seats.size === 0 && !room.dropTimer) {
    room.dropTimer = setTimeout(() => {
      if (room.seats.size === 0) dropRoom(room);
    }, ROOM_GRACE_MS);
  }
}

// A renewed token on a member's socket. The scope has to be the board's;
// anything else about the claims may change.
export function renewClaims(room: Room, memberId: string, claims: Claims) {
  const seat = room.seats.get(memberId);
  if (!seat) throw new ServiceError(400, "Not on this board");
  if (boardAccess(claims, room.live.board).access === "none") {
    throw new ServiceError(403, "Not a member of this hunt");
  }
  seat.member.claims = claims;
  const cleared = setLiveClaims(room.live, memberId, claims);
  if (cleared) broadcast(room, liveMessage(cleared));
  seat.member.send(welcomeFor(room, seat.member));
}

// A member's live update, rebroadcast to everyone else once applied.
export async function liveUpdate(
  room: Room,
  memberId: string,
  live: WhiteboardLiveState,
) {
  const seat = room.seats.get(memberId);
  if (!seat) throw new ServiceError(400, "Not on this board");
  const presence = await applyLive(
    room.live,
    memberId,
    seat.member.claims,
    live,
  );
  if (!presence) return;
  noteSeen(room, seat.member.claims);
  broadcast(room, liveMessage(presence), memberId);
}

// Who's been on the board lately, for Jolly Roger's activity feed
export async function activityOf(boardId: string) {
  const room = await rooms.get(boardId);
  if (!room) return [];
  return [...room.lastSeen.entries()]
    .map(([user, { name, at }]) => ({ user, name, lastSeen: at }))
    .toSorted((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
}

// Routes one change to the room, if it's about this board, and sends it
// to the sockets that should see it.
function forward(room: Room, change: Change) {
  const { collection, id, doc } = change;
  const board = room.live.board;
  if (collection === Whiteboards.name) {
    if (id !== room.id) return;
    boardChanged(room, doc as WhiteboardType | null);
    return;
  }
  let mine: boolean;
  if (collection === Puzzles.name || collection === Tags.name) {
    if (board.puzzle !== undefined) return;
    mine = doc ? doc.hunt === board.hunt : room.known.has(id);
  } else if (
    collection === WhiteboardNodes.name ||
    collection === WhiteboardEdges.name ||
    collection === WhiteboardVersions.name ||
    collection === BoardComments.name
  ) {
    mine = doc ? doc.board === room.id : room.known.has(id);
  } else {
    return;
  }
  if (!mine) return;

  const message: ServerMessage = { t: "change", collection, id, doc };
  const isInk =
    collection === WhiteboardNodes.name &&
    (doc ? doc.type === "ink" : room.ink.has(id));
  if (doc) {
    room.known.add(id);
    if (isInk) room.ink.add(id);
  } else {
    room.known.delete(id);
    room.ink.delete(id);
  }
  for (const seat of room.seats.values()) {
    if (isInk && seat.member.hideInk) continue;
    deliver(seat, message);
  }
}

// The board document changed: a policy or editors change takes live edits
// off whoever may no longer edit, and anyone whose access is gone is
// closed. Removed outright, the board takes its room with it.
function boardChanged(room: Room, board: WhiteboardType | null) {
  if (!board) {
    for (const seat of room.seats.values()) {
      seat.member.close(4404, "Board deleted");
    }
    room.seats.clear();
    dropRoom(room);
    return;
  }
  room.live.board = board;
  broadcast(room, {
    t: "change",
    collection: Whiteboards.name,
    id: room.id,
    doc: board,
  });
  for (const presence of clearLiveEditsOfNonEditors(room.live)) {
    broadcast(room, liveMessage(presence));
  }
  for (const seat of [...room.seats.values()]) {
    if (boardAccess(seat.member.claims, board).access === "none") {
      seat.member.close(4403, "No longer allowed on this board");
      leaveRoom(room, seat.member.id);
    }
  }
}

// Closes every room, for shutdown: members are told the service is going
// and the subscriptions are dropped.
export async function closeRooms(closeMember: (member: RoomMember) => void) {
  for (const loading of [...rooms.values()]) {
    let room: Room;
    try {
      room = await loading;
    } catch {
      continue;
    }
    for (const seat of room.seats.values()) closeMember(seat.member);
    room.seats.clear();
    dropRoom(room);
  }
}
