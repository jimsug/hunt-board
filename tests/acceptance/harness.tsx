import { topNavigation } from "client/compat/router";
import { setSession, setWhiteboardLive } from "client/methods";
import type { LiveBroadcast } from "client/session";
import { Session } from "client/session";
import {
  applyChange,
  applyLive,
  applyPresence,
  applyWelcome,
  Collection,
  clearBoard,
  connection,
  welcome,
} from "client/store";
import { lightTheme } from "client/theme";
import WhiteboardPage from "client/WhiteboardPage";
import FixtureHunt from "lib/fixtureHunt";
import type { Presence, WhiteboardLiveState } from "lib/protocol";
import { ThemeProvider } from "styled-components";

// What the browser tests reach the service through, in place of Meteor's
// connection, accounts and subscriptions: a person's session on the board
// (the page's, feeding the store, or a second one standing in for another
// browser), tokens minted by the service's test mode, the Jolly Roger-side
// writes it stands in for, and the page itself.

export const huntId = FixtureHunt._id;

// Jolly Roger's origin as tests/acceptance/serve.ts configures it, which
// the welcome carries as jrUrl
export const JR_URL = "http://jr.example.test";

// Where the board sent the top window, had this page been able to leave
const visits: string[] = [];
topNavigation.go = (url) => {
  visits.push(url);
};
export const navigation = {
  // The visits since last asked
  went: () => visits.splice(0),
};

// Who the tests are. Jolly Roger made accounts; here a person is a token's
// claims, with Meteor-style ids so the models take them as createdBy. An
// operator is an assigned one, as the fixture hunt's was.
export interface Person {
  user: string;
  name: string;
  operator?: boolean;
}

export const OPERATOR: Person = {
  user: "acceptanceTesterA",
  name: "Test Operator",
  operator: true,
};
export const MEMBER: Person = { user: "acceptanceMemberB", name: "Member" };
export const SECOND: Person = {
  user: "acceptanceSecondC",
  name: "Second Member",
};

const origin = window.location.origin;
const socketUrl = `${origin.replace(/^http/, "ws")}/ws`;

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

// Empties the service's database, seeds the fixture hunt and its board,
// and gives back the board's id.
export const resetService = () =>
  post<{ boardId: string; huntId: string }>("/test/reset");

// Whether the hunt is archived: Jolly Roger then mints everyone's tokens
// with mayEdit off, so renewing a session's token is what archiving does.
let huntArchived = false;

const mintToken = (person: Person, name = person.name) =>
  post<{ token: string }>("/test/token", {
    user: person.user,
    name,
    operator: person.operator ?? false,
    assignedOperator: person.operator ?? false,
    mayEdit: !huntArchived,
  }).then((r) => r.token);

export type PuzzleFixture = {
  puzzleId?: string;
  title?: string;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  answers?: string[];
  expectedAnswerCount?: number;
  deleted?: boolean;
  replacedBy?: string;
  sync?: boolean;
};

// A fixture write, settled once the page's store has what it changed: a
// Meteor method's promise settled after its writes had reached the client,
// and the tests lean on that. The change frames are on the page's socket
// before its round trip's answer.
async function fixture<T>(body: unknown): Promise<T> {
  const result = await post<T>("/test/fixture", body);
  await page?.roundTrip();
  return result;
}

// What Jolly Roger's puzzle methods did, written into the service's copies
// as the feed would bring them.
export const writePuzzle = (fixture_: PuzzleFixture) =>
  fixture<{ puzzleId: string }>({ op: "puzzle", ...fixture_ }).then(
    (r) => r.puzzleId,
  );

export const fillInkOnBoard = (boardId: string, spare: number) =>
  fixture<{ nodeId: string }>({ op: "fillInk", boardId, spare }).then(
    (r) => r.nodeId,
  );

export const clearVersionsOf = (boardId: string) =>
  fixture({ op: "clearVersions", boardId });

export const TEST_BUCKET = {
  bucketName: "jr-test-images",
  bucketRegion: "us-east-1",
};

export const setImageBucketOn = (on: boolean) =>
  post("/test/fixture", { op: "imageBucket", on, ...TEST_BUCKET });

