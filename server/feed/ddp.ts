import { createHash } from "node:crypto";
import { EJSON } from "lib/compat/ejson";
import Logger from "../logger";

// A DDP 1 client, as much of the protocol as the feed needs: connect, login
// (with a resume token, or an email and password, keeping the token the
// server hands back for the next connect), subscriptions that are sent again
// after every connect, method calls, the server's pings, and a reconnect
// with backoff when the socket drops. Frames are EJSON, as Meteor's are.

// What the client needs of a WebSocket, so tests can hand it a fake one
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface Credentials {
  // A resume token from an earlier login
  token?: string;
  email?: string;
  password?: string;
}

export interface LoginResult {
  id: string;
  token: string;
  tokenExpires?: Date;
}

export interface DataMessage {
  msg: "added" | "changed" | "removed";
  collection: string;
  id: string;
  fields?: Record<string, unknown>;
  cleared?: string[];
}

export interface SubscriptionHandlers {
  onReady?: () => void;
  // The server ended the subscription, with the error it gave if any
  onStop?: (error?: DdpError) => void;
}

export interface Subscription {
  id: string;
  name: string;
  params: unknown[];
  stop(): void;
}

export interface DdpClientOptions {
  url: string;
  credentials: Credentials;
  socketFactory?: SocketFactory;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  // How often to ping the server; nothing heard for two intervals drops the
  // socket. 0 turns it off.
  pingIntervalMs?: number;
  logger?: Pick<typeof Logger, "info" | "warn" | "error">;
}

export class DdpError extends Error {
  error: string | number;
  reason?: string;
  constructor(error: string | number, reason?: string) {
    super(reason ? `[${error}] ${reason}` : String(error));
    this.name = "DdpError";
    this.error = error;
    this.reason = reason;
  }
}

type Message = Record<string, unknown> & { msg?: string };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export const passwordDigest = (password: string) =>
  createHash("sha256").update(password).digest("hex");

export class DdpClient {
  private readonly url: string;
  private readonly credentials: Credentials;
  private readonly socketFactory: SocketFactory;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pingIntervalMs: number;
  private readonly logger: NonNullable<DdpClientOptions["logger"]>;

  private socket: SocketLike | undefined;
  private connected = false;
  private loggedIn = false;
  private stopped = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeard = 0;
  private nextId = 1;
  private readonly calls = new Map<string, Pending>();
  private readonly subs = new Map<
    string,
    Subscription & { handlers: SubscriptionHandlers }
  >();
  private readonly listeners = {
    connected: new Set<(session: string) => void>(),
    login: new Set<(result: LoginResult) => void>(),
    loginFailed: new Set<(error: DdpError) => void>(),
    disconnected: new Set<() => void>(),
    data: new Set<(message: DataMessage) => void>(),
  };

  // The user the last login gave, and the token to resume with
  userId: string | undefined;
  token: string | undefined;

  constructor(options: DdpClientOptions) {
    this.url = options.url;
    this.credentials = options.credentials;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.logger = options.logger ?? Logger;
    this.backoffMs = this.minBackoffMs;
    this.token = options.credentials.token;
  }

  get isConnected() {
    return this.connected;
  }

  get isLoggedIn() {
    return this.loggedIn;
  }

  onConnected(cb: (session: string) => void) {
    this.listeners.connected.add(cb);
    return () => this.listeners.connected.delete(cb);
  }

  onLogin(cb: (result: LoginResult) => void) {
    this.listeners.login.add(cb);
    return () => this.listeners.login.delete(cb);
  }

  onLoginFailed(cb: (error: DdpError) => void) {
    this.listeners.loginFailed.add(cb);
    return () => this.listeners.loginFailed.delete(cb);
  }

  onDisconnected(cb: () => void) {
    this.listeners.disconnected.add(cb);
    return () => this.listeners.disconnected.delete(cb);
  }

  onData(cb: (message: DataMessage) => void) {
    this.listeners.data.add(cb);
    return () => this.listeners.data.delete(cb);
  }

