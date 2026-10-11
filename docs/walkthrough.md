# A walkthrough of the code

For someone who will run, change and defend this service. Read it with the code open; every section names the files it talks about. The README says how to run and configure; PORTING.md says what changed from the Jolly Roger whiteboard it came from and why; this says how it fits together.

## Two trees, one contract

The board lives in two places:

- **This repository, the service.** One Bun process that serves the board page, talks to every viewer over a websocket, keeps boards in its own MongoDB, and reads a hunt's puzzles from Jolly Roger.
- **Jolly Roger, the adapter.** A handful of files that let Jolly Roger create a board, embed it in an iframe, and vouch for the viewer with a signed token. They know nothing about nodes, lines or versions.

The contract between them is small and it's all in `lib/protocol.ts` and `server/token.ts`: a token format, three HTTP endpoints, and a websocket protocol. Everything else is private to one side.

## Five walks through the running system

### 1. A viewer opens a board

1. Jolly Roger's board page (`imports/client/components/BoardPage.tsx` in the adapter) calls `Hunts.methods.boardToken`, which signs five minutes of claims (`imports/server/board.ts` `signBoardToken`): scope, user id, display name, whether they may edit, whether they're an operator, whether they're an assigned operator. The page puts an iframe on screen pointing at the service's URL for the board with `?token=` on it (`DocumentDisplay.tsx`, the `board` case).
2. The service answers `GET /boards/:id` with the built client (`server/http.ts` `createHttpHandler`, static files from `dist/`, a `Content-Security-Policy: frame-ancestors` naming Jolly Roger's origin and nothing else).
3. The client (`client/main.tsx`) reads the token off the URL, strips it from the address bar, and opens a `Session` (`client/session.ts`) to `/ws`. Its first frame is `hello { token }`.
4. `server/ws.ts` verifies the token (`server/token.ts` `verifyToken`: signature first, timing-safe; then version, shape, expiry with a minute of skew), finds the board for the token's scope, and joins the socket to the board's room (`server/rooms.ts` `joinRoom`). Joining costs a read of the whole board, so it's charged to the viewer's big-read bucket, and a viewer may hold at most sixteen sockets on one board.
5. The room answers `welcome`, carrying who the viewer is, what access the policy gives them right now, and a `snapshot`: the board document, nodes, edges, versions, comments, and for a hunt board the puzzle and tag copies. A viewer who asked to hide ink gets ink nodes as outlines without points.
6. The client's store (`client/store/`) loads the snapshot into reactive collections, and `WhiteboardPage.tsx` renders the canvas (`client/components/whiteboard/WhiteboardCanvas.tsx` and its hooks).

From then on the socket carries three kinds of traffic, and the next three walks follow one each.

### 2. Someone moves a note

1. The canvas handles the drag; on drop, `useWhiteboardSync.ts` and `boardWrites.ts` turn it into a write: `commit()` in the canvas records it for undo (`lib/whiteboard/undo.ts`, `useWhiteboardUndo.ts`), marks the node pending so the local position holds until the server echoes it, and sends `call { id, name: "upsertNodes", args }` through the session.
2. `server/ws.ts` hands the call to `server/methods.ts` `callMethod`, which validates the arguments against the method's Zod schema in `lib/protocol.ts` (the names are the Jolly Roger methods without `boardId`; the socket's board is implied), wraps the call in the viewer's user context, and dispatches.
3. `server/whiteboardEdits.ts` `upsertNodes` is the port's function. It checks access before the lock (`server/whiteboardShared.ts` `assertMayEditBoard`, reading the token's claims and the board's policy through `lib/access.ts`), validates every field and cap, takes the board's lock (`server/whiteboardVersions.ts` `withBoardLock`, built on `server/withLock.ts`), checks access again under it, records a version if one is due (`recordVersionUnderLock`), and writes.
4. Every write goes through a model (`lib/typedModel/Model.ts`, a shim over the Mongo driver that validates against the Zod schemas in `lib/models/`), and every model write ends in `server/changes.ts` `notify(collection, id, doc)`.
5. The room listens to `notify` and forwards a `change { collection, id, doc }` to every socket on that board (`server/rooms.ts` `forward`), ink only to sockets that want it. The caller also gets `result { id }`.
6. Each client's store applies the change; the pending mark clears when the echo matches; `useTracker` re-runs the components that read that node.

The same path serves every edit: lines, ink segments, deletes, the edit policy, locks, comments (`server/comments.ts`), reset (`server/whiteboardReset.ts`), restore (`server/whiteboardVersions.ts` `restoreVersion`, `restoreItems`).

### 3. Someone moves a pointer

