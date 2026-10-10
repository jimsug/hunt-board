import type { BoardAccess, Claims } from "lib/access";
import { boardAccess } from "lib/access";
import { ServiceError } from "lib/compat/error";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import type { WhiteboardType } from "lib/models/Whiteboards";
import type { WhiteboardLiveState } from "lib/protocol";
import { Id } from "lib/typedModel/regexes";
import {
  LIVE_UPDATE_BURST,
  LIVE_UPDATES_PER_SECOND,
  LIVE_USER_UPDATE_BURST,
  LIVE_USER_UPDATES_PER_SECOND,
  MAX_INK_POINTS,
  MAX_LIVE_DRAG_NODES,
  MAX_LIVE_SELECTION,
} from "lib/whiteboard/limits";
import { MAX_ZOOM, MIN_ZOOM } from "lib/whiteboard/links";
import Flags from "./flags";
import Logger from "./logger";
import type { Bucket } from "./rateLimits";
import { bucketFor, refill } from "./rateLimits";
import { inRange, isInkPoint } from "./whiteboardShared";

// Presence for a room: what each connection on a board is doing right now.
// Jolly Roger kept a document per connection in Mongo and published it; here
// the room holds it in memory, and what applyLive returns is what the room
// sends to everyone else.

// Short-lived per-tab state for a board: where someone's pointer is, what
// they're dragging, the ink stroke they're part way through, what they have
// selected, what they're typing in, what they're looking at and who they're
// following. Each update sets all of these, so one that's been cleared is
// null.
export interface LivePresence {
  connection: string;
  user: string;
  name: string;
  cursor: { x: number; y: number } | null;
  drag: { node: string; x: number; y: number; parent?: string | null }[] | null;
  stroke: NonNullable<WhiteboardLiveState["stroke"]> | null;
  selection: string[] | null;
  editing: string | null;
  editingAt: Date | null;
  view: { x: number; y: number; zoom: number } | null;
  followedUser: string | null;
}

interface ConnectionLive {
  presence: LivePresence;
  claims: Claims;
  // The last dragged, selected and edited sets found on the board, so an
  // unchanged one isn't looked up again on every update.
  validatedDrag: string;
  validatedSelection: string;
  validatedEditing: string;
  // Set once the connection has left the room. An update that was already
  // under way when it left is dropped.
  closed: boolean;
  // Updates can run side by side, so the connection numbers the updates
  // it's sent and remembers the latest one written. An update that's
  // overtaken while it looks things up isn't written over the newer one.
  sent: number;
  written: number;
  // The connection's live updates: LIVE_UPDATE_BURST tokens refilled at
  // LIVE_UPDATES_PER_SECOND. droppedLoggedAt is when dropping updates was
  // last logged, so a flood logs once a minute at most.
  bucket: Bucket;
  droppedLoggedAt: number;
}

export interface RoomLive {
  // The board as the room last read it; the room keeps it current from the
  // board's changes, so access is worked out from what's stored now.
  board: WhiteboardType;
  connections: Map<string, ConnectionLive>;
}

// Each person's live updates across all their connections, in every room:
// LIVE_USER_UPDATE_BURST tokens refilled at LIVE_USER_UPDATES_PER_SECOND.
// A full bucket is the same as none, so those are dropped as connections
// leave.
const userBuckets = new Map<string, Bucket>();

const DROPPED_LOG_INTERVAL = 60 * 1000;

export function createRoomLive(board: WhiteboardType): RoomLive {
  return { board, connections: new Map() };
}

const NO_LIVE_EDITS = {
  drag: null,
  stroke: null,
  selection: null,
  editing: null,
  editingAt: null,
};
const NO_FOLLOWING = { view: null, followedUser: null };

// Adds a connection to the room with nothing shown yet, and returns its
// presence for the join broadcast.
export function joinLive(
  room: RoomLive,
  connectionId: string,
  claims: Claims,
): LivePresence {
  const presence: LivePresence = {
    connection: connectionId,
    user: claims.user,
    name: claims.name,
    cursor: null,
    ...NO_LIVE_EDITS,
    ...NO_FOLLOWING,
  };
  room.connections.set(connectionId, {
    presence,
    claims,
    validatedDrag: "",
    validatedSelection: "",
    validatedEditing: "",
    closed: false,
    sent: 0,
    written: 0,
    bucket: { tokens: LIVE_UPDATE_BURST, refilledAt: Date.now() },
    droppedLoggedAt: Number.NEGATIVE_INFINITY,
  });
  return presence;
}

// Takes a connection out of the room. Updates it still has under way are
// dropped when they get back.
export function leaveLive(room: RoomLive, connectionId: string) {
  const state = room.connections.get(connectionId);
  if (!state) return;
  state.closed = true;
  room.connections.delete(connectionId);
  dropFullUserBuckets();
}

