import { EJSON } from "lib/compat/ejson";
import { ServiceError } from "lib/compat/error";
import type {
  CallError,
  CallResult,
  Change,
  Presence,
  ServerMessage,
  Welcome,
  WhiteboardLiveState,
} from "lib/protocol";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_TOKEN,
  CLOSE_BOARD_OFF,
  CLOSE_FORBIDDEN,
  CLOSE_NO_BOARD,
} from "lib/protocol";
import type { ConnectionState } from "./store/current";

// The socket to the service: says hello with the token, hands what arrives
// to the store, answers pings, makes calls, sends live updates, reconnects
// with backoff when the connection drops, and asks the page framing the
// board for a fresh token before the one it has runs out.

// How long before the token's expiry a fresh one is asked for, and how often
// to ask again while none has come
export const RENEW_BEFORE_MS = 60 * 1000;
export const RENEW_RETRY_MS = 10 * 1000;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30 * 1000;

// Messages are handed on in bursts, as Meteor's connection buffered its
// writes: a burst ends 5 ms after its last message, or 500 ms after its
// first. The documents one call wrote reach the store together, so the
// board renders their new state once (a frame and the notes in it moving as
// one), and a call's answer comes after what it changed.
export const BUFFER_QUIET_MS = 5;
export const BUFFER_MAX_MS = 500;

// Closes the server won't take back: another hello would only get the same
// answer
const TERMINAL_CODES = new Set([
  CLOSE_BAD_MESSAGE,
  CLOSE_BAD_TOKEN,
  CLOSE_FORBIDDEN,
  CLOSE_NO_BOARD,
  CLOSE_BOARD_OFF,
]);

export interface SessionHandlers {
  welcome?: (welcome: Welcome) => void;
  change?: (change: Change) => void;
  live?: (live: LiveBroadcast) => void;
  presence?: (presence: Presence) => void;
  state?: (state: ConnectionState) => void;
}

export type LiveBroadcast = {
  connection: string;
  user: string;
  name: string;
} & Partial<WhiteboardLiveState>;

