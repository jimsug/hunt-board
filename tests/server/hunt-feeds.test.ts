import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import { Random } from "lib/compat/random";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import { onChange } from "../../server/changes";
import { startHuntFeeds } from "../../server/feed/hunts";
import { deferredSyncsDone, ensureBoard } from "../../server/whiteboard";
import type { FakeSocket } from "./fakeDdp";
import { makeClient, quiet, tick } from "./fakeDdp";
import {
  resetDatabase,
  setUpDatabase,
  tearDownDatabase,
  waitForAssertion,
} from "./harness";

// The hunt feed against a DDP server the test plays on a fake socket: what
// the server sends is mirrored into the copies, and what it sends again
// after a reconnect is written only where it changed.

describe("hunt feeds", () => {
  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);
  beforeEach(resetDatabase);

  // Logs the client in on its newest socket, as the server would
  const logIn = async (socket: FakeSocket) => {
    socket.open();
    socket.receive({ msg: "connected", session: Random.id() });
    await tick();
    socket.answerLogin();
    await tick();
    const subs = socket.all("sub") as { id: string; name: string }[];
    assert.lengthOf(subs, 2);
    return subs.map((sub) => sub.id);
  };

  it("mirrors what the server sends, and writes a resend only where it changed", async () => {
    const hunt = Random.id();
    const boardId = await ensureBoard({ hunt });
    const { client, sockets, socket } = makeClient();
    const feeds = startHuntFeeds({ client, logger: quiet });
    await feeds.settled();
    assert.deepEqual(feeds.hunts(), [hunt]);

    // Every change the rooms would hear of a copy
    const heard: string[] = [];
    const stopListening = onChange(({ collection, id }) => {
      if (collection === Puzzles.name || collection === Tags.name) {
        heard.push(`${collection}:${id}`);
      }
    });
    const tag = Random.id();
    const puzzleA = Random.id();
    const puzzleB = Random.id();
    const createdAt = new Date();
    const createdBy = Random.id();
    const puzzle = (title: string) => ({
      hunt,
      title,
      tags: [tag],
      answers: [],
      expectedAnswerCount: 1,
      createdAt,
      createdBy,
    });
    // The server's full send after a connect, then ready for both
    const serve = async (
      to: FakeSocket,
      subs: string[],
      titles: { a: string; b: string },
    ) => {
      to.receive({
        msg: "added",
        collection: Tags.name,
        id: tag,
        fields: { hunt, name: "group:things", createdAt, createdBy },
      });
      to.receive({
        msg: "added",
        collection: Puzzles.name,
        id: puzzleA,
        fields: puzzle(titles.a),
      });
      to.receive({
        msg: "added",
        collection: Puzzles.name,
        id: puzzleB,
        fields: puzzle(titles.b),
      });
      to.receive({ msg: "ready", subs });
      await feeds.settled();
      await deferredSyncsDone();
    };

    try {
      client.connect();
      await serve(socket(), await logIn(socket()), { a: "A", b: "B" });
      assert.sameMembers(heard, [
        `${Tags.name}:${tag}`,
        `${Puzzles.name}:${puzzleA}`,
        `${Puzzles.name}:${puzzleB}`,
      ]);
      assert.equal(
        await WhiteboardNodes.find({
          board: boardId,
          type: "puzzle",
        }).countAsync(),
        2,
      );
      heard.length = 0;

      // The connection drops; the client reconnects and the server sends
      // everything again, one puzzle renamed meanwhile
      client.dropConnection();
      await waitForAssertion(() => assert.lengthOf(sockets, 2));
      await serve(socket(), await logIn(socket()), { a: "A", b: "B renamed" });
      assert.deepEqual(heard, [`${Puzzles.name}:${puzzleB}`]);
      assert.equal((await Puzzles.findOneAsync(puzzleB))?.title, "B renamed");
      heard.length = 0;

      // A change that changes nothing, then one that does
      socket().receive({
        msg: "changed",
        collection: Puzzles.name,
        id: puzzleA,
        fields: { title: "A" },
      });
      await feeds.settled();
      assert.deepEqual(heard, []);
      socket().receive({
        msg: "changed",
        collection: Puzzles.name,
        id: puzzleA,
        fields: { answers: ["YES"] },
      });
      await feeds.settled();
      assert.deepEqual(heard, [`${Puzzles.name}:${puzzleA}`]);
      assert.deepEqual((await Puzzles.findOneAsync(puzzleA))?.answers, ["YES"]);
      heard.length = 0;

      // A removal retires the copy once
      for (let i = 0; i < 2; i++) {
        socket().receive({
          msg: "removed",
          collection: Puzzles.name,
          id: puzzleA,
        });
        await feeds.settled();
      }
      assert.deepEqual(heard, [`${Puzzles.name}:${puzzleA}`]);
      assert.isTrue(
        (await Puzzles.findOneAllowingDeletedAsync(puzzleA))?.deleted,
      );
      await deferredSyncsDone();
    } finally {
      stopListening();
      await feeds.stop();
      client.close();
    }
  });
});
