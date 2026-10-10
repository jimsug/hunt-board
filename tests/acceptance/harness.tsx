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

// Who the tests are. Jolly Roger made accounts; here a person is a token's
// claims, with Meteor-style ids so the models take them as createdBy.
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

// What Jolly Roger's puzzle methods did, written into the service's copies
// as the feed would bring them.
export const writePuzzle = (fixture: PuzzleFixture) =>
  post<{ puzzleId: string }>("/test/fixture", {
    op: "puzzle",
    ...fixture,
  }).then((r) => r.puzzleId);

export const fillInkOnBoard = (boardId: string, spare: number) =>
  post<{ nodeId: string }>("/test/fixture", {
    op: "fillInk",
    boardId,
    spare,
  }).then((r) => r.nodeId);

export const clearVersionsOf = (boardId: string) =>
  post("/test/fixture", { op: "clearVersions", boardId });

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

  private constructor(
    readonly person: Person,
    readonly isPage: boolean,
    token: string,
  ) {
    this.name = person.name;
    this.session = new Session({
      url: socketUrl,
      token,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
      requestToken: () => {
        void this.renew();
      },
      handlers: {
        welcome: (message) => {
          if (isPage) {
            applyWelcome(message);
            welcome.set({ ...message, snapshot: undefined });
          }
          this.welcomeWaiters.splice(0).forEach((resolve) => resolve());
        },
        change: (change) => {
          if (isPage) applyChange(change);
        },
        live: (live) => this.onLive(live),
        presence: (message) => this.onPresence(message),
        state: (state) => {
          if (isPage) connection.set(state);
        },
      },
    });
  }

  static async open(person: Person, isPage: boolean) {
    const token = await mintToken(person);
    const opened = new BoardConnection(person, isPage, token);
    if (isPage) setSession(opened.session);
    const welcomed = opened.nextWelcome();
    opened.session.connect();
    await welcomed;
    return opened;
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
  }

  // A call as this person, in the shape the tests made them: the boardId
  // Jolly Roger's methods took is dropped, and setWhiteboardLive is a live
  // frame rather than a call.
  call(name: string, args: unknown): Promise<unknown> {
    if (name === setWhiteboardLive.name) {
      this.session.sendLive(stripBoard(args) as WhiteboardLiveState);
      return this.roundTrip();
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

  // Until the socket is open with its welcome, or closed for good
  async settled() {
    const until = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < until) {
      const { status } = this.session;
      if (status === "open" || status === "closed" || status === "expired") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`The session didn't settle (${this.session.status})`);
  }

  close() {
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
  document.body.appendChild(container);
  return container;
}
