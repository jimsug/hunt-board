import type { Claims } from "lib/access";
import { EJSON } from "lib/compat/ejson";
import type { ServerMessage, Welcome } from "lib/protocol";
import type { Service } from "../../server/app";
import { startService } from "../../server/app";
import type { Config } from "../../server/config";
import { signToken } from "../../server/token";
import { claimsFor, MONGO_URL } from "./harness";

// A service on a free port against the scratch Mongo, and a websocket
// client that speaks its protocol, for the http, ws and rooms tests.

export const SECRET = "test-shared-secret-of-at-least-32-chars";
export const JR_URL = "https://jr.example.test";
export const PUBLIC_URL = "https://board.example.test";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  mongoUrl: MONGO_URL,
  port: 0,
  publicUrl: PUBLIC_URL,
  jrUrl: JR_URL,
  jrSharedSecret: SECRET,
  flags: [],
  s3ImageBucketName: undefined,
  s3ImageBucketRegion: undefined,
  feed: { enabled: false },
  testMode: false,
  ...overrides,
});

export function startTestService(
  options: { distDir?: string; pingIntervalMs?: number } = {},
): Service {
  return startService({ config: testConfig(), port: 0, ...options });
}

export const tokenFor = (
  user: string,
  options?: Parameters<typeof claimsFor>[1],
) => signToken(claimsFor(user, options), SECRET);

export const tokenOf = (claims: Claims) => signToken(claims, SECRET);

export const authed = (extra: HeadersInit = {}): HeadersInit => ({
  authorization: `Bearer ${SECRET}`,
  ...extra,
});

export interface Closed {
  code: number;
  reason: string;
}

type Predicate = (message: ServerMessage) => boolean;

const DEFAULT_WAIT_MS = 5000;

// A client on the service's websocket. Messages pile up in `received`
// until a test takes them with next().
export class TestClient {
  received: ServerMessage[] = [];
  closed: Promise<Closed>;
  private waiters: {
    predicate: Predicate;
    resolve: (message: ServerMessage) => void;
  }[] = [];
  private ws: WebSocket;
  private resolveClosed!: (closed: Closed) => void;
  private opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) => reject(event));
    });
    this.ws.addEventListener("message", (event) => {
      const message = EJSON.parse(String(event.data)) as ServerMessage;
      const index = this.waiters.findIndex((w) => w.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(message);
      } else {
        this.received.push(message);
      }
    });
    this.ws.addEventListener("close", (event) => {
      this.resolveClosed({ code: event.code, reason: event.reason });
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const client = new TestClient(url);
    await client.opened;
    return client;
  }

  send(message: unknown) {
    this.ws.send(EJSON.stringify(message));
  }

  sendRaw(frame: string | ArrayBuffer) {
    this.ws.send(frame);
  }

  // The next message matching the predicate, already received or still to
  // come, within the timeout.
  next<T extends ServerMessage = ServerMessage>(
    predicate: (message: ServerMessage) => boolean = () => true,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<T> {
    const index = this.received.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.received.splice(index, 1);
      return Promise.resolve(message as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: ServerMessage) => {
          clearTimeout(timer);
          resolve(message as T);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `No matching message within ${timeoutMs}ms; had ${JSON.stringify(this.received.map((m) => m.t))}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  nextOf<T extends ServerMessage["t"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    return this.next((m) => m.t === type, timeoutMs);
  }

  // Resolves once `ms` have passed with no matching message, and rejects
  // if one arrives first.
  async none(predicate: Predicate, ms = 300): Promise<void> {
    let message: ServerMessage;
    try {
      message = await this.next(predicate, ms);
    } catch {
      return;
    }
    throw new Error(`Unexpected message ${JSON.stringify(message)}`);
  }

  async hello(token: string, hideInk?: boolean): Promise<Welcome> {
    this.send({ t: "hello", token, ...(hideInk ? { hideInk } : {}) });
    return this.nextOf("welcome");
  }

  private nextId = 0;

  // A call, answered with its value or rejected with { code, reason }
  async call<T = unknown>(name: string, args: unknown): Promise<T> {
    const id = `c${++this.nextId}`;
    this.send({ t: "call", id, name, args });
    const reply = await this.next(
      (m) => (m.t === "result" || m.t === "error") && m.id === id,
    );
    if (reply.t === "error") {
      throw Object.assign(new Error(`${reply.reason} [${reply.code}]`), {
        code: reply.code,
        reason: reply.reason,
      });
    }
    return (reply as { value: T }).value;
  }

  close(code?: number) {
    this.ws.close(code);
    return this.closed;
  }
}

// Drains every message received so far, for tests that only care about
// what comes next.
export const drain = (client: TestClient) => {
  client.received.length = 0;
};

export interface CallFailure {
  code: number;
  reason: string;
}

// The error a call was answered with, or a failure if it succeeded
export const failure = (promise: Promise<unknown>): Promise<CallFailure> =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error as CallFailure,
  );