// Takes a connection's new token (a demotion, a promotion, leaving the
// hunt, a new name) and takes off its presence whatever the new access no
// longer allows. Returns the presence if it changed, for broadcast.
export function setLiveClaims(
  room: RoomLive,
  connectionId: string,
  claims: Claims,
): LivePresence | undefined {
  const state = room.connections.get(connectionId);
  if (!state) return undefined;
  state.claims = claims;
  const renamed =
    state.presence.name !== claims.name || state.presence.user !== claims.user;
  if (renamed) {
    state.presence = {
      ...state.presence,
      user: claims.user,
      name: claims.name,
    };
  }
  const cleared = clearedFor(
    state.presence,
    boardAccess(claims, room.board).access,
  );
  if (cleared) state.presence = cleared;
  return cleared ?? (renamed ? state.presence : undefined);
}

// Everyone's presence, for a new arrival.
export function presenceOf(room: RoomLive): LivePresence[] {
  return [...room.connections.values()].map((c) => c.presence);
}

function dropFullUserBuckets() {
  const now = Date.now();
  userBuckets.forEach((bucket, userId) => {
    refill(bucket, now, LIVE_USER_UPDATE_BURST, LIVE_USER_UPDATES_PER_SECOND);
    if (bucket.tokens >= LIVE_USER_UPDATE_BURST) userBuckets.delete(userId);
  });
}

// Takes a token for one live update from the connection's bucket and the
// person's, or says there isn't one in both. Live updates come again a
// moment later, so one that's dropped is only ever a little late, and
// nothing is sent back.
function takeLiveToken(state: ConnectionLive, userId: string) {
  const now = Date.now();
  refill(state.bucket, now, LIVE_UPDATE_BURST, LIVE_UPDATES_PER_SECOND);
  const userBucket = bucketFor(
    userBuckets,
    userId,
    now,
    LIVE_USER_UPDATE_BURST,
  );
  refill(userBucket, now, LIVE_USER_UPDATE_BURST, LIVE_USER_UPDATES_PER_SECOND);
  if (state.bucket.tokens >= 1 && userBucket.tokens >= 1) {
    state.bucket.tokens -= 1;
    userBucket.tokens -= 1;
    return true;
  }
  if (now - state.droppedLoggedAt >= DROPPED_LOG_INTERVAL) {
    state.droppedLoggedAt = now;
    Logger.debug("Dropping whiteboard live updates over the rate limit", {
      user: userId,
      connection: state.presence.connection,
    });
  }
  return false;
}

// Takes away what people were dragging, drawing, selecting or typing in on
// a board they can no longer edit, and what they were looking at and who
// they were following if they can no longer comment on it, rather than
// leaving it until they next move. For the room to call once the board's
// policy changes, with the board as it is now. Returns the presences it
// changed, for broadcast.
export function clearLiveEditsOfNonEditors(room: RoomLive): LivePresence[] {
  const changed: LivePresence[] = [];
  for (const state of room.connections.values()) {
    const { access } = boardAccess(state.claims, room.board);
    const cleared = clearedFor(state.presence, access);
    if (cleared) {
      state.presence = cleared;
      changed.push(cleared);
    }
  }
  return changed;
}

// The presence with whatever access no longer allows taken off it, or
// undefined when nothing on it needs to go.
function clearedFor(
  presence: LivePresence,
  access: BoardAccess,
): LivePresence | undefined {
  if (access === "edit") return undefined;
  const losingAll = access !== "comment";
  const next = {
    ...presence,
    ...NO_LIVE_EDITS,
    ...(losingAll ? NO_FOLLOWING : {}),
  };
  const same = (Object.keys(next) as (keyof LivePresence)[]).every(
    (key) => next[key] === presence[key],
  );
  return same ? undefined : next;
}

const invalidLiveUpdate = () => new ServiceError(400, "Invalid live update");

export function validateLive({
  cursor,
  drag,
  stroke,
  selection,
  editing,
  editingAt,
  view,
  followedUser,
}: WhiteboardLiveState) {
  if (cursor && !(inRange(cursor.x) && inRange(cursor.y))) {
    throw invalidLiveUpdate();
  }
  if (drag) {
    if (drag.length > MAX_LIVE_DRAG_NODES) throw invalidLiveUpdate();
    drag.forEach((d) => {
      if (!Id.test(d.node) || !inRange(d.x) || !inRange(d.y)) {
        throw invalidLiveUpdate();
      }
      if (d.parent && !Id.test(d.parent)) throw invalidLiveUpdate();
    });
  }
  if (
    stroke &&
    (stroke.points.length > MAX_INK_POINTS || !stroke.points.every(isInkPoint))
  ) {
    throw invalidLiveUpdate();
  }
  if (
    selection &&
    (selection.length > MAX_LIVE_SELECTION ||
      !selection.every((id) => Id.test(id)))
  ) {
    throw invalidLiveUpdate();
  }
  if (editing != null && !Id.test(editing)) throw invalidLiveUpdate();
  if (editingAt && !Number.isFinite(editingAt.getTime())) {
    throw invalidLiveUpdate();
  }
  if (
    view &&
    !(
      inRange(view.x) &&
      inRange(view.y) &&
      view.zoom >= MIN_ZOOM &&
      view.zoom <= MAX_ZOOM
    )
  ) {
    throw invalidLiveUpdate();
  }
  if (followedUser != null && !Id.test(followedUser)) {
    throw invalidLiveUpdate();
  }
}

