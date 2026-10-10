import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Claims } from "lib/access";
import { EJSON } from "lib/compat/ejson";
import { isServiceError } from "lib/compat/error";
import { Random } from "lib/compat/random";
import Whiteboards from "lib/models/Whiteboards";
import type { ClientMessage as ClientMessageType } from "lib/protocol";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_TOKEN,
  CLOSE_BOARD_OFF,
  CLOSE_FORBIDDEN,
  CLOSE_NO_BOARD,
  CLOSE_TIMED_OUT,
  ClientMessage,
  type ServerMessage,
} from "lib/protocol";
import { MAX_CLIP_LENGTH } from "lib/whiteboard/clipboard";
import Flags, { FlagNames } from "./flags";
import Logger from "./logger";
import { callMethod } from "./methods";
import type { Room, RoomMember } from "./rooms";
import { joinRoom, leaveRoom, liveUpdate, renewClaims } from "./rooms";
import { verifyToken } from "./token";
import { scopeSelector } from "./whiteboard";

// The websocket side of Bun.serve: one socket per tab, which says hello
// with its token, gets the board's snapshot back, and from then on makes
// calls, sends live updates and hears every change to its board.

// Any frame but a call is small: a live update, a ping. A call carries up
// to a pasted board.
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CALL_BYTES = MAX_CLIP_LENGTH;
export const PING_INTERVAL_MS = 25 * 1000;
// A socket whose token has been expired this long without a renewed hello
// is closed at its next ping. Calls in the meantime still go through: the
// token was good when the socket said hello.
export const EXPIRED_TOKEN_GRACE_MS = 60 * 1000;

export interface SocketData {
  id: string;
  room: Room | null;
  member: RoomMember | null;
  closers: (() => void)[];
  awaitingPong: boolean;
  pinger: ReturnType<typeof setInterval> | null;
  // Frames are handled one after another per socket, so a call sent right
  // after the hello waits for the join
  queue: Promise<void>;
  closed: boolean;
}

export interface WebSocketOptions {
  secret: string;
  // Jolly Roger's origin, which the welcome carries for links out of the board
  jrUrl?: string;
  pingIntervalMs?: number;
}

// What the welcome says about the service itself, beyond the viewer and the
// board: where Jolly Roger is, whether images can be added (uploads wait for
// their workstream, so not yet), and which flags are on.
async function welcomeExtras(jrUrl: string | undefined) {
  const flags: string[] = [];
  for (const name of FlagNames) {
    if (await Flags.activeAsync(name)) flags.push(name);
  }
  return { jrUrl, imagesEnabled: false, flags };
}

type Socket = ServerWebSocket<SocketData>;

const send = (ws: Socket, message: ServerMessage) => {
  if (ws.data.closed) return;
  ws.send(EJSON.stringify(message));
};

function closeSocket(ws: Socket, code: number, reason: string) {
  if (ws.data.closed) return;
  ws.data.closed = true;
  ws.close(code, reason);
}

const frameBytes = (frame: string | Buffer) =>
  typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.length;