1. `useWhiteboardLive.ts` sends `live { cursor, drag, stroke, ... }` every 100 ms while something changed.
2. `server/ws.ts` hands it to `server/rooms.ts` `liveUpdate` and `server/live.ts` `applyLive`: validated, rate-limited per connection and per user, and held in memory for the room. Nothing is stored.
3. The room rebroadcasts it as `live { connection, user, name, ... }` to everyone else on the board. `CursorLayer.tsx` draws it, gliding each hop over the measured gap since the previous one so a cursor never stops between updates; `RemoteSelectionLayer.tsx`, `useRemoteDrags.ts` and the ink layer do the same for selection, drags and strokes.
4. `presence { users }` goes out on each join and leave; `WhosHere.tsx` shows it and runs follow mode (`lib/whiteboard/follow.ts`).

### 4. A puzzle appears in Jolly Roger

1. `server/feed/index.ts` starts one DDP client (`server/feed/ddp.ts`, 430 lines, no dependency) that logs in to Jolly Roger as the service account and reconnects with backoff.
2. `server/feed/hunts.ts` keeps a subscription pair per hunt that has a board: Jolly Roger's `Puzzles.publications.forHunt` and `forPuzzleList` (tags come with the second). It watches `Whiteboards` through the change seam to learn when a hunt gains or loses its board.
3. Documents arriving as `added`, `changed` and `removed` are mirrored into the `Puzzles` and `Tags` copies (`lib/models/Puzzles.ts`, `Tags.ts`, which keep only the fields the layout reads). A write that changes nothing is skipped, so a reconnect doesn't fan out the whole hunt.
4. Changed puzzle ids are handed to placement, `server/whiteboard.ts` `deferSyncPuzzlesOnBoard`, which under the board's lock places new cards in their round's frame, moves cards whose tags changed (unless someone has moved them by hand), hides the cards of deleted puzzles, and redraws feeder arrows (`syncAutoEdges`). The layout rules themselves are pure: `lib/whiteboard/layout.ts`, `rounds.ts`, `feeders.ts`.
5. Those writes notify, the room forwards, and every open board shows the new card.

On every connect the feed resends everything and reconciles: copies the server no longer sends are soft-deleted. The service account is an ordinary member of every hunt; it reads what a member reads and writes nothing to Jolly Roger.

### 5. Someone restores a version

1. History (`HistoryPanel.tsx`, `useVersionPreview.ts`) lists versions from the snapshot; picking one calls `fetchVersion` for its chunks, which the client decompresses and shows as a preview with the differences marked.
2. "Restore this version" calls `restoreVersion`. Under the lock (`withVersionLocked`), the server records the current board as a version first, plans the restore with pure code in `lib/whiteboard/versions.ts` (matching cards by puzzle, frames by tag, lines by their ends; giving fresh ids to anything a later edit already took), checks caps and locks, and writes the plan, rolling forward if it fails part-way. Comments pinned to replaced nodes are re-attached (`server/whiteboardComments.ts`).
3. Versions are gzipped EJSON snapshots in chunks (`WhiteboardVersions`, `WhiteboardVersionChunks`), coalesced per person per ten minutes, kept in full for two hours then thinned, capped per board, and pruned hourly by a timer in `server/app.ts`.

## The map, by layer

**`lib/`, shared by client and server, no I/O.** `lib/whiteboard/` is the rules: `layout.ts` seeds a board from a hunt's rounds; `reset.ts` plans a reset onto an existing board; `versions.ts` plans restores; `clipboard.ts` copies and pastes; `arrange.ts` aligns, distributes and walks parent chains; `frameTools.ts` fits and grows frames; `ink.ts` simplifies and segments strokes; `collapse.ts`, `rounds.ts`, `outline.ts`, `search.ts`, `feeders.ts`, `follow.ts`, `undo.ts`, `links.ts`, `limits.ts` (every cap in one file). These are byte-identical to Jolly Roger's and tested by `tests/lib/`. `lib/models/` holds the Zod schemas; `lib/typedModel/` the Mongo shim; `lib/compat/` the three Meteor stand-ins (ids, EJSON, errors); `lib/protocol.ts` the wire; `lib/access.ts` who may do what.

**`server/`.** Entry `main.ts` to `app.ts` (`startService`: connect, indexes, `Bun.serve`, the feed, the prune timer, shutdown). The edge: `http.ts`, `ws.ts`, `token.ts`, `config.ts`. The room layer: `rooms.ts`, `live.ts`, `changes.ts`. The port's logic: `whiteboard.ts` (placement), `whiteboardEdits.ts`, `whiteboardVersions.ts`, `whiteboardReset.ts`, `whiteboardPolicy.ts`, `comments.ts`, `whiteboardShared.ts` (guards), `withLock.ts`, `rateLimits.ts`. The feed: `feed/`. Test-only: `testMode.ts`, mounted only with `TEST_MODE=1` and refused under `NODE_ENV=production`.

