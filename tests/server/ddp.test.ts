import { describe, it } from "bun:test";
import { assert } from "chai";
import type { DataMessage } from "../../server/feed/ddp";
import { DdpError, passwordDigest } from "../../server/feed/ddp";
import { connected, makeClient, tick } from "./fakeDdp";

// The DDP client's message handling, against a socket the test plays the
// server on: no network, no Meteor.

describe("ddp client", () => {
  it("opens with a connect frame and logs in once connected", async () => {
    const { client, socket } = makeClient();
    let session: string | undefined;
    client.onConnected((s) => {
      session = s;
    });
    client.connect();
    socket().open();
    assert.deepEqual(socket().sent[0], {
      msg: "connect",
      version: "1",
      support: ["1"],
    });
    socket().receive({ msg: "connected", session: "abc" });
    await tick();
    assert.equal(session, "abc");
    assert.isTrue(client.isConnected);
    assert.isFalse(client.isLoggedIn);
    const login = socket().answerLogin("u1", "fresh-token");
    assert.deepEqual(login.params, [{ resume: "resume-1" }]);
    await tick();
    assert.isTrue(client.isLoggedIn);
    assert.equal(client.userId, "u1");
    assert.equal(client.token, "fresh-token");
  });

  it("falls back to the password when the token is stale", async () => {
    const { client, socket } = makeClient({
      token: "stale",
      email: "board@example.test",
      password: "hunter2",
    } as { token: string });
    const logins: unknown[] = [];
    client.onLogin((result) => logins.push(result));
    client.connect();
    socket().open();
    socket().receive({ msg: "connected", session: "s" });
    await tick();
    const first = socket().last("method") as { id: string; params: unknown[] };
    assert.deepEqual(first.params, [{ resume: "stale" }]);
    socket().receive({
      msg: "result",
      id: first.id,
      error: { error: 403, reason: "You've been logged out by the server." },
    });
    await tick();
    const second = socket().last("method") as { id: string; params: unknown[] };
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.params, [
      {
        user: { email: "board@example.test" },
        password: { digest: passwordDigest("hunter2"), algorithm: "sha-256" },
      },
    ]);
    socket().receive({
      msg: "result",
      id: second.id,
      result: { id: "u", token: "new-token" },
    });
    await tick();
    assert.lengthOf(logins, 1);
    assert.equal(client.token, "new-token");
  });

  it("reports a login that fails outright and closes the socket", async () => {
    const { client, socket } = makeClient();
    const failures: DdpError[] = [];
    client.onLoginFailed((error) => failures.push(error));
    client.connect();
    socket().open();
    socket().receive({ msg: "connected", session: "s" });
    await tick();
    const login = socket().last("method") as { id: string };
    socket().receive({
      msg: "result",
      id: login.id,
      error: { error: 403, reason: "Token expired" },
    });
    await tick();
    assert.lengthOf(failures, 1);
    assert.equal(failures[0]?.reason, "Token expired");
    assert.equal(socket().closed?.code, 4000);
    client.close();
  });

  it("answers pings, with the id when there is one", async () => {
    const { client, socket } = await connected();
    socket().receive({ msg: "ping" });
    socket().receive({ msg: "ping", id: "p1" });
    const pongs = socket().sent.filter((m) => m.msg === "pong");
    assert.deepEqual(pongs, [{ msg: "pong" }, { msg: "pong", id: "p1" }]);
    client.close();
  });

  it("hands added, changed (with cleared fields) and removed to onData", async () => {
    const { client, socket } = await connected();
    const seen: DataMessage[] = [];
    client.onData((message) => seen.push(message));
    const when = new Date("2026-01-02T03:04:05Z");
    socket().receive({
      msg: "added",
      collection: "jr_puzzles",
      id: "p1",
      fields: { title: "One", createdAt: when },
    });
    socket().receive({
      msg: "changed",
      collection: "jr_puzzles",
      id: "p1",
      fields: { title: "Two" },
      cleared: ["url"],
    });
    socket().receive({ msg: "removed", collection: "jr_puzzles", id: "p1" });
    assert.deepEqual(seen, [
      {
        msg: "added",
        collection: "jr_puzzles",
        id: "p1",
        fields: { title: "One", createdAt: when },
      },
      {
        msg: "changed",
        collection: "jr_puzzles",
        id: "p1",
        fields: { title: "Two" },
        cleared: ["url"],
      },
      { msg: "removed", collection: "jr_puzzles", id: "p1" },
    ]);
    assert.instanceOf(seen[0]?.fields?.createdAt, Date);
    client.close();
  });

  it("sends subscriptions once logged in and reports ready and nosub", async () => {
    const { client, socket } = makeClient();
    let ready = 0;
    let stopped: DdpError | undefined;
    const sub = client.subscribe(
      "Puzzles.publications.forHunt",
      [{ huntId: "h" }],
      {
        onReady: () => {
          ready += 1;
        },
        onStop: (error) => {
          stopped = error;
        },
      },
    );
    client.connect();
    socket().open();
    socket().receive({ msg: "connected", session: "s" });
    await tick();
    assert.isUndefined(socket().last("sub"), "not before login");
    socket().answerLogin();
    await tick();
    assert.deepEqual(socket().last("sub"), {
      msg: "sub",
      id: sub.id,
      name: "Puzzles.publications.forHunt",
      params: [{ huntId: "h" }],
    });
    socket().receive({ msg: "ready", subs: [sub.id] });
    assert.equal(ready, 1);
    socket().receive({
      msg: "nosub",
      id: sub.id,
      error: { error: 404, reason: "Subscription not found" },
    });
    assert.equal(stopped?.reason, "Subscription not found");
    sub.stop();
    assert.deepEqual(socket().last("unsub"), { msg: "unsub", id: sub.id });
    client.close();
  });

  it("settles calls from result frames", async () => {
    const { client, socket } = await connected();
    const ok = client.call("echo", [1, 2]);
    const method = socket().last("method") as {
      id: string;
      method: string;
      params: unknown[];
    };
    assert.equal(method.method, "echo");
    assert.deepEqual(method.params, [1, 2]);
    socket().receive({ msg: "result", id: method.id, result: 3 });
    socket().receive({ msg: "updated", methods: [method.id] });
    assert.equal(await ok, 3);
    const bad = client.call("boom");
    const boom = socket().last("method") as { id: string };
    socket().receive({
      msg: "result",
      id: boom.id,
      error: { error: "bad", reason: "Boom" },
    });
    try {
      await bad;
      assert.fail("expected a rejection");
    } catch (error) {
      assert.instanceOf(error, DdpError);
      assert.equal((error as DdpError).error, "bad");
    }
    client.close();
  });

  it("reconnects after a drop, logs in with the new token and resubscribes", async () => {
    const { client, sockets, socket } = await connected();
    const sub = client.subscribe("Puzzles.publications.forPuzzleList", [
      { huntId: "h" },
    ]);
    let disconnects = 0;
    client.onDisconnected(() => {
      disconnects += 1;
    });
    const pending = client.call("slow").catch((error: unknown) => error);
    const first = socket();
    client.dropConnection();
    await tick();
    assert.equal(disconnects, 1);
    assert.isFalse(client.isConnected);
    assert.equal(((await pending) as DdpError).error, "disconnected");
    // The backoff is a millisecond or two
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.lengthOf(sockets, 2);
    const second = socket();
    assert.notEqual(second, first);
    second.open();
    assert.equal(second.sent[0]?.msg, "connect");
    second.receive({ msg: "connected", session: "s2" });
    await tick();
    const login = second.last("method") as { params: unknown[] };
    assert.deepEqual(
      login.params,
      [{ resume: "token1" }],
      "the token the first login gave",
    );
    second.answerLogin("user1", "token2");
    await tick();
    assert.deepEqual(second.last("sub"), {
      msg: "sub",
      id: sub.id,
      name: "Puzzles.publications.forPuzzleList",
      params: [{ huntId: "h" }],
    });
    client.close();
    await tick();
    assert.lengthOf(sockets, 2, "no reconnect after close");
  });
});