export interface SessionOptions {
  // The websocket's url
  url: string;
  token: string;
  hideInk?: boolean;
  handlers?: SessionHandlers;
  // Asks whoever can mint tokens for a fresh one; setToken takes the reply.
  // The default asks the page framing the board over postMessage.
  requestToken?: (jrUrl: string | undefined) => void;
  WebSocket?: typeof WebSocket;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

// The claims a token carries, as far as the client reads them
export function tokenExpiry(token: string): number | undefined {
  try {
    const [claims] = token.split(".");
    if (!claims) return undefined;
    const json = atob(claims.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : undefined;
  } catch {
    return undefined;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: ServiceError) => void;
}

export class Session {
  state: ConnectionState = { status: "connecting" };
  welcome: Welcome | undefined;

  private token: string;
  private hideInk: boolean;
  private readonly url: string;
  private readonly handlers: SessionHandlers;
  private readonly requestToken: (jrUrl: string | undefined) => void;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws: WebSocket | undefined;
  private pending = new Map<string, PendingCall>();
  private nextCallId = 0;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  // Messages waiting for the burst they're in to end
  private buffered: ServerMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushBy: number | undefined;
  // The welcome's own listener for token replies, when the default asker is
  // in use
  private readonly onMessageEvent: ((event: MessageEvent) => void) | undefined;

  constructor(options: SessionOptions) {
    this.url = options.url;
    this.token = options.token;
    this.hideInk = options.hideInk ?? false;
    this.handlers = options.handlers ?? {};
    this.WebSocketImpl = options.WebSocket ?? WebSocket;
    this.initialBackoffMs = options.initialBackoffMs ?? INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.backoffMs = this.initialBackoffMs;
    if (options.requestToken) {
      this.requestToken = options.requestToken;
    } else {
      this.requestToken = (jrUrl) => {
        if (typeof window === "undefined" || window.parent === window) return;
        if (!jrUrl) return;
        window.parent.postMessage({ t: "token" }, jrUrl);
      };
      this.onMessageEvent = (event: MessageEvent) => {
        const jrUrl = this.jrUrl();
        if (!jrUrl || event.origin !== jrUrl) return;
        const data = event.data as { t?: unknown; token?: unknown } | null;
        if (data?.t === "token" && typeof data.token === "string") {
          this.setToken(data.token);
        }
      };
      if (typeof window !== "undefined") {
        window.addEventListener("message", this.onMessageEvent);
      }
    }
  }

  get status() {
    return this.state.status;
  }

  // How many calls are waiting for their answer
  get inFlight() {
    return this.pending.size;
  }

  // Opens the socket. Idempotent while one is open or opening.
  connect() {
    if (this.stopped || this.ws) return;
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.sendHello();
    });
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.receive(String(event.data));
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.closed(event.code, event.reason);
    });
    ws.addEventListener("error", () => {
      // The close that follows says what happened
    });
  }

  // Closes for good: no reconnect, and pending calls are refused.
  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.renewTimer);
    if (this.onMessageEvent && typeof window !== "undefined") {
      window.removeEventListener("message", this.onMessageEvent);
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000, "Leaving");
    this.flush();
    this.refusePending(1000, "Leaving");
    this.setState({ status: "closed", code: 1000, reason: "Leaving" });
  }

  // A fresh token: renews the hello on an open socket, or is used by the
  // next one.
  setToken(token: string) {
    this.token = token;
    clearTimeout(this.renewTimer);
    if (this.ws?.readyState === this.WebSocketImpl.OPEN) this.sendHello();
    this.scheduleRenewal();
  }

  // Hiding or showing ink is another hello on the same socket, whose
  // welcome brings the snapshot again, without (or with) the ink's points.
  setHideInk(hideInk: boolean) {
    if (hideInk === this.hideInk) return;
    this.hideInk = hideInk;
    if (this.ws?.readyState === this.WebSocketImpl.OPEN && this.welcome) {
      this.sendHello();
    }
  }

  // A method call, answered with its value or refused with a ServiceError
  // carrying the server's code and reason.
  call(name: string, args: unknown): Promise<unknown> {
    if (this.ws?.readyState !== this.WebSocketImpl.OPEN || !this.welcome) {
      return Promise.reject(new ServiceError(503, "Not connected"));
    }
    const id = `c${++this.nextCallId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: "call", id, name, args });
    });
  }

  // Best effort: a live update that can't go now is dropped, and the next
  // one stands in for it.
  sendLive(live: WhiteboardLiveState) {
    if (this.ws?.readyState !== this.WebSocketImpl.OPEN || !this.welcome)
      return;
    this.send({ t: "live", ...live });
  }

  private jrUrl(): string | undefined {
    return (this.welcome as { jrUrl?: string } | undefined)?.jrUrl;
  }

  private send(message: unknown) {
    this.ws?.send(EJSON.stringify(message));
  }

  private sendHello() {
    this.send({
      t: "hello",
      token: this.token,
      hideInk: this.hideInk,
    });
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.handlers.state?.(state);
  }

  private refusePending(code: number, reason: string) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) call.reject(new ServiceError(code, reason));
  }

  private receive(frame: string) {
    let message: ServerMessage;
    try {
      message = EJSON.parse(frame) as ServerMessage;
    } catch {
      return;
    }
    // Pings are answered at once; the rest waits for its burst
    if (message.t === "ping") {
      this.send({ t: "pong" });
      return;
    }
    this.buffered.push(message);
    const now = Date.now();
    this.flushBy ??= now + BUFFER_MAX_MS;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(
      () => this.flush(),
      Math.max(0, Math.min(BUFFER_QUIET_MS, this.flushBy - now)),
    );
  }

  // Hands every buffered message on, in order
  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushBy = undefined;
    const messages = this.buffered;
    this.buffered = [];
    for (const message of messages) this.handle(message);
  }

  private handle(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
        this.welcome = message;
        this.backoffMs = this.initialBackoffMs;
        this.handlers.welcome?.(message);
        this.setState({ status: "open" });
        this.scheduleRenewal();
        return;
      case "change":
        this.handlers.change?.(message);
        return;
      case "live":
        this.handlers.live?.(message as unknown as LiveBroadcast);
        return;
      case "presence":
        this.handlers.presence?.(message);
        return;
      case "ping":
      case "pong":
        return;
      case "result":
      case "error":
        this.answer(message);
        return;
      default:
        return;
    }
  }

  private answer(message: CallResult | CallError) {
    if (message.id === null) return;
    const id = String(message.id);
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    // A method with nothing to say answers null over the wire (EJSON has no
    // undefined), which a caller reads as Meteor's undefined
    if (message.t === "result") call.resolve(message.value ?? undefined);
    else call.reject(new ServiceError(message.code, message.reason));
  }

  private closed(code: number, reason: string) {
    this.flush();
    this.welcome = undefined;
    this.refusePending(code, reason || "Disconnected");
    clearTimeout(this.renewTimer);
    if (this.stopped) return;
    if (TERMINAL_CODES.has(code)) {
      const expiry = tokenExpiry(this.token);
      const expired =
        code === CLOSE_BAD_TOKEN &&
        expiry !== undefined &&
        expiry <= Date.now();
      this.setState({ status: expired ? "expired" : "closed", code, reason });
      return;
    }
    this.setState({ status: "reconnecting", code, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  // Asks for a fresh token a minute before this one runs out, and keeps
  // asking until one comes or the token has expired (the server then closes
  // the socket, and the page says to reload).
  private scheduleRenewal() {
    clearTimeout(this.renewTimer);
    const expiry = tokenExpiry(this.token);
    if (expiry === undefined || this.stopped) return;
    const ask = () => {
      this.renewTimer = undefined;
      if (this.stopped || expiry <= Date.now()) return;
      this.requestToken(this.jrUrl());
      this.renewTimer = setTimeout(ask, RENEW_RETRY_MS);
    };
    const wait = Math.max(0, expiry - RENEW_BEFORE_MS - Date.now());
    this.renewTimer = setTimeout(ask, wait);
  }
}
