# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

## Layout

- `lib/` is shared pure code: the board logic under `lib/whiteboard/`, the models under `lib/models/`, the typed-model shim over the Mongo driver under `lib/typedModel/`, the replacements for the Meteor packages the code used under `lib/compat/`, who may do what from a token's claims in `lib/access.ts`, and the call schemas in `lib/protocol.ts`. `lib/db.ts` holds the connection.
- `server/` is the whiteboard server: placement and boards (`whiteboard.ts`), edits, versions, resets, the edit policy, comments, in-memory presence (`live.ts`), the call dispatcher (`methods.ts`) and the change seam (`changes.ts`); on top of that the process itself: the token (`token.ts`), the rooms that forward changes to sockets (`rooms.ts`), the websocket handler (`ws.ts`), the HTTP API and static client (`http.ts`), `startService` (`app.ts`), the configuration (`config.ts`) and the entry point (`main.ts`). `server/feed/` is the feed from Jolly Roger: a DDP client (`ddp.ts`), the hunt subscriptions that mirror puzzles and tags into the copies and hand changes to placement (`hunts.ts`), and `startFeed` (`index.ts`).
- `client/` is the board in the browser: Jolly Roger's whiteboard canvas under `client/components/` and `client/hooks/`, the in-memory store that stands in for Minimongo (`client/store/`), the websocket session (`client/session.ts`), the call objects (`client/methods.ts`), the page (`client/WhiteboardPage.tsx`) and the entry (`client/main.tsx`). Vite builds it from `index.html` into `dist/`.
- `tests/` holds the `bun test` suites. `tests/lib/typedModel.test.ts` and everything under `tests/server/` and `tests/client/session.test.ts` need a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`), whose contents they empty between tests. The http, ws, rooms and session suites start the service on a free port. `tests/server/feed.test.ts` also needs a running Jolly Roger (see below) and is skipped without one.
- `scripts/seed-dev.ts` fills a running service with the fixture hunt and prints links into its board, for looking at the client.
- `checks/` are the runtime probes written before the port started; they aren't part of the build.

Code is ported from Jolly Roger's `imports/lib` and `imports/server`; `PORTING.md` lists what was changed on the way.

## Configuration

Read from the environment, checked at start (a missing one stops the process naming it):

- `MONGO_URL` (required).
- `PORT` (default 3100).
- `PUBLIC_URL` (required): the origin the service is reachable at, for the board urls `POST /boards` answers.
- `JR_URL` (required): the Jolly Roger origin, the only one allowed to frame the board page.
- `JR_SHARED_SECRET` (required, 32 characters or more): signs the tokens Jolly Roger mints and is the bearer secret on the HTTP API.
- `FLAGS`: a comma-separated list of switches to turn on (`disable.whiteboard`, `disable.whiteboard_live`, `disable.whiteboard_versions`), which a `settings` document can also set at run time.
- `JR_SERVICE_EMAIL` and `JR_SERVICE_PASSWORD`, or `JR_SERVICE_TOKEN` (a resume token from an earlier login): the Jolly Roger account the feed logs in as. With both, the token is tried first and the password once it's stale; the token a password login hands back is kept in memory for reconnects. One or the other is required unless `FEED=off`.
- `FEED=off` runs without the feed (a deployment with no Jolly Roger behind it: the copies are whatever was written to them).
- `S3_IMAGE_BUCKET_NAME` and `S3_IMAGE_BUCKET_REGION` for the bucket image nodes may point at.
- `LOG_LEVEL=debug` for the dropped-update log.

## Running

```
bun run build      # the client, into dist/
bun run start      # the service
bun run dev        # the same, restarting on changes
bun run dev:client # Vite on :5173, proxying /ws and /boards to the service
```

The process serves the HTTP API (`POST /boards`, `DELETE /boards/:id`, `GET /boards/:id/activity` with `Authorization: Bearer <JR_SHARED_SECRET>`; `GET /healthz` open), the websocket on `/ws`, and the built client from `dist/` at `/` and `/boards/:id` (a placeholder page until the client is built). The page is sent with `Content-Security-Policy: frame-ancestors <JR_URL>`.

To look at a board without Jolly Roger: start the service, then `JR_SHARED_SECRET=... bun run scripts/seed-dev.ts` writes the fixture hunt's puzzles and tags, asks for its board and prints two links with tokens (an operator and a member, good for five minutes).

## The feed

The service keeps its own copies of Jolly Roger's puzzles and tags (`jr_puzzles` and `jr_tags`, the fields the board reads) and fills them over DDP: it logs in to `<JR_URL>/websocket` as the service account and, for every hunt that has a board, subscribes to `Puzzles.publications.forHunt` (`{ huntId, includeDeleted: true }`) and `Puzzles.publications.forPuzzleList` (`{ huntId }`, which is where the tags come from; Jolly Roger has no tags-only publication). A hunt gains its pair when its board is created (`POST /boards`) and loses it, and its copies, when the board is deleted. Documents are mirrored as they arrive; the puzzles a burst of changes touches (a changed tag's are the puzzles carrying it) go to the board's deferred placement, so cards, frames and feeder arrows follow Jolly Roger as its own hooks made them. A dropped connection reconnects with backoff (1 s doubling to 30 s), logs in again and resubscribes; the server sends everything afresh, and once a hunt's pair is ready any copy it didn't send is retired, so a puzzle deleted while the feed was away still loses its card.

On the Jolly Roger side the account needs to exist (an ordinary user with an email and password; make it with the admin's user management or `Accounts.createUserAsync`), and to be a member of every hunt that gets a board: the publications answer nothing to a non-member, so the adapter that asks for a hunt's board must add the service user to that hunt first. Making the account an admin lets `includeDeleted` through, so a deleted puzzle's `replacedBy` reaches the service and its card goes to the replacement rather than being hidden; without it the puzzle simply stops being published, which hides the card.

## Connecting a client

Open a websocket to `<PUBLIC_URL>/ws` and send `hello { token, hideInk? }` as the first frame, with the token from the iframe's `?token=`. Frames are EJSON (`lib/compat/ejson`), one object per frame, each with a `t`. The reply is `welcome { user, name, mayEdit, access, operator, board, connection, snapshot, jrUrl, imagesEnabled, flags }`, where `snapshot` has the board document, `nodes`, `edges`, `versions`, `comments` and, on a hunt board, `puzzles` and `tags`; `jrUrl` is Jolly Roger's origin for links out of the board, `imagesEnabled` says whether images can be added (not yet), and `flags` names the feature flags that are on. After that: `call { id, name, args }` is answered `result { id, value }` or `error { id, code, reason }`; `live { cursor, drag, stroke, selection?, editing?, editingAt?, view?, followedUser? }` reaches everyone else as `live { connection, user, name, ... }`; every write to the board arrives as `change { collection, id, doc | null }`; `presence { users }` comes on each join and leave; answer the server's `ping` with `pong`. Send `hello` again with a fresh token before the old one is a minute past its `exp`. The built client asks the page framing it for one a minute before `exp` with `postMessage({ t: "token" }, jrUrl)`, and takes a reply `{ t: "token", token }` from that origin; with no reply it shows "Reload to continue" once the server closes the socket. Close codes: 4400 bad message, 4401 bad or expired token, 4403 not allowed, 4404 no board, 4408 no pong, 4503 whiteboard off, 1009 frame too big. The schemas and message types are in `lib/protocol.ts`.

## Commands

```
bun install
bun run check      # tsc --noEmit, biome check
bun run format     # biome check --write
bun test
```

The runtime checks (`bun run check:mongo`, `check:ws`, `checks/crypto.ts`) need a Mongo on `MONGO_URL` too.

The feed's tests run against a real Jolly Roger and are skipped unless `JR_TEST_URL` is set. Start the source checkout's app on a spare port (`meteor --port 3800` in the Jolly Roger checkout; its dev Mongo listens one port up, database `meteor`), wait for it to serve, then:

```
JR_TEST_URL=http://localhost:3800 bun test tests/server/feed.test.ts
```

The test seeds that Mongo itself (`JR_TEST_MONGO_URL`, default `mongodb://127.0.0.1:<port + 1>/meteor`) with a service account holding a resume token, a hunt, tags and puzzles, and removes them afterwards.
