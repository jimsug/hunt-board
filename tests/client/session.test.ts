import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import type { Change, Presence, Welcome } from "lib/protocol";
import type { LiveBroadcast } from "../../client/session";
import { Session, tokenExpiry } from "../../client/session";
import type { ConnectionState } from "../../client/store/current";
import type { Service } from "../../server/app";
import { closeRooms } from "../../server/rooms";
import { ensureBoard } from "../../server/whiteboard";
import {
  claimsFor,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setUpDatabase,
  tearDownDatabase,
  waitForAssertion,
} from "../server/harness";
import { startTestService, tokenOf } from "../server/service";

// The client's session against a real service: hello and welcome, calls
// answered and refused, what arrives for the store, reconnecting with a
// fresh hello when the socket drops, and asking for a token before the one
// it has runs out.

describe("Session", () => {
  let service: Service;
  let operator: Claims;
  const sessions: Session[] = [];

  beforeAll(async () => {
    await setUpDatabase();
    service = startTestService({ pingIntervalMs: 200 });
  });
  afterAll(async () => {
    await service.stop();
    await tearDownDatabase();
  });
  beforeEach(async () => {
    for (const session of sessions.splice(0)) session.close();
    await closeRooms(() => {});
    await resetDatabase();
    operator = makeUser(true);
    await makeFixtureHunt(operator.user);
    await ensureBoard({ hunt: huntId }, operator.user);
  });

  interface Seen {
    welcomes: Welcome[];
    changes: Change[];
    live: LiveBroadcast[];
    presence: Presence[];
    states: ConnectionState[];
    asked: number;
  }

  const open = (claims: Claims, options: { renew?: boolean } = {}) => {
    const seen: Seen = {
      welcomes: [],
      changes: [],
      live: [],
      presence: [],
      states: [],
      asked: 0,
    };
    const session = new Session({
      url: `${service.url.replace(/^http/, "ws")}/ws`,
      token: tokenOf(claims),
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      requestToken: () => {
        seen.asked += 1;
        if (options.renew) {
          session.setToken(
            tokenOf({ ...claims, exp: Date.now() + 5 * 60 * 1000 }),
          );
        }
      },
      handlers: {
        welcome: (w) => seen.welcomes.push(w),
        change: (c) => seen.changes.push(c),
        live: (l) => seen.live.push(l),
        presence: (p) => seen.presence.push(p),
        state: (s) => seen.states.push(s),
      },
    });
    sessions.push(session);
    session.connect();
    return { session, seen };
  };

  const untilOpen = (session: Session) =>
    waitForAssertion(() => assert.equal(session.status, "open"));
  // The code a refused call carries, in Meteor.Error's field
  const codeOf = (error: Error) =>
    (error as unknown as { error: number }).error;

  it("says hello and hands the welcome, with its snapshot, to the store", async () => {
    const { session, seen } = open(operator);
    await untilOpen(session);
    assert.lengthOf(seen.welcomes, 1);
    const [welcome] = seen.welcomes;
    assert.equal(welcome?.user, operator.user);
    assert.isTrue(welcome?.operator);
    assert.isDefined(welcome?.snapshot);
    assert.isAbove(welcome?.snapshot?.nodes.length ?? 0, 0);
    assert.deepEqual(welcome?.flags, []);
    assert.equal(welcome?.jrUrl, "https://jr.example.test");
    assert.isFalse(welcome?.imagesEnabled);
    assert.equal(session.welcome, welcome);
  });

  it("resolves a call with the server's value and rejects a refusal", async () => {
    const { session, seen } = open(operator);
    await untilOpen(session);
    const id = Random.id();
    const value = await session.call("upsertNodes", {
      nodes: [{ _id: id, type: "text", position: { x: 1, y: 2 }, text: "hi" }],
    });
    assert.isUndefined(value);
    await waitForAssertion(() =>
      assert.isTrue(seen.changes.some((c) => c.id === id)),
    );
    const error = await rejects(
      session.call("upsertNodes", { nodes: [{ _id: "not an id" }] }),
    );
    assert.equal(codeOf(error), 400);
    assert.match(error.message, /Invalid node id/);
    const unknown = await rejects(session.call("nothing", {}));
    assert.equal(codeOf(unknown), 404);
  });

  it("answers each call by its own id", async () => {
    const { session } = open(operator);
    await untilOpen(session);
    const results = await Promise.all([
      session.call("exportBoard", { index: 0 }),
      session.call("upsertNodes", { nodes: [] }),
      session.call("exportBoard", { index: 0 }),
    ]);
    assert.isObject(results[0]);
    assert.isUndefined(results[1]);
    assert.isObject(results[2]);
  });

  it("refuses a call before the welcome and after a close", async () => {
    const { session } = open(operator);
    const early = await rejects(session.call("upsertNodes", { nodes: [] }));
    assert.equal(codeOf(early), 503);
    await untilOpen(session);
    session.close();
    const late = await rejects(session.call("upsertNodes", { nodes: [] }));
    assert.equal(codeOf(late), 503);
    assert.equal(session.status, "closed");
  });

  it("passes live updates and presence through", async () => {
    const member = makeUser();
    const a = open(operator);
    const b = open(member);
    await untilOpen(a.session);
    await untilOpen(b.session);
    await waitForAssertion(() =>
      assert.isTrue(
        a.seen.presence.some((p) =>
          p.users.some((u) => (u as { user: string }).user === member.user),
        ),
      ),
    );
    b.session.sendLive({ cursor: { x: 5, y: 6 }, drag: null, stroke: null });
    await waitForAssertion(() => {
      const last = a.seen.live.at(-1);
      assert.equal(last?.user, member.user);
      assert.deepEqual(last?.cursor, { x: 5, y: 6 });
    });
    assert.lengthOf(b.seen.live, 0);
  });

  it("reconnects with a fresh hello when the socket drops", async () => {
    const { session, seen } = open(operator);
    await untilOpen(session);
    const pending = session.call("exportBoard", { index: 0 });
    await closeRooms((member) => member.close(1001, "Service restarting"));
    const error = await rejects(pending);
    assert.equal(codeOf(error), 1001);
    await waitForAssertion(() =>
      assert.isTrue(seen.states.some((s) => s.status === "reconnecting")),
    );
    await waitForAssertion(() => assert.lengthOf(seen.welcomes, 2), 10000);
    assert.equal(session.status, "open");
    assert.isDefined(seen.welcomes[1]?.snapshot);
    const value = await session.call("exportBoard", { index: 0 });
    assert.isObject(value);
  });

  it("stays closed on a terminal close, saying why", async () => {
    const elsewhere = claimsFor(Random.id(), { hunt: Random.id() });
    const { session, seen } = open(elsewhere);
    await waitForAssertion(() => assert.equal(session.status, "closed"));
    assert.equal(session.state.code, 4404);
    assert.lengthOf(seen.welcomes, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(session.status, "closed");
  });

  it("asks for a fresh token as expiry nears and renews the hello with it", async () => {
    const soon = { ...operator, exp: Date.now() + 30 * 1000 };
    const { session, seen } = open(soon, { renew: true });
    await untilOpen(session);
    await waitForAssertion(() => assert.lengthOf(seen.welcomes, 2));
    assert.isUndefined(seen.welcomes[1]?.snapshot);
    assert.equal(seen.asked, 1);
    assert.equal(session.status, "open");
  });

  it("keeps asking while no token comes", async () => {
    const soon = { ...operator, exp: Date.now() + 30 * 1000 };
    const { session, seen } = open(soon);
    await untilOpen(session);
    await waitForAssertion(() => assert.equal(seen.asked, 1));
    assert.lengthOf(seen.welcomes, 1);
  });

  it("hides and shows ink with another hello on the same socket", async () => {
    const { session, seen } = open(operator);
    await untilOpen(session);
    const states = seen.states.length;
    session.setHideInk(true);
    await waitForAssertion(() => assert.lengthOf(seen.welcomes, 2));
    assert.isDefined(seen.welcomes[1]?.snapshot);
    assert.equal(session.status, "open");
    // No reconnect: nothing but open since
    assert.isTrue(seen.states.slice(states).every((s) => s.status === "open"));
    session.setHideInk(true);
    session.setHideInk(false);
    await waitForAssertion(() => assert.lengthOf(seen.welcomes, 3));
  });

  it("reads a token's expiry", () => {
    const exp = Date.now() + 1000;
    assert.equal(tokenExpiry(tokenOf({ ...operator, exp })), exp);
    assert.isUndefined(tokenExpiry("not.a.token"));
    assert.isUndefined(tokenExpiry(""));
  });
});
