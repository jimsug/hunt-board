# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

## Layout

- `lib/` is shared pure code: the board logic under `lib/whiteboard/`, the models under `lib/models/`, the typed-model shim over the Mongo driver under `lib/typedModel/`, the replacements for the Meteor packages the code used under `lib/compat/`, who may do what from a token's claims in `lib/access.ts`, and the call schemas in `lib/protocol.ts`. `lib/db.ts` holds the connection.
- `server/` is the whiteboard server: placement and boards (`whiteboard.ts`), edits, versions, resets, the edit policy, comments, in-memory presence (`live.ts`), the call dispatcher (`methods.ts`) and the change seam (`changes.ts`); on top of that the process itself: the token (`token.ts`), the rooms that forward changes to sockets (`rooms.ts`), the websocket handler (`ws.ts`), the HTTP API and static client (`http.ts`), `startService` (`app.ts`), the configuration (`config.ts`) and the entry point (`main.ts`). No feed yet.
- `client/` is the board in the browser: Jolly Roger's whiteboard canvas under `client/components/` and `client/hooks/`, the in-memory store that stands in for Minimongo (`client/store/`), the websocket session (`client/session.ts`), the call objects (`client/methods.ts`), the page (`client/WhiteboardPage.tsx`) and the entry (`client/main.tsx`). Vite builds it from `index.html` into `dist/`.
- `tests/` holds the `bun test` suites. `tests/lib/typedModel.test.ts` and everything under `tests/server/` and `tests/client/session.test.ts` need a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`), whose contents they empty between tests. The http, ws, rooms and session suites start the service on a free port.
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
