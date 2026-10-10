import { type Mock, spyOn } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import { connect, db, disconnect } from "lib/db";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import ensureIndexes from "lib/typedModel/ensureIndexes";
import type { FlagName } from "../../server/flags";
import Flags from "../../server/flags";
import type { CallContext } from "../../server/methods";
import { callMethod } from "../../server/methods";
import { deferredSyncsDone } from "../../server/whiteboard";
import FixtureHunt from "./fixtureHunt";

// What the server tests share: the scratch Mongo, the fixture hunt's copies,
// claims in place of Jolly Roger's users, and the odd assertion helper.

export const MONGO_URL =
  process.env.MONGO_URL ?? "mongodb://127.0.0.1:27217/huntboard";

export const huntId = FixtureHunt._id;

// A test file connects once, and the indexes the lock and duplicate-key
// code rely on are built then.
export async function setUpDatabase() {
  await connect(MONGO_URL);
  await ensureIndexes(undefined, { info() {}, warn() {} });
}

export async function tearDownDatabase() {
  await deferredSyncsDone();
  await disconnect();
}

// Empties every collection, keeping the indexes.
export async function resetDatabase() {
  await deferredSyncsDone();
  for (const collection of await db().collections()) {
    await collection.deleteMany({});
  }
}

// A token's claims for someone on the fixture hunt's board, or elsewhere.
export function claimsFor(
  user: string,
  {
    hunt = huntId,
    puzzle,
    operator = false,
    mayEdit = true,
    name,
  }: {
    hunt?: string;
    puzzle?: string;
    operator?: boolean;
    mayEdit?: boolean;
    name?: string;
  } = {},
): Claims {
  return {
    v: 1,
    scope: { hunt, ...(puzzle ? { puzzle } : {}) },
    user,
    name: name ?? `User ${user.slice(0, 4)}`,
    mayEdit,
    exp: Date.now() + 5 * 60 * 1000,
    ...(operator ? { operator: true } : {}),
  };
}

// A new person in the hunt, an operator when asked. Jolly Roger made an
// account; here a person is only their claims.
export const makeUser = (operator = false) =>
  claimsFor(Random.id(), { operator });

// The same person once their hunt is archived: Jolly Roger mints their
// next token with mayEdit off.
export const archived = (claims: Claims): Claims => ({
  ...claims,
  mayEdit: false,
});

// The fixture hunt's tags and puzzles, into the copies the feed will fill.
export async function makeFixtureHunt(createdBy: string) {
  for (const { _id, name } of FixtureHunt.tags) {
    await Tags.upsertAsync(
      { _id },
      { $setOnInsert: { createdBy }, $set: { hunt: huntId, name } },
    );
  }
  for (const puzzle of FixtureHunt.puzzles) {
    await Puzzles.upsertAsync(
      { _id: puzzle._id },
      {
        $setOnInsert: { createdBy },
        $set: {
          hunt: huntId,
          title: puzzle.title,
          url: puzzle.url,
          expectedAnswerCount: puzzle.expectedAnswerCount,
          tags: puzzle.tags,
          answers: puzzle.guesses
            .filter((g) => g.state === "correct")
            .map((g) => g.guess),
        },
      },
    );
  }
}

// A call as the client makes it, checked against its schema
export const call = (
  name: string,
  claims: Claims,
  boardId: string,
  args: unknown,
  context?: CallContext,
) => callMethod(name, claims, boardId, args, context);

export const setFlag = (name: FlagName) => Flags.set(name, true);
export const clearFlag = (name: FlagName) => Flags.set(name, false);

// Asserts that the promise rejects, with a message matching `match` if
// given, and returns the error.
export async function rejects(
  promise: Promise<unknown>,
  match?: RegExp,
): Promise<Error> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (error === undefined) assert.fail("expected the promise to reject");
  const message = error instanceof Error ? error.message : String(error);
  if (match) assert.match(message, match);
  return error as Error;
}

// Polls an assertion (async, if it reads the database) until it stops
// throwing. Once the wall-clock deadline passes, a final attempt runs outside
// the try, so the assertion's own error is what propagates.
export async function waitForAssertion(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch {
      await setImmediate();
    }
  }
  await assertion();
}

// Spies on a model's method. spyOn's own typing refuses a plain function as
// the implementation of a generic method (find, findOneAsync), so this
// loosens it.
export const spyOnMethod = <T extends object>(
  target: T,
  method: keyof T & string,
) => spyOn(target, method as never) as unknown as Mock<(...args: any[]) => any>;

// A fake connection for exports: an id, and a close the test can trigger.
export function fakeConnection() {
  const closers: (() => void)[] = [];
  return {
    id: Random.id(),
    onClose(cb: () => void) {
      closers.push(cb);
    },
    close: () => closers.forEach((cb) => cb()),
  };
}

// Freezes Date.now at the real time, and returns a tick to move it on.
// Only Date.now, so the driver's own timers still run.
export function fakeNow() {
  let now = Date.now();
  const original = Date.now;
  Date.now = () => now;
  return {
    tick: (ms: number) => {
      now += ms;
    },
    restore: () => {
      Date.now = original;
    },
  };
}