**`client/`.** `main.tsx` and `WhiteboardPage.tsx`; `session.ts` (the socket, calls, renewal); `store/` (collections, `useTracker`, the current user); `methods.ts` (call objects shaped like Jolly Roger's); `compat/` and `shims/` so the ported files import the same names; `hooks/` (the canvas's concerns, one each: geometry, keys, ink, lines, touch, clipboard, comments, history, navigation, sync, live, undo); `components/whiteboard/` (the canvas, nodes, panels, layers).

**`tests/`.** `lib/` and `server/` under `bun test` against a scratch Mongo; `client/` under happy-dom; `acceptance/` runs the port's browser tests inside Chromium against the real service (`run.ts` drives it with Playwright).

## Invariants worth knowing before changing anything

- **Access is decided per call, from claims and the board document, never cached.** `loadBoardAccess` reads both each time; a policy change takes effect on the next call and the room closes sockets whose access becomes none.
- **Every write that can race takes the board lock, and re-checks access under it.** Pre-lock checks keep non-editors from ever holding the lock; in-lock checks are the ones that count.
- **Every model write notifies; rooms only forward.** If something doesn't update on screen, it's either not written through a model or the room's routing (`doc.board`, `doc.hunt`) doesn't match.
- **Presence is never stored.** Rooms hold it; a restart forgets it; that's intended.
- **Caps live in `lib/whiteboard/limits.ts` and are enforced server-side** regardless of what the client does. The client reads the same file to disable controls early.
- **The service writes nothing to Jolly Roger.** The feed's account is used for `login` and two subscriptions; the DDP client can call methods, which is the blast radius if the host is compromised.
- **Ids are Meteor-style everywhere** (`lib/typedModel/regexes.ts`), including the user, hunt and puzzle ids in a token; anything else is refused at hello.

## The adapter, file by file

In Jolly Roger, all behind the `disable.board` flag:

- `imports/lib/models/Documents.ts`: the `board` provider, `puzzle` optional.
- `imports/lib/models/Settings.ts`, `imports/server/methods/configureBoardService.ts`, `rotateBoardServiceCredentials.ts`, `imports/server/boardServiceAccount.ts`: the setting (url, secret, service account id); saving it mints the account, shows its login once, and puts it in every hunt; `createHunt.ts` adds new hunts; the settings publications never publish the secret; `users.ts` keeps the account out of profile lists.
- `imports/server/board.ts`, `methods/ensureBoard.ts`, `deleteBoard.ts`: create and delete through the service's HTTP API, gated by `userMayWritePuzzlesForHunt`; `methods/boardToken.ts`: the signed claims for members.
- `imports/client/components/BoardPage.tsx`, `DocumentDisplay.tsx`, `HuntNav.tsx`, `Routes.tsx`: the route, the nav link, the iframe, the token renewal answer (the iframe posts `{ t: "token" }`; the page answers only the service's origin, with a fresh token).
- `docs/board-provider.md`: the operator's guide.

## When something is wrong

- **Board page blank, console shows a close code:** 4401 is a bad or expired token (clock skew or secret mismatch between the Setup page and `JR_SHARED_SECRET`); 4404 no board for the scope; 4403 access none (archived hunt and a stale token); 4429 too many sockets or snapshots; 4503 the whiteboard flag is on.
- **Hunt board empty:** the feed. `journalctl -u hunt-board` shows the login and each hunt's `loaded` line with counts. Zero puzzles with no error means the account isn't in that hunt; a Setup page save re-adds it everywhere.
- **Edits refused:** the `error` frame's reason is the server's message, the same strings the tests match on; look in `whiteboardEdits.ts` for it.
- **Something updates for one person and not another:** `rooms.ts` routing or `hideInk`.
- **Slow with many people:** `docs/load.md` has the baseline (fifty viewers, p99 7 ms); `scripts/load.ts` reproduces it.

## What the tests prove

- `tests/lib/*`: the rules give the same answers as Jolly Roger's did (same tests, same assertions).
- `tests/server/whiteboard-*`: every guard, cap, lock and version rule, against a real Mongo, calling the functions with claims.
- `tests/server/{token,http,ws,rooms,config,testMode}`: the edge and the room layer, with real sockets on port 0.
- `tests/server/{ddp,hunt-feeds,feed}`: the DDP client against a fake socket; the feed against a real Jolly Roger when `JR_TEST_URL` is set.
- `tests/acceptance/whiteboard.tsx`: 186 of the port's browser tests, unchanged in substance, against the built client.
