import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import Puzzles from "lib/models/Puzzles";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import { MAX_INK_POINTS_PER_BOARD } from "lib/whiteboard/limits";
import Locks from "../../server/models/Locks";
import { ensureBoard } from "../../server/whiteboard";
import { claimsFor, huntId } from "./harness";

// Fixtures the whiteboard server tests share. The hunt is the fixture hunt.

// An ink stroke of `count` points that zigzags, so simplifying keeps every
// one of them
export const zigzag = (count: number, position?: { x: number; y: number }) => ({
  _id: Random.id(),
  type: "ink" as const,
  position: position ?? { x: 0, y: 0 },
  strokeWidth: "thin" as const,
  stroke: Random.id(),
  points: Array.from({ length: count }, (_, i): [number, number, number] => [
    i * 5,
    (i % 2) * 5,
    0.5,
  ]),
});

// Ink straight into the board, bypassing the budget, leaving `room` points of
// it (or past it, for a negative room). Returns the stroke's id.
export const fillInk = (boardId: string, room: number, createdBy: string) =>
  WhiteboardNodes.insertAsync({
    hunt: huntId,
    board: boardId,
    type: "ink",
    position: { x: 0, y: 0 },
    strokeWidth: "thin",
    points: Array.from(
      { length: MAX_INK_POINTS_PER_BOARD - room },
      (_, i): [number, number, number] => [i % 1000, i % 7, 0.5],
    ),
    createdBy,
  });

// Another hunt's board, and an operator's claims on it. `puzzles` are titles
// of puzzles put in the hunt before the board is seeded, so they get cards.
export async function otherHuntBoard(operator: Claims, puzzles: string[] = []) {
  const hunt = Random.id();
  for (const title of puzzles) {
    await Puzzles.insertAsync({
      hunt,
      title,
      tags: [],
      answers: [],
      expectedAnswerCount: 1,
      createdBy: operator.user,
    });
  }
  const board = await ensureBoard({ hunt }, operator.user);
  return {
    hunt,
    board,
    claims: claimsFor(operator.user, { hunt, operator: true }),
  };
}

export const IMAGE_BUCKET = {
  bucketName: "jr-test-images",
  bucketRegion: "ap-southeast-2",
};
// The url of an object in the image bucket
export const inBucket = (key: string) =>
  `https://s3.${IMAGE_BUCKET.bucketRegion}.amazonaws.com/${IMAGE_BUCKET.bucketName}/${key}`;
// Where an upload for a puzzle would be
export const uploadUrl = (hunt: string, puzzle: string) =>
  inBucket(`${hunt}/${puzzle}/${Random.id()}`);
// Points image uploads at the test bucket, as the environment would
export const withImageBucket = () => {
  process.env.S3_IMAGE_BUCKET_NAME = IMAGE_BUCKET.bucketName;
  process.env.S3_IMAGE_BUCKET_REGION = IMAGE_BUCKET.bucketRegion;
};
export const withoutImageBucket = () => {
  delete process.env.S3_IMAGE_BUCKET_NAME;
  delete process.env.S3_IMAGE_BUCKET_REGION;
};

// Another server after the board's lock. steal() takes the lock the first time
// it's called while someone holds it, letGo() hands it back, and `held` is the
// stolen lock while it's held.
export function lockThief(boardId: string) {
  const lockName = `whiteboard:${boardId}`;
  let held: string | undefined;
  return {
    get held() {
      return held;
    },
    steal: async () => {
      const theirs = await Locks.findOneAsync({ name: lockName });
      if (theirs && !held) {
        await Locks.removeAsync(theirs._id);
        held = await Locks.insertAsync({ name: lockName });
      }
    },
    letGo: async () => {
      if (held) await Locks.removeAsync(held);
      held = undefined;
    },
  };
}