export type PresenceDoc = {
  _id: string;
  board: string;
  user: string;
  name: string;
} & Partial<WhiteboardLiveState>;

const stripBoard = (args: unknown) => {
  if (typeof args !== "object" || args === null) return args;
  const { boardId: _boardId, ...rest } = args as { boardId?: string };
  return rest;
};

const SETTLE_TIMEOUT_MS = 15000;

// A person's socket to the board. The page's one feeds the store, as
// main.tsx's does; another feeds its own presence collection, so a test
// can see what the page sends as another browser sees it.
export class BoardConnection {
  session: Session;
  // Presence as this connection sees it, this page's included, keyed by
  // connection id. Only kept for connections that aren't the page's.
  presence = new Collection<PresenceDoc>("their-presence");
  private welcomeWaiters: (() => void)[] = [];
  private name: string;
  // Opening or reopening the socket, so calls wait for it
  private opening: Promise<void> | undefined;

  private constructor(
    readonly person: Person,
    readonly isPage: boolean,
    token: string,
  ) {
    this.name = person.name;
    this.session = this.openSession(token);
  }

  private openSession(token: string): Session {
    const session = new Session({
      url: socketUrl,
      token,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
      requestToken: () => {
        void this.renew();
      },
      handlers: {
        welcome: (message) => {
          if (this.isPage) {
            applyWelcome(message);
            welcome.set({ ...message, snapshot: undefined });
          }
          this.welcomeWaiters.splice(0).forEach((resolve) => resolve());
        },
        change: (change) => {
          if (this.isPage) applyChange(change);
        },
        live: (live) => this.onLive(live),
        presence: (message) => this.onPresence(message),
        state: (state) => {
          if (this.isPage) connection.set(state);
        },
      },
    });
    if (this.isPage) setSession(session);
    return session;
  }

  static async open(person: Person, isPage: boolean) {
    const token = await mintToken(person);
    const opened = new BoardConnection(person, isPage, token);
    await opened.connect();
    return opened;
  }