  // Opens the socket, and keeps reopening it until close() is called
  connect() {
    if (this.stopped || this.socket) return;
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.logger.warn("Could not open the DDP socket", { error });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.lastHeard = Date.now();
      this.send({ msg: "connect", version: "1", support: ["1"] });
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // The close that follows does the work
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socketClosed();
    };
  }

  // Closes the socket for good
  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    if (socket) {
      this.socket = undefined;
      socket.onclose = null;
      socket.close(1000, "Client closing");
      this.socketClosed(true);
    }
  }

  // Drops the socket as a network fault would; the client reconnects
  dropConnection() {
    const socket = this.socket;
    if (!socket) return;
    socket.close(4000, "Dropped");
  }

  // A subscription, sent now if logged in and again after every reconnect
  subscribe(
    name: string,
    params: unknown[] = [],
    handlers: SubscriptionHandlers = {},
  ): Subscription {
    const id = String(this.nextId++);
    const sub = {
      id,
      name,
      params,
      handlers,
      stop: () => {
        if (!this.subs.delete(id)) return;
        if (this.loggedIn) this.send({ msg: "unsub", id });
      },
    };
    this.subs.set(id, sub);
    if (this.loggedIn) this.sendSub(sub);
    return sub;
  }

  call(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.connected) {
      return Promise.reject(new DdpError("not-connected", "Not connected"));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ msg: "method", method, params, id });
    });
  }

  private send(message: Message) {
    this.socket?.send(EJSON.stringify(message));
  }

  private sendSub(sub: Subscription) {
    this.send({ msg: "sub", id: sub.id, name: sub.name, params: sub.params });
  }

  private receive(data: unknown) {
    this.lastHeard = Date.now();
    if (typeof data !== "string") return;
    let message: Message;
    try {
      message = EJSON.parse(data) as Message;
    } catch {
      this.logger.warn("Unreadable DDP frame", { frame: data.slice(0, 200) });
      return;
    }
    if (typeof message !== "object" || message === null || !message.msg) {
      return;
    }
    switch (message.msg) {
      case "connected":
        this.connected = true;
        this.backoffMs = this.minBackoffMs;
        this.startPinging();
        this.listeners.connected.forEach((cb) => cb(message.session as string));
        void this.login();
        break;
      case "failed":
        this.logger.error("DDP version refused", { version: message.version });
        this.backoffMs = this.maxBackoffMs;
        this.socket?.close(4000, "Version refused");
        break;
      case "ping":
        this.send(
          message.id === undefined
            ? { msg: "pong" }
            : { msg: "pong", id: message.id },
        );
        break;
      case "pong":
        break;
      case "added":
      case "changed":
      case "removed":
        this.listeners.data.forEach((cb) =>
          cb(message as unknown as DataMessage),
        );
        break;
      case "ready":
        for (const id of (message.subs as string[]) ?? []) {
          this.subs.get(id)?.handlers.onReady?.();
        }
        break;
      case "nosub": {
        const id = message.id as string;
        const sub = this.subs.get(id);
        const error = message.error as
          | { error: string | number; reason?: string }
          | undefined;
        sub?.handlers.onStop?.(
          error ? new DdpError(error.error, error.reason) : undefined,
        );
        break;
      }
      case "result": {
        const pending = this.calls.get(message.id as string);
        if (!pending) break;
        this.calls.delete(message.id as string);
        const error = message.error as
          | { error: string | number; reason?: string }
          | undefined;
        if (error) pending.reject(new DdpError(error.error, error.reason));
        else pending.resolve(message.result);
        break;
      }
      case "updated":
        break;
      case "error":
        this.logger.warn("DDP error from the server", {
          reason: message.reason,
          offending: message.offendingMessage,
        });
        break;
      default:
        break;
    }
  }

  // Logs in with the token if there is one, then with the password; the
  // subscriptions go out once that's done, since a publication that checks
  // the user answers nothing before.
  private async login() {
    const attempts: Record<string, unknown>[] = [];
    if (this.token) attempts.push({ resume: this.token });
    const { email, password } = this.credentials;
    if (email && password) {
      attempts.push({
        user: { email },
        password: { digest: passwordDigest(password), algorithm: "sha-256" },
      });
    }
    let lastError: DdpError | undefined;
    for (const attempt of attempts) {
      try {
        const result = (await this.call("login", [attempt])) as LoginResult;
        if (!this.connected) return;
        this.userId = result.id;
        this.token = result.token;
        this.loggedIn = true;
        for (const sub of this.subs.values()) this.sendSub(sub);
        this.listeners.login.forEach((cb) => cb(result));
        return;
      } catch (error) {
        if (!this.connected) return;
        lastError =
          error instanceof DdpError
            ? error
            : new DdpError("login-failed", String(error));
        if ("resume" in attempt) {
          // A stale token is the usual case; the password is the way back in
          this.token = undefined;
        }
      }
    }
    const error = lastError ?? new DdpError("no-credentials", "No credentials");
    this.logger.error("Login to Jolly Roger failed", {
      error: error.message,
    });
    this.listeners.loginFailed.forEach((cb) => cb(error));
    // Nothing will change until someone fixes the account, so the retries
    // are spaced as far apart as they get
    this.backoffMs = this.maxBackoffMs;
    this.socket?.close(4000, "Login failed");
  }

  private startPinging() {
    this.stopPinging();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > 2 * this.pingIntervalMs) {
        this.logger.warn("No word from Jolly Roger; reconnecting");
        this.socket?.close(4000, "Timed out");
        return;
      }
      this.send({ msg: "ping" });
    }, this.pingIntervalMs);
  }

  private stopPinging() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private socketClosed(deliberate = false) {
    this.socket = undefined;
    this.stopPinging();
    const wasConnected = this.connected && !deliberate;
    this.connected = false;
    this.loggedIn = false;
    for (const pending of this.calls.values()) {
      pending.reject(new DdpError("disconnected", "Connection lost"));
    }
    this.calls.clear();
    if (wasConnected) {
      this.listeners.disconnected.forEach((cb) => cb());
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
