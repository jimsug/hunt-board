import { assert } from "chai";
import { EJSON } from "lib/compat/ejson";
import type { SocketLike } from "../../server/feed/ddp";
import { DdpClient } from "../../server/feed/ddp";

// A DDP client on a socket the test plays the server on: no network, no
// Meteor. Shared by the client's own tests and the hunt feed's.

export class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(EJSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    // The server side closes in its own time
    queueMicrotask(() => this.onclose?.({ code: code ?? 1005, reason: "" }));
  }

  // The server's side of the conversation
  open() {
    this.onopen?.({});
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: EJSON.stringify(message) });
  }

  // The last frame of a kind the client sent
  last(msg: string) {
    return this.sent.filter((m) => m.msg === msg).at(-1);
  }

  // Every frame of a kind the client sent
  all(msg: string) {
    return this.sent.filter((m) => m.msg === msg);
  }

  // Answers the client's pending login with a token
  answerLogin(id = "user1", token = "token1") {
    const login = this.last("method") as {
      id: string;
      method: string;
      params: unknown[];
    };
    assert.equal(login.method, "login");
    this.receive({
      msg: "result",
      id: login.id,
      result: { id, token, tokenExpires: new Date() },
    });
    return login;
  }
}

export const quiet = { info() {}, warn() {}, error() {} };

export function makeClient(credentials = { token: "resume-1" }) {
  const sockets: FakeSocket[] = [];
  const client = new DdpClient({
    url: "ws://jr.example.test/websocket",
    credentials,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    minBackoffMs: 1,
    maxBackoffMs: 2,
    pingIntervalMs: 0,
    logger: quiet,
  });
  return { client, sockets, socket: () => sockets.at(-1)! };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Brings a fresh client to the logged-in state
export async function connected(credentials?: { token: string }) {
  const made = makeClient(credentials);
  made.client.connect();
  made.socket().open();
  made.socket().receive({ msg: "connected", session: "s1" });
  await tick();
  made.socket().answerLogin();
  await tick();
  return made;
}