export function createWebSocketHandler({
  secret,
  jrUrl,
  pingIntervalMs = PING_INTERVAL_MS,
}: WebSocketOptions) {
  // Puts the request on a socket, or says it isn't a websocket upgrade.
  function upgrade(req: Request, server: Server<SocketData>): boolean {
    return server.upgrade(req, {
      data: {
        id: Random.id(),
        room: null,
        member: null,
        closers: [],
        awaitingPong: false,
        pinger: null,
        queue: Promise.resolve(),
        closed: false,
      },
    });
  }

  function ping(ws: Socket) {
    if (ws.data.closed) return;
    if (ws.data.awaitingPong) {
      closeSocket(ws, CLOSE_TIMED_OUT, "No pong");
      return;
    }
    const claims = ws.data.member?.claims;
    if (claims && claims.exp + EXPIRED_TOKEN_GRACE_MS < Date.now()) {
      closeSocket(ws, CLOSE_BAD_TOKEN, "Token expired");
      return;
    }
    ws.data.awaitingPong = true;
    send(ws, { t: "ping" });
  }

  async function hello(
    ws: Socket,
    message: Extract<ClientMessageType, { t: "hello" }>,
  ) {
    let claims: Claims;
    try {
      claims = verifyToken(message.token, secret);
    } catch (error) {
      closeSocket(
        ws,
        CLOSE_BAD_TOKEN,
        isServiceError(error) ? error.reason : "Bad token",
      );
      return;
    }
    if (ws.data.room && ws.data.member) {
      try {
        renewClaims(ws.data.room, ws.data.member.id, claims);
      } catch (error) {
        closeSocket(
          ws,
          CLOSE_FORBIDDEN,
          isServiceError(error) ? error.reason : "Not allowed",
        );
      }
      return;
    }
    if (await Flags.activeAsync("disable.whiteboard")) {
      closeSocket(ws, CLOSE_BOARD_OFF, "The whiteboard is disabled");
      return;
    }
    const board = await Whiteboards.findOneAsync(scopeSelector(claims.scope));
    if (!board) {
      closeSocket(ws, CLOSE_NO_BOARD, "No board for this scope");
      return;
    }
    const extras = await welcomeExtras(jrUrl);
    const member: RoomMember = {
      id: ws.data.id,
      claims,
      hideInk: message.hideInk ?? false,
      send: (msg) =>
        send(ws, msg.t === "welcome" ? { ...msg, ...extras } : msg),
      close: (code, reason) => closeSocket(ws, code, reason),
    };
    try {
      ws.data.member = member;
      ws.data.room = await joinRoom(board._id, member);
    } catch (error) {
      ws.data.member = null;
      if (isServiceError(error)) {
        closeSocket(
          ws,
          error.error === 404
            ? CLOSE_NO_BOARD
            : error.error === 403
              ? CLOSE_FORBIDDEN
              : CLOSE_BAD_MESSAGE,
          error.reason,
        );
      } else {
        Logger.error("Failed to join a room", { board: board._id, error });
        closeSocket(ws, 1011, "Internal error");
      }
    }
  }

  async function call(
    ws: Socket,
    room: Room,
    member: RoomMember,
    message: Extract<ClientMessageType, { t: "call" }>,
  ) {
    const { id, name, args } = message;
    try {
      const value = await callMethod(name, member.claims, room.id, args, {
        connection: {
          id: ws.data.id,
          onClose: (cb) => ws.data.closers.push(cb),
        },
      });
      send(ws, { t: "result", id, value });
    } catch (error) {
      if (isServiceError(error)) {
        send(ws, { t: "error", id, code: error.error, reason: error.reason });
      } else {
        Logger.error("A call failed", { name, board: room.id, error });
        send(ws, { t: "error", id, code: 500, reason: "Internal error" });
      }
    }
  }

  async function handle(ws: Socket, frame: string | Buffer) {
    if (ws.data.closed) return;
    if (typeof frame !== "string") {
      closeSocket(ws, 1003, "Text frames only");
      return;
    }
    let parsed: unknown;
    try {
      parsed = EJSON.parse(frame);
    } catch {
      closeSocket(ws, CLOSE_BAD_MESSAGE, "Malformed message");
      return;
    }
    const result = ClientMessage.safeParse(parsed);
    if (!result.success) {
      if (!ws.data.room) {
        closeSocket(ws, CLOSE_BAD_MESSAGE, "Malformed message");
        return;
      }
      const id = (parsed as { id?: string | number })?.id ?? null;
      send(ws, { t: "error", id, code: 400, reason: "Malformed message" });
      return;
    }
    const message = result.data;
    if (message.t !== "call" && frameBytes(frame) > MAX_FRAME_BYTES) {
      closeSocket(ws, 1009, "Frame too large");
      return;
    }
    ws.data.awaitingPong = false;
    if (message.t === "hello") {
      await hello(ws, message);
      return;
    }
    const { room, member } = ws.data;
    if (!room || !member) {
      closeSocket(ws, CLOSE_BAD_MESSAGE, "Say hello first");
      return;
    }
    switch (message.t) {
      case "call":
        await call(ws, room, member, message);
        return;
      case "live": {
        const { t: _t, ...live } = message;
        try {
          await liveUpdate(room, member.id, live);
        } catch (error) {
          if (isServiceError(error)) {
            send(ws, {
              t: "error",
              id: null,
              code: error.error,
              reason: error.reason,
            });
          } else {
            Logger.error("A live update failed", { board: room.id, error });
          }
        }
        return;
      }
      case "ping":
        send(ws, { t: "pong" });
        return;
      case "pong":
        return;
      default:
        return message satisfies never;
    }
  }

  const websocket: WebSocketHandler<SocketData> = {
    maxPayloadLength: MAX_CALL_BYTES + MAX_FRAME_BYTES,
    open(ws) {
      ws.data.pinger = setInterval(() => ping(ws), pingIntervalMs);
    },
    message(ws, frame) {
      ws.data.queue = ws.data.queue
        .then(() => handle(ws, frame))
        .catch((error) => {
          Logger.error("Failed to handle a websocket frame", {
            connection: ws.data.id,
            error,
          });
          closeSocket(ws, 1011, "Internal error");
        });
    },
    close(ws) {
      ws.data.closed = true;
      if (ws.data.pinger) clearInterval(ws.data.pinger);
      ws.data.pinger = null;
      for (const cb of ws.data.closers.splice(0)) {
        try {
          cb();
        } catch (error) {
          Logger.error("A close handler failed", {
            connection: ws.data.id,
            error,
          });
        }
      }
      // A hello part way through joining finds the socket closed and leaves
      ws.data.queue = ws.data.queue.then(() => {
        if (ws.data.room) leaveRoom(ws.data.room, ws.data.id);
        ws.data.room = null;
        ws.data.member = null;
      });
    },
  };

  return { upgrade, websocket };
}
