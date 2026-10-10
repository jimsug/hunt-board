# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

## Layout

- `lib/` is shared pure code: the board logic under `lib/whiteboard/`, the models under `lib/models/`, the typed-model shim over the Mongo driver under `lib/typedModel/`, the replacements for the Meteor packages the code used under `lib/compat/`, who may do what from a token's claims in `lib/access.ts`, and the call schemas in `lib/protocol.ts`. `lib/db.ts` holds the connection.
- `server/` is the whiteboard server: placement and boards (`whiteboard.ts`), edits, versions, resets, the edit policy, comments, in-memory presence (`live.ts`), the call dispatcher (`methods.ts`) and the change seam (`changes.ts`); on top of that the process itself: the token (`token.ts`), the rooms that forward changes to sockets (`rooms.ts`), the websocket handler (`ws.ts`), the HTTP API and static client (`http.ts`), `startService` (`app.ts`), the configuration (`config.ts`) and the entry point (`main.ts`). `server/feed/` is the feed from Jolly Roger: a DDP client (`ddp.ts`), the hunt subscriptions that mirror puzzles and tags into the copies and hand changes to placement (`hunts.ts`), and `startFeed` (`index.ts`).
- `client/` is the board in the browser: Jolly Roger's whiteboard canvas under `client/components/` and `client/hooks/`, the in-memory store that stands in for Minimongo (`client/store/`), the websocket session (`client/session.ts`), the call objects (`client/methods.ts`), the page (`client/WhiteboardPage.tsx`) and the entry (`client/main.tsx`). Vite builds it from `index.html` into `dist/`.
- `tests/` holds the `bun test` suites. `tests/lib/typedModel.test.ts` and everything under `tests/server/` and `tests/client/session.test.ts` need a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`), whose contents they empty between tests. The http, ws, rooms and session suites start the service on a free port. `tests/server/feed.test.ts` also needs a running Jolly Roger (see below) and is skipped without one.
- `tests/acceptance/` is the browser suite: Jolly Roger's whiteboard acceptance tests (`whiteboard.tsx`) running inside Chromium against the built client and a real service, with mocha, chai and Testing Library in the page (`index.html`, `runner.ts`), the service-side helpers the tests use (`harness.tsx`), the service started in test mode (`serve.ts`) and the Playwright driver under Node (`run.ts`). See "Acceptance tests" below.
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
- `TEST_MODE=1` turns on the `/test/*` endpoints the acceptance harness drives (see below). Never set it on a deployment: `/test/reset` empties the database and `/test/token` mints a token for anyone. The service refuses to start with it under `NODE_ENV=production`.

## Running

```
bun run build      # the client, into dist/
bun run start      # the service
bun run dev        # the same, restarting on changes
bun run dev:client # Vite on :5173, proxying /ws and /boards to the service
```

The process serves the HTTP API (`POST /boards`, `DELETE /boards/:id`, `GET /boards/:id/activity` with `Authorization: Bearer <JR_SHARED_SECRET>`; `GET /healthz` open), the websocket on `/ws`, and the built client from `dist/` at `/` and `/boards/:id` (a placeholder page until the client is built). It also thins board history (`pruneWhiteboardVersions`) a minute after start and hourly after that. The page is sent with `Content-Security-Policy: frame-ancestors <JR_URL>`.

To look at a board without Jolly Roger: start the service, then `JR_SHARED_SECRET=... bun run scripts/seed-dev.ts` writes the fixture hunt's puzzles and tags, asks for its board and prints two links with tokens (an operator and a member, good for five minutes).

## The feed

The service keeps its own copies of Jolly Roger's puzzles and tags (`jr_puzzles` and `jr_tags`, the fields the board reads) and fills them over DDP: it logs in to `<JR_URL>/websocket` as the service account and, for every hunt that has a board, subscribes to `Puzzles.publications.forHunt` (`{ huntId, includeDeleted: true }`) and `Puzzles.publications.forPuzzleList` (`{ huntId }`, which is where the tags come from; Jolly Roger has no tags-only publication). A hunt gains its pair when its board is created (`POST /boards`) and loses it, and its copies, when the board is deleted. Documents are mirrored as they arrive; the puzzles a burst of changes touches (a changed tag's are the puzzles carrying it) go to the board's deferred placement, so cards, frames and feeder arrows follow Jolly Roger as its own hooks made them. A dropped connection reconnects with backoff (1 s doubling to 30 s), logs in again and resubscribes; the server sends everything afresh (a document the copy already holds as sent isn't written again, so the boards hear nothing of it), and once a hunt's pair is ready any copy it didn't send is retired, so a puzzle deleted while the feed was away still loses its card.

On the Jolly Roger side the account needs to exist (an ordinary user with an email and password; make it with the admin's user management or `Accounts.createUserAsync`), and to be a member of every hunt that gets a board: the publications answer nothing to a non-member, so the adapter that asks for a hunt's board must add the service user to that hunt first. It must stay an ordinary member, never an admin: its credentials sit in the service's environment, and an admin's would be worth every hunt. The cost is that `includeDeleted` is honoured for admins only, so a deleted puzzle's `replacedBy` never reaches the service; the puzzle simply stops being published and its card is hidden rather than handed over to the replacement.

## Connecting a client

Open a websocket to `<PUBLIC_URL>/ws` and send `hello { token, hideInk? }` as the first frame, with the token from the iframe's `?token=`. Frames are EJSON (`lib/compat/ejson`), one object per frame, each with a `t`. The reply is `welcome { user, name, mayEdit, access, operator, assignedOperator, board, connection, snapshot, jrUrl, imagesEnabled, flags }`, where `snapshot` has the board document, `nodes`, `edges`, `versions`, `comments` and, on a hunt board, `puzzles` and `tags`; `jrUrl` is Jolly Roger's origin for links out of the board, `imagesEnabled` says whether images can be added (not yet), and `flags` names the feature flags that are on. After that: `call { id, name, args }` is answered `result { id, value }` or `error { id, code, reason }`; `live { cursor, drag, stroke, selection?, editing?, editingAt?, view?, followedUser? }` reaches everyone else as `live { connection, user, name, ... }`; every write to the board arrives as `change { collection, id, doc | null }`; `presence { users }` comes on each join and leave; answer the server's `ping` with `pong`. Send `hello` again with a fresh token before the old one is a minute past its `exp`; a `hello` that changes `hideInk` gets `welcome` with the snapshot again. The built client asks the page framing it for one a minute before `exp` with `postMessage({ t: "token" }, jrUrl)`, and takes a reply `{ t: "token", token }` from that origin; with no reply it shows "Reload to continue" once the server closes the socket. Close codes: 4400 bad message, 4401 bad or expired token, 4403 not allowed, 4404 no board, 4408 no pong, 4429 too many (a person's seventeenth socket on a board, or a snapshot past their sixty big reads a minute; a renewal that changes `hideInk` past that gets `welcome` without the snapshot and an `error` with `id: null` instead), 4503 whiteboard off, 1009 frame too big. The schemas and message types are in `lib/protocol.ts`.

## Commands

```
bun install
bun run check      # tsc --noEmit, biome check
bun run format     # biome check --write
bun test
```

The runtime checks (`bun run check:mongo`, `check:ws`, `checks/crypto.ts`) need a Mongo on `MONGO_URL` too.

## Acceptance tests

```
bun run test:acceptance                      # build the test bundle, then run it
bun run build:acceptance                     # just the bundle, into dist-acceptance/
node tests/acceptance/run.ts --grep <pattern> # some of the tests (mocha's grep)
node tests/acceptance/run.ts --headed         # watch, and keep the browser open after
```

`run.ts` needs Node (22 or later; it strips the types itself) and the `playwright` package with its Chromium (`bunx playwright install chromium` once). It starts the service with `bun run tests/acceptance/serve.ts`: test mode on, no feed, the scratch Mongo's `huntboard-acceptance` database (`MONGO_URL` overrides it), serving `dist-acceptance/` on a free port. It then opens the runner page in headless Chromium, prints each test as the page reports it (`[pass]`, `[fail]` with the error and a DOM dump, `[skip]`), and exits non-zero when any failed. A failed test also gets a `[board]` line (where the board was looking, how many nodes were drawn and stored, what's in localStorage) and a screenshot under `dist-acceptance/failures/`, numbered in order, taken before Testing Library's cleanup takes the board down. The page's own console goes through too, prefixed by its level. A whole run takes a while: the slow tests are given up to a minute each, and the run an hour.

In the page the tests are Jolly Roger's `tests/acceptance/whiteboard.tsx` with the helpers at the top rewritten for this data layer: the board page is rendered with a `Session` and the store, calls go through `client/methods.ts`, a second person is a second session on another token, and what Jolly Roger's own methods did (archiving the hunt, a puzzle's tags and answers, deleting a puzzle) goes through the test mode's endpoints. `PORTING.md` lists the tests that were dropped and why.

The test mode's endpoints, all `POST`, JSON in and out, and all 404 without `TEST_MODE=1`:

- `/test/reset`: empties the database, seeds the fixture hunt's puzzles and tags, makes its board, and answers `{ boardId, huntId }`. Open sockets are closed first, and everyone's big-read bucket is full again.
- `/test/token`: `{ user, name?, operator?, assignedOperator?, mayEdit?, scope? }` to `{ token }`, a five-minute token signed with the shared secret (the browser never holds the secret).
- `/test/fixture`: `{ op: "puzzle", puzzleId?, title?, tags?, addTags?, removeTags?, answers?, expectedAnswerCount?, deleted?, replacedBy?, sync? }` writes a puzzle copy (tags by name, made as needed) and hands it to placement as the feed would, unless `sync` is false; `{ op: "fillInk", boardId, spare }` adds one ink node that leaves the board `spare` points short of its ink budget; `{ op: "clearVersions", boardId }` starts a board's history afresh; `{ op: "imageBucket", on }` sets or clears the image bucket in the process's environment.

The feed's tests run against a real Jolly Roger and are skipped unless `JR_TEST_URL` is set. Start the source checkout's app on a spare port (`meteor --port 3800` in the Jolly Roger checkout; its dev Mongo listens one port up, database `meteor`), wait for it to serve, then:

```
JR_TEST_URL=http://localhost:3800 bun test tests/server/feed.test.ts
```

The test seeds that Mongo itself (`JR_TEST_MONGO_URL`, default `mongodb://127.0.0.1:<port + 1>/meteor`) with a service account holding a resume token, a hunt, tags and puzzles, and removes them afterwards.