  private connect() {
    const welcomed = this.nextWelcome();
    this.session.connect();
    this.opening = welcomed.finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  // Jolly Roger's presence subscription put a connection on the board and
  // its stop took it off; here a socket on the board is just that. Joining
  // once already joined is nothing; stopping leaves (the socket closes,
  // and the next call or join opens another). The leaving waits a turn:
  // Jolly Roger took the presence off at once, but a live update sent
  // straight after put it back before anyone's buffered writes flushed,
  // so a call made straight after a stop keeps this connection on the
  // board, as that did.
  private leaving: ReturnType<typeof setTimeout> | undefined;

  join(): { stop: () => void } {
    this.stayOn();
    if (this.session.status === "closed") void this.rejoin();
    return { stop: () => this.leave() };
  }

  private stayOn() {
    clearTimeout(this.leaving);
    this.leaving = undefined;
  }

  async rejoin() {
    this.stayOn();
    if (this.opening) return this.opening;
    if (this.session.status !== "closed") return;
    const token = await mintToken(this.person, this.name);
    this.session = this.openSession(token);
    await this.connect();
  }

  leave() {
    if (this.leaving) return;
    this.leaving = setTimeout(() => {
      this.leaving = undefined;
      this.session.close();
      this.presence.replaceAll([]);
    }, 0);
  }

  private boardId() {
    return this.session.welcome?.board;
  }

  private onLive(live: LiveBroadcast) {
    const boardId = this.boardId();
    if (!boardId) return;
    if (this.isPage) {
      applyLive(boardId, live);
      return;
    }
    const { connection: id, ...rest } = live;
    this.presence.set({ _id: id, board: boardId, ...rest });
  }

  private onPresence(message: Presence) {
    const boardId = this.boardId();
    if (!boardId) return;
    if (this.isPage) {
      applyPresence(boardId, message);
      return;
    }
    const users = message.users as LiveBroadcast[];
    this.presence.replaceAll(
      users.map(({ connection: id, ...rest }) => ({
        _id: id,
        board: boardId,
        ...rest,
      })),
    );
  }

  nextWelcome(): Promise<void> {
    return new Promise((resolve) => {
      this.welcomeWaiters.push(resolve);
    });
  }

  // A fresh token for this person, as Jolly Roger would mint it now (the
  // hunt's archived state, and a changed name), renewed on the socket.
  async renew(name = this.name) {
    this.name = name;
    const token = await mintToken(this.person, name);
    const welcomed = this.nextWelcome();
    this.session.setToken(token);
    await welcomed;
    console.log(
      `[debug renew] ${this.person.user} -> ${name}: welcome says ${this.session.welcome?.name}, status ${this.session.status}`,
    );
  }

  // A call as this person, in the shape the tests made them: the boardId
  // Jolly Roger's methods took is dropped, and setWhiteboardLive is a live
  // frame rather than a call.
  async call(name: string, args: unknown): Promise<unknown> {
    await this.rejoin();
    if (name === setWhiteboardLive.name) {
      this.session.sendLive(stripBoard(args) as WhiteboardLiveState);
      return this.roundTrip();
    }
    if (name === "updateProfile") {
      const { displayName } = args as { displayName: string };
      return this.renew(displayName);
    }
    return this.session.call(name, stripBoard(args));
  }

  // Settles once the server has handled everything sent before it: frames
  // on a socket are handled in order, and a refused call is answered like
  // any other.
  async roundTrip() {
    await this.session
      .call("fetchVersion", { versionId: "none", index: 0 })
      .catch(() => undefined);
  }

  // Until the socket is open with its welcome and no call is waiting for
  // its answer, or the socket is closed for good. Meteor's tests waited for
  // every subscription to be ready, which took in the data a just-made call
  // had asked for; here that's the calls themselves.
  async settled() {
    const until = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < until) {
      const { status, inFlight } = this.session;
      if (status === "closed" || status === "expired") return;
      if (status === "open" && inFlight === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`The session didn't settle (${this.session.status})`);
  }

  close() {
    this.stayOn();
    this.session.close();
    if (this.isPage) setSession(undefined);
  }
}

// The page's connection, which the page is rendered with and the tests'
// own calls go through: Meteor's one logged-in connection.
let page: BoardConnection | undefined;
const others = new Set<BoardConnection>();

export const pageConnection = () => page;

// Signs in as `person`, replacing whoever was signed in. The store starts
// afresh, as a new login's subscriptions would.
export async function login(person: Person) {
  if (page) {
    page.close();
    page = undefined;
    clearBoard();
    welcome.set(undefined);
  }
  page = await BoardConnection.open(person, true);
  return page;
}

export function logout() {
  page?.close();
  page = undefined;
  clearBoard();
  welcome.set(undefined);
}

// Another person's own connection, as a second browser would have
export async function connectOther(person: Person) {
  const other = await BoardConnection.open(person, false);
  others.add(other);
  return other;
}

export function disconnectOther(other: BoardConnection) {
  others.delete(other);
  other.close();
}

// Archives or unarchives the hunt: every open session gets the token
// Jolly Roger would mint now, so the pages' access follows.
export async function setHuntArchived(isArchived: boolean) {
  huntArchived = isArchived;
  await Promise.all([page, ...others].map((c) => c?.renew()));
}

// Lets the page's socket settle and whatever React has queued run, as
// waiting for subscriptions and Tracker.afterFlush did.
export async function stabilize() {
  if (page) await page.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The board page as the entry renders it, on the page's session
export const TestApp = () => {
  const current = page;
  if (!current) throw new Error("Nobody is signed in");
  return (
    <ThemeProvider theme={lightTheme}>
      <WhiteboardPage session={current.session} />
    </ThemeProvider>
  );
};

// Sets the page's address (path and search), as navigating there would
export function setLocation(url: string) {
  window.history.replaceState(window.history.state, "", url);
}

// A container the board fills, as the iframe does, over the runner's
// report; Testing Library removes it on cleanup.
export function boardContainer() {
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.background = "white";
  // Ahead of the report, so a failure's DOM dump starts with the board
  document.body.insertBefore(container, document.body.firstChild);
  return container;
}
