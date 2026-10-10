import { signToken } from "../server/token";
import FixtureHunt from "../tests/server/fixtureHunt";

// Fills a running service with the fixture hunt's tags and puzzles (which
// the feed will bring once it exists), asks it for the hunt's board, and
// prints a link into it with a token for a made-up member. For looking at
// the client in a browser, not for production.
//
//   MONGO_URL=... JR_SHARED_SECRET=... bun run scripts/seed-dev.ts [service url]

import { connect, disconnect } from "../lib/db";
import Puzzles from "../lib/models/Puzzles";
import Tags from "../lib/models/Tags";
import { withUser } from "../lib/typedModel/userContext";

const serviceUrl = process.argv[2] ?? "http://127.0.0.1:3100";
const mongoUrl = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27217/huntboard";
const secret = process.env.JR_SHARED_SECRET;
if (!secret) throw new Error("JR_SHARED_SECRET must be set");

// Ids are Meteor-style: 17 characters from the alphabet lib/compat/random uses
const SEEDER = "seedScriptXXXXXX2";
const huntId = FixtureHunt._id;

await connect(mongoUrl);
await withUser(SEEDER, async () => {
  for (const { _id, name } of FixtureHunt.tags) {
    await Tags.upsertAsync(
      { _id },
      { $setOnInsert: { createdBy: SEEDER }, $set: { hunt: huntId, name } },
    );
  }
  for (const puzzle of FixtureHunt.puzzles) {
    await Puzzles.upsertAsync(
      { _id: puzzle._id },
      {
        $setOnInsert: { createdBy: SEEDER },
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
});
await disconnect();

const response = await fetch(`${serviceUrl}/boards`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ scope: { hunt: huntId } }),
});
if (!response.ok) {
  throw new Error(
    `POST /boards failed: ${response.status} ${await response.text()}`,
  );
}
const { id, url } = (await response.json()) as { id: string; url: string };

const tokenFor = (user: string, name: string, operator = false) =>
  signToken(
    {
      v: 1,
      scope: { hunt: huntId },
      user,
      name,
      mayEdit: true,
      exp: Date.now() + 5 * 60 * 1000,
      ...(operator ? { operator: true } : {}),
    },
    secret,
  );

console.log(`Board ${id}`);
console.log(`${url}?token=${tokenFor("AxceDevPersonXXX2", "Alice", true)}`);
console.log(`${url}?token=${tokenFor("BobDevPersonXXXX2", "Bob")}`);