// Checks that every node in `ids` is on the board, unless the same set was
// found there last time.
async function assertNodesOnBoard(
  boardId: string,
  ids: string[],
  validated: string,
  message: string,
) {
  const unique = [...new Set(ids)];
  const key = `${boardId}:${unique.toSorted().join(",")}`;
  if (key === validated) return key;
  const found = await WhiteboardNodes.find({
    _id: { $in: unique },
    board: boardId,
  }).countAsync();
  if (found !== unique.length) throw new ServiceError(400, message);
  return key;
}

// Applies a connection's live update to the room and returns the presence
// to broadcast, or undefined when the update was dropped: over the rate
// limit, while live updates are off, after the connection left, or
// overtaken by a newer one. Someone who can't edit still shows their
// cursor, but nothing they drag, draw, select or type in, and someone who
// can only view doesn't show what they're looking at or who they follow
// either. Dropped rather than refused, since a refusal would come back
// every 100ms.
export async function applyLive(
  room: RoomLive,
  connectionId: string,
  claims: Claims,
  live: WhiteboardLiveState,
): Promise<LivePresence | undefined> {
  const state = room.connections.get(connectionId);
  if (!state) throw new ServiceError(400, "Not on this board");
  state.claims = claims;
  if (!takeLiveToken(state, claims.user)) return undefined;
  state.sent += 1;
  const seq = state.sent;

  if (
    (await Flags.activeAsync("disable.whiteboard")) ||
    (await Flags.activeAsync("disable.whiteboard_live"))
  ) {
    return undefined;
  }
  validateLive(live);

  const boardId = room.board._id;
  const before = boardAccess(claims, room.board).access;
  if (before === "none") {
    throw new ServiceError(403, "Not a member of this hunt");
  }
  const mayEdit = before === "edit";
  const mayComment = mayEdit || before === "comment";
  const drag = mayEdit ? live.drag : null;
  const stroke = mayEdit ? live.stroke : null;
  const selection = mayEdit ? (live.selection ?? null) : null;
  const editing = mayEdit ? (live.editing ?? null) : null;
  const editingAt = editing ? (live.editingAt ?? null) : null;
  const view = mayComment ? (live.view ?? null) : null;
  const followedUser = mayComment ? (live.followedUser ?? null) : null;

  if (drag && drag.length > 0) {
    state.validatedDrag = await assertNodesOnBoard(
      boardId,
      drag.map((d) => d.node),
      state.validatedDrag,
      "Dragged nodes must be on this board",
    );
  }
  if (selection && selection.length > 0) {
    state.validatedSelection = await assertNodesOnBoard(
      boardId,
      selection,
      state.validatedSelection,
      "Selected nodes must be on this board",
    );
  }
  // A line's label is typed in too, so a line will do as well as a node.
  if (editing && `${boardId}:${editing}` !== state.validatedEditing) {
    const selector = { _id: editing, board: boardId };
    const found =
      (await WhiteboardNodes.find(selector).countAsync()) +
      (await WhiteboardEdges.find(selector).countAsync());
    if (found === 0) {
      throw new ServiceError(400, "Edited items must be on this board");
    }
    state.validatedEditing = `${boardId}:${editing}`;
  }
  // Only someone with a tab on the board can be followed there.
  if (
    followedUser &&
    ![...room.connections.values()].some(
      (c) => c.presence.user === followedUser,
    )
  ) {
    throw new ServiceError(400, "Followed people must be on this board");
  }

  if (state.closed || state.written > seq) return undefined;
  state.written = seq;
  // Who may do what changed while this looked things up (a demotion, say),
  // so only the cursor goes through rather than what was allowed before.
  const accessChanged = boardAccess(claims, room.board).access !== before;
  state.presence = {
    ...state.presence,
    cursor: live.cursor,
    ...(accessChanged
      ? { ...NO_LIVE_EDITS, ...NO_FOLLOWING }
      : {
          drag,
          stroke,
          selection,
          editing,
          editingAt,
          view,
          followedUser,
        }),
  };
  return state.presence;
}
