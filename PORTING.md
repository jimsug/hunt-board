# Porting notes

What was changed on the way across from Jolly Roger (the `main-rebase-concise`
branch's `imports/lib` and `imports/server`), so that a later sync from there
is a diff, not a rewrite. Anything not listed here is byte-identical to its
source.

## Tooling

- `biome.jsonc` is the source's with the Meteor import group dropped, `:BUN:`
  and `lib/**` groups added, the schema bumped to the installed version, and
  `checks/` left out (the probes stay as written). `tsconfig.json` keeps the
  source's strictness, targets ES2023 (the lib uses `toSorted`), and maps
  `lib/*` so tests can import `lib/whiteboard/...`.
- `bun test` looks under `tests/` (`bunfig.toml`).

## `lib/compat/`: the Meteor packages

- `random.ts`: `Random.id()` with Meteor's alphabet, from `crypto`.
- `ejson.ts`: `EJSON.stringify`/`parse`/`equals`/`clone`/`toJSONValue`/
  `fromJSONValue`/`isBinary`, in Meteor's wire format for Date, Uint8Array,
  non-finite numbers and `$escape`. Custom types and RegExp aren't supported.
- `error.ts`: `ServiceError(error, reason, details?)` with Meteor.Error's
  `error`/`reason`/`details` fields and message format.

## `lib/typedModel/`: the shim

- `Model.ts` is rewritten over the driver. The public surface the board code
  uses is unchanged: `new Model(name, schema)`, `addIndex`, `insertAsync`,
  `insertManyAsync`, `updateAsync` (`{ multi, upsert, arrayFilters }`),
  `upsertAsync`, `removeAsync`, `findOneAsync`, `find(selector, { projection,
  sort, limit, skip })` returning a `TypedCursor` with `fetchAsync`,
  `mapAsync`, `forEachAsync`, `countAsync` and async iteration, plus
  `setClock`/`resetClock` and `AllModels`.
  - Gone: the sync `findOne`, the `collection` property (`rawCollection()` is
    on the model itself, so `X.collection.rawCollection()` becomes
    `X.rawCollection()`), `formatValidationError` and the Meteor write-fence
    bookkeeping in `insertManyAsync`.
  - Validation is done by the model, not a Mongo `$jsonSchema` validator.
    Inserts and replacement documents are parsed in full (`validateWrite.ts`;
    unknown top-level keys are refused, Zod defaults are applied). Updates
    check each `$set`/`$setOnInsert` value, dotted paths included, against
    the field it names, and `$push`/`$addToSet` values against the array's
    element; `$unset`, `$inc`, `$pull` and the rest aren't checked. A failed
    check throws `ModelValidationError`.
  - `createdBy`/`updatedBy` come from `userContext.ts`: the server wraps a
    request in `withUser(userId, fn)` where Meteor had the method invocation.
    Outside it no user is stamped, and a schema that requires one refuses the
    write.
  - An upsert whose selector doesn't pin `_id` gets a `Random.id()` through
    `$setOnInsert` (Mongo would assign an ObjectId; Meteor generated one).
  - `updateAsync` returns the number of documents matched (plus one for an
    upsert's insert), which is what the lost-race checks in the server rely on.
  - `Selector<T>` and `Modifier<T>` are the driver's `Filter<T>` and
    `UpdateFilter<T> | Partial<T>` in place of `Mongo.Selector`/`Mongo.Modifier`.
- `SoftDeletedModel.ts`: the sync `findOne`, `findOneAllowingDeleted` and
  `findOneDeleted` are gone (their `...Async` forms stay); types come from the
  shim instead of `meteor/mongo`.
- `validateSchema.ts`: the zod-to-mongo-schema compatibility check is dropped
  (no Mongo-side validator to generate); the empty-string and known-type rules
  stay.
- `autoPopulate.ts`: the `GlobalMeta` augmentation declares `bsonType` and
  `uniqueItems` itself rather than extending zod-to-mongo-schema's type.
- `indexes.ts`: driver types imported from `mongodb` instead of
  `meteor/npm-mongo`.
- `ensureIndexes.ts` is `imports/server/indexes.ts` as a function the server
  calls after `connect()`, taking the models to cover (default `AllModels`)
  and a logger (default `console`) in place of `runIfLatestBuild` and
  `Logger`.
- `cursor.ts` and `userContext.ts` are new.
- `lib/db.ts` is new: `connect(url)`, `db()`, `disconnect()`. The client is
  opened with `ignoreUndefined: true`, as Meteor's is, so an undefined field
  is left out rather than written as null.
- `customTypes.ts`, `regexes.ts`, `withCommon.ts`, `withTimestamps.ts` and
  `withUsers.ts` are unchanged.

## `lib/models/`

- `Whiteboards.ts`, `WhiteboardNodes.ts`, `WhiteboardEdges.ts` and
  `WhiteboardVersions.ts` are unchanged.
- `Puzzles.ts` and `Tags.ts` are cut down to the fields the board code and its
  tests read (same names as Jolly Roger's, which will feed them over DDP).
  Puzzles loses the note, lock summary and `url` index; Tags is as it was.
- `BoardComments.ts` replaces `ChatMessages.ts`: a board's comments, replies
  and reactions as their own collection (`board_comments`) keyed by `board`
  rather than `puzzle`. The fields keep chat's names (`content`, `sender`,
  `timestamp`, `parentId`, `comment`, `thread`, `editedAt`, `deletedAt`) so
  the comment code reads the same; `content` keeps text, mention and puzzle
  blocks but not image or role-mention blocks, and `pinTs` is gone. A reaction
  is still a message whose only content is an emoji (`lib/isReaction.ts`).
  `sender` stays optional only so the lib and its tests are unchanged; the
  server always sets it.

## `lib/whiteboard/` and helpers

- `versions.ts`: `EJSON` from `../compat/ejson` instead of `meteor/ejson`.
- `comments.ts`: `BoardCommentType`/`BoardCommentAnchorType` from
  `../models/BoardComments` instead of the ChatMessage types.
- `isReaction.ts` and `nodeIsText.ts`: retargeted at the BoardComments types.
- `tagNames.ts`, `listUtils.ts`, `solvedness.ts`, `puzzle-sort-and-group.ts`
  and every other file under `lib/whiteboard/` are unchanged.
  `calendarTimeFormat.ts` wasn't needed.

## Tests

- `tests/lib/whiteboard-*.test.ts` are the source's
  `tests/unit/imports/lib/whiteboard-*.ts` with `describe`/`it` imported from
  `bun:test`, imports pointed at `lib/...`, and the comments test using
  `BoardCommentType`. The clipboard test's `sinon.spy(JSON, "parse")` is
  `spyOn` from `bun:test` (`mock.calls` and `mockRestore()` in place of
  `called` and `restore()`). No other mocha-only features were in use.
- `tests/lib/typedModel.test.ts` and `tests/lib/compat.test.ts` are new.

## `lib/access.ts` and `lib/protocol.ts`: access and call shapes

- `lib/access.ts` is new: `Claims` (the token's `{ v, scope, user, name,
  mayEdit, exp, operator?, assignedOperator? }`), `boardAccess(claims,
  board)` returning edit, comment, view or none, `scopeMatches`,
  `isOperator`, `isAssignedOperator` and `SERVICE_USER`, the id the service
  writes under when no person asked (seeding a board). It stands in for
  `whiteboardAccess(user, hunt, board)`: a scope that doesn't match the
  board is "none", `mayEdit: false` (Jolly Roger's archived hunt) is
  "view", and the edit policy decides the rest. "Operator" is
  `claims.operator === true`, for the policies that single operators out;
  "assigned operator" is `claims.assignedOperator === true`, Jolly Roger's
  `userMayMakeOperatorForHunt` (an operator by assignment rather than the
  hunt's default role), which alone may change who edits
  (`setEditPolicy`) or lock the layout (`setLayoutLocked`). A token with
  `operator` alone edits under an operators-only policy but can't set one.
- `lib/protocol.ts` is new: one Zod schema per call, mirroring the methods'
  `check()` patterns (`z.strictObject`, so an unknown key is refused as
  `check` refused it) without the `boardId`, which is the socket's. The
  `WhiteboardNodeInput`, `WhiteboardEdgeInput` and `CommentAnchorInput`
  types come from it. `comment.react` is `{ messageId, emoji, on }` in place
  of a reaction message and `removeChatReaction`, its `emoji` capped at
  `MAX_REACTION_LENGTH`; `comment.post` and `comment.edit` cap `text` at
  `MAX_COMMENT_LENGTH` (both counted in UTF-16 code units, as `.length`
  does, where Zod's own `max` counts code points). `ClaimsSchema` is the
  token's shape.

## `lib/models/Whiteboards.ts`

- `puzzle` is the board's scope (a puzzle's board) and optional, no longer
  the backing chat puzzle, which is gone. `archived` is new, set by Jolly
  Roger so history thins sooner; access never reads it. The unique index is
  `{ hunt, puzzle }` (one board per scope) in place of `{ hunt }` unique
  plus `{ puzzle }`.
- `lib/db.ts` opens the client with `promoteBuffers: true` as well: the
  driver's `Binary` would trip `Buffer.concat` on a version's chunks, where
  Meteor handed back a `Uint8Array`.

## `server/`: the whiteboard server

Ported from `imports/server/`, with the same file names. Every function
that took a `userId` takes the caller's `Claims` instead, and the guards in
`whiteboardShared.ts` read them in place of users and hunts.
`assertMayEditBoard` and `assertMayCommentOnBoard` take a board id only (the
`{ puzzle }` selector served chat, which is board-keyed now) and keep the
same error codes and reasons. Every write path keeps its pre-lock and
in-lock guard pairs as the source has them.

- `whiteboard.ts`: `ensureBoard(scope, createdBy = SERVICE_USER)` replaces
  `ensureWhiteboard(userId, huntId)`. Jolly Roger asks for a board over
  HTTP, so there's no hunt, archived or operator check and no backing
  puzzle; a puzzle's board starts empty; the create lock is
  `whiteboard:create:<hunt>:<puzzle>`. `deleteBoard(boardId)` is new (the
  purge job's work). Placement finds the hunt's board with
  `huntBoardSelector` (`puzzle: { $exists: false }`). `ungroupedLabel()` is
  the constant "Ungrouped" (no i18n). `deferSyncPuzzlesOnBoard` and
  `deferSyncRoundsOnBoard` use `setImmediate` for `Meteor.defer` and count
  their passes, so `deferredSyncsDone()` can wait for them (tests, and
  shutdown). `boardForMember` is `boardForClaims` in `whiteboardShared.ts`,
  for the room's snapshot.
- `whiteboardComments.ts`: `detachComments` and `reattachComments` take the
  board id rather than the chat puzzle, as do the `BoardComments` queries;
  `moveOntoCard` in `whiteboard.ts` likewise.
- `comments.ts` is new: the comment methods, on `BoardComments`.
  `assertValidCommentAnchor`, `assertMayReplyInThread`, `setCommentResolved`
  and the thread delete (`deleteThread`) move here from
  `whiteboardEdits.ts`; `postComment` is `sendChatMessage` plus
  `sendChatMessageInternal` (a reply at any depth belongs to its thread, a
  reaction lands once per emoji per person under a lock, a reply reopens a
  resolved thread) with the pin, dingword and image handling gone;
  `editComment`, `deleteReply` (emptied in place, reactions removed) and
  `react` (on or off) are `editChatMessage`, `deleteChatMessage` and
  `removeChatReaction` without hunt membership (the token covers it).
  `deleteComment` picks the thread delete for a root and the reply delete
  otherwise. A post needs a pin or a parent (there's no plain chat) and
  text that isn't blank; a parent elsewhere is refused as "is not on board".
  New here, for the maintainer to confirm: a comment's text is capped at
  `MAX_COMMENT_LENGTH` (10,000 UTF-16 code units) and a reaction's emoji at
  `MAX_REACTION_LENGTH` (8, one emoji with its modifiers: a flag or a skin
  tone is four, a keycap three), both in `lib/whiteboard/limits.ts`, checked
  by the call schemas and again in `postComment`, `editComment` and
  `react`. Jolly Roger's chat capped neither; the composer's textarea keeps
  to the text cap.
  Lock names are `board-comment:` for `chat-message:`. Inserts set
  `createdBy: sender` themselves, where the method context did it. No
  notifications, mentions or images. `UNCOMMENTABLE_TYPES` and
  `assertCoordinate` are exported from `whiteboardEdits.ts` for it.
- `whiteboardEdits.ts`: `Mongo.Selector` is the shim's `Selector`;
  `InkPointPattern` is `InkPoint` in `lib/protocol.ts`; the operator checks
  (`userMayWritePuzzlesForHunt`) are `isOperator(claims)`;
  `assertStoredImages` comes from `images.ts`.
- `images.ts` is new, as much of `getS3UploadParams.ts` as node validation
  needs: `imageBucket()` reads `S3_IMAGE_BUCKET_NAME` and
  `S3_IMAGE_BUCKET_REGION` from the environment (the `s3.image_bucket`
  setting), and `imageObjectUrl`, `isImageObjectUrl` and `assertStoredImages`
  are unchanged. Uploads and the signed policy wait for their workstream.
- `whiteboardVersions.ts`: the merged-account mapping (`mergedAccounts`,
  `withMergedAccounts`) is gone with Jolly Roger's merge jobs; pruning
  reads `board.archived` in place of the hunt's `isArchived`;
  `exportBoard` takes an `ExportConnection` (`{ id, onClose }`) in place of
  `Meteor.Connection`; `planOptions` takes the claims. `rawCollection()` is
  on the model.
- `whiteboardReset.ts` and `whiteboardPolicy.ts`: as the source, with claims.
  `setEditPolicy` no longer drops people who aren't in the hunt (nothing
  here knows who is) and no longer clears live edits itself: the board's
  change reaches the room, which calls `clearLiveEditsOfNonEditors`.
- `live.ts` replaces `whiteboardLive.ts`. Presence is in memory per room:
  `createRoomLive(board)`, `joinLive`, `leaveLive`, `presenceOf`,
  `applyLive(room, connectionId, claims, payload)` returning the presence
  to broadcast (or undefined when dropped), `setLiveClaims` for a renewed
  token and `clearLiveEditsOfNonEditors(room)` for a policy change, both
  returning what changed. `validateLive` and the per-connection and
  per-user token buckets are the source's. Access is worked out from
  `room.board` on every update (the room keeps it current), so the cache,
  its TTL, the epochs and the observers are gone; an update whose access
  changed while it looked things up still keeps only its cursor. Who can be
  followed is whoever is in the room. The Mongo presence collection, the
  dead-server cleanup, `removePresence` and `trackedBoardCounts` are gone.
- `methods.ts` is new: `callMethod(name, claims, boardId, args, context)`
  checks `args` against the call's schema (refusing with
  `Match error: ...`, and `Unknown key` for an extra field, as `check` did),
  then runs the handler as the caller (`withUser`) so the models stamp
  `createdBy` and `updatedBy`. `restoreItems` answers `{ restored }` as its
  method did; `exportBoard` gets the connection from the context.
- `changes.ts` is new, the broadcast seam: `notify(collection, id, doc)`,
  `onChange(listener)`, and `watchModel`, which wraps a model's writes so
  each ends by notifying the documents it touched, read back after the
  write (a soft delete is a change whose doc has `deleted: true`). It's
  installed on Whiteboards, WhiteboardNodes, WhiteboardEdges,
  WhiteboardVersions, BoardComments, Puzzles and Tags when
  `whiteboardShared.ts` is imported. An update finds the ids its selector
  matches before writing, so a write costs a read or two more; an upsert
  under a pinned id that inserts notifies that id once.
- `withLock.ts`: a waiter hears this process's releases through an
  `EventEmitter` and looks for another process's every 50 ms, in place of
  `observeChangesAsync`; a `stopped` flag ends the poll once the wait is
  over. `withRenewedLock` uses try/finally for `using`.
- `ignoringDuplicateKeyErrors.ts`: `MongoError` from `mongodb`.
- `flags.ts` replaces `Flags` and the `FeatureFlags` model: a flag is on
  when `FLAGS` in the environment names it, or a `settings` document
  (`server/models/Settings.ts`, new) says so, which `Flags.set` writes.
  The checks sit where the source has them.
- `logger.ts` is a console JSON-lines logger with Jolly Roger's `Logger`
  shape (`info` is quiet under `NODE_ENV=test`).
- `tagSynonyms.ts` returns `TAG_SYNONYMS` until the setting is fed across.
- `rateLimits.ts`, `models/Locks.ts` and `models/WhiteboardVersionChunks.ts`
  are unchanged but for `lib/...` imports.

## Tests (server)

`tests/server/*.test.ts` are the source's `tests/unit/imports/server/`
whiteboard tests under bun:test, against the scratch Mongo
(`tests/server/harness.ts` connects, builds the indexes and empties every
collection between tests). Users are claims (`makeUser`, `archived`,
`claimsFor`), methods are `callMethod` or the functions themselves, Jolly
Roger's puzzle and tag methods are direct writes to the copies plus
`deferSyncPuzzlesOnBoard`, chat is `server/comments.ts`, `assert.isRejected`
is `rejects`, sinon is `spyOn` (`spyOnMethod` for generic methods) and
`fakeNow` stands in for fake timers. The fixture hunt's tags and puzzles
are `lib/fixtureHunt.ts`.

Of the source's 285 cases, 243 are here (226 under their own titles, 17
adapted to the room API or the feed and retitled), 8 are new (a puzzle's
own board, the comment edit, reply delete, reaction and board checks, and
the change seam), and 42 were dropped because their subject is gone:

- board creation's operator, archived-hunt and backing-puzzle checks (3);
  a tag rename that changes nothing (Jolly Roger's method);
- the ink and contents publications (3), `publishes nothing with history
  off` (its recording half stays);
- Mongo presence: the dead-server cleanup, the 16-board bookkeeping, a
  removed board's presence, writing only through the method (4), and the
  live cache's cross-connection reread, default-role operators, other
  boards and archived-hunt forgetting (4);
- chat: `/pin` commands, the backing puzzle, ordinary chat, notifications
  and mentions (7) and every "on a puzzle's card" notification case (11);
- account merging (3 in `whiteboard`, 1 in `whiteboardVersions`, 1 in
  `whiteboardLocks`) and `drops people who aren't in the hunt from the list`
  (membership is Jolly Roger's);
- `whiteboardGuards.ts` entirely (4): Jolly Roger's methods refusing the
  backing puzzle.

## `server/`: the process

New, to the service design; nothing here has a Jolly Roger counterpart.

- `token.ts`: `signToken(claims, secret)` and `verifyToken(token, secret)`,
  `<base64url(JSON)>.<base64url(HMAC-SHA256)>` with a timing-safe compare.
  Verification refuses a bad signature before it reads the claims, then a
  version other than 1, claims that don't fit `ClaimsSchema`, an `exp` that
  has passed, and one more than five minutes plus a minute's clock skew
  ahead. The service never mints; `signToken` is for tests and Jolly
  Roger's adapter.
- `config.ts`: `loadConfig(env)` reads `MONGO_URL`, `PORT` (default 3100),
  `PUBLIC_URL`, `JR_URL`, `JR_SHARED_SECRET` (32 characters at least),
  `FLAGS` and `S3_IMAGE_BUCKET_NAME`/`_REGION`, and throws a `ConfigError`
  naming the variable. `PUBLIC_URL` and `JR_URL` must be bare origins.
  `TEST_MODE=1` is refused under `NODE_ENV=production`.
  `flags.ts` and `images.ts` still read their variables themselves; the
  config only checks them.
- `rooms.ts`: a room per board, made by the first `joinRoom` (which loads
  the board; a second join while it loads shares the load) and dropped
  `ROOM_GRACE_MS` (5 s) after the last leave, so a reload doesn't reload the
  board. The room subscribes to `onChange` and forwards a `change` for the
  board document, its nodes, edges, versions and comments, and on a hunt
  board the hunt's puzzles and tags. A removal (`doc: null`) is forwarded
  only for an id the room has sent down, since nothing else says which
  board it was on. A socket that asked to hide ink gets each ink node as
  its outline without `points`, in the snapshot and in changes, as Jolly
  Roger's ink publication sent them. A change to the board
  document updates `live.board`, calls `clearLiveEditsOfNonEditors` and
  sends the cleared presences, then closes (4403) any socket whose access
  became none; the board document going altogether closes everyone (4404)
  and drops the room. A new member is seated before its snapshot is read,
  and what arrives meanwhile is queued and sent after the `welcome`.
  `snapshot(board, claims, { hideInk })` builds the welcome payload. Each
  snapshot a socket is sent (the join's, and a renewal's that changes
  `hideInk`) is one of the person's big reads, from the same bucket as
  version and export chunks (`takeBigRead` in `whiteboardVersions.ts`): a
  join past it is refused 429 (the socket closes 4429), a renewal past it
  renews the token, keeps the ink as it was, and answers `welcome` without
  the snapshot then an `error` with `id: null`. A person gets
  `MAX_SOCKETS_PER_USER_PER_BOARD` (16) seats on a board; the next join is
  refused 429 too. `activityOf(boardId)` is who's been seen on the board
  since its room loaded (join and live updates), in memory only.
- `ws.ts`: the Bun.serve websocket handler. Frames are EJSON rather than
  plain JSON, so a live `editingAt`, a document's dates and an export's
  bytes cross the wire as what they are; the client parses with the same
  `EJSON`. Frames are handled one at a time per socket, so a call sent
  straight after the hello waits for the join. The first message must be
  `hello { token, hideInk? }`: a bad token closes 4401, no board for the
  scope 4404, `disable.whiteboard` 4503, too many seats or big reads 4429,
  anything else first 4400. A
  second `hello` renews the token (`renewClaims`: `setLiveClaims`, a
  `welcome` without the snapshot unless the hello changed `hideInk`, in
  which case the snapshot comes again; another scope closes 4403). `call` goes
  through `callMethod` with the socket as the export connection and is
  answered `result { id, value }` or `error { id, code, reason }` (a
  `ServiceError` as is, anything else logged and 500 "Internal error").
  `live` goes through `applyLive` and the presence returned is sent to
  everyone else in the room; a refused update is answered `error` with
  `id: null`, as is a malformed frame after hello (before it, 4400). The
  server sends `ping` every 25 s and closes 4408 if the last one wasn't
  answered (any frame counts); a client `ping` gets `pong`. A socket whose
  token has been expired for a minute without a renewal is closed 4401 at
  its next ping. Frames are sized before they're parsed: one over 64 KiB
  closes 1009 unless the socket has joined its room and the frame begins
  `{"t":"call"`, in which case it may be as big as `MAX_CLIP_LENGTH` plus
  the envelope (a pasted board); binary frames close 1003.
- `http.ts`: `POST /boards`, `DELETE /boards/:id` and
  `GET /boards/:id/activity` behind a timing-safe `Authorization: Bearer`
  check, `GET /healthz`, and the client from `dist/` (`index.html` for `/`
  and `GET /boards/:id`, a placeholder page while there's no build;
  `/assets/*` cached as immutable). Every HTML response carries
  `Content-Security-Policy: frame-ancestors <JR_URL>`; API and asset
  responses carry nothing about framing. The board url `POST /boards`
  answers is `<PUBLIC_URL>/boards/<id>`; Jolly Roger adds `?token=`.
- `app.ts` is `startService({ config, port })`: Bun.serve with `/ws`
  upgraded and everything else routed to the HTTP handler,
  `pruneWhiteboardVersions` a minute after start and hourly after that
  (Jolly Roger's cron job; a failed pass is logged and the next runs), and
  a `stop()` that clears the timers, waits for a pass under way, and closes
  every room's sockets (1001) and the server. `main.ts` loads
  the config, connects, runs `ensureIndexes`, starts the service and stops
  it on SIGTERM or SIGINT before disconnecting.

Where this departs from the design document: EJSON frames; `welcome` also
carries `access` (what the policy makes of the token now), `operator`,
`assignedOperator` and `connection` (the socket's id, which its own
presence carries), and has no
`snapshot` on a renewal; `live` isn't echoed to its sender; errors outside
a call have `id: null`; the page lives at `/boards/:id`.

## Tests (process)

`tests/server/service.ts` starts the service on port 0 against the
scratch Mongo and wraps a Bun `WebSocket` as `TestClient` (`hello`, `call`,
`next`, `none`, `closed`). `token.test.ts` (9), `config.test.ts` (8), `http.test.ts` (17),
`ws.test.ts` (29), `rooms.test.ts` (9) and `app.test.ts` (2, the prune
timer) cover what the design asks for; 74 cases in all. `ddp.test.ts` (8) runs the DDP client against a fake
socket (`fakeDdp.ts`), `hunt-feeds.test.ts` runs the hunt feed against the
same fake (a full send, a reconnect's resend written only where it
changed), and `feed.test.ts` has one case without a server (`FEED=off`) and
nine against a running Jolly Roger (login, the first load and placement, a
puzzle added, a tag change moving a card, a renamed tag, a deleted puzzle
hidden and shown again, a reconnect's resync, and a deleted board), skipped
unless `JR_TEST_URL` is set.

## `server/feed/`: the feed from Jolly Roger

New, to the service design; it stands in for the hooks and methods that
called placement in Jolly Roger, with the puzzle and tag writes happening
over there and arriving here over DDP.

- `ddp.ts`: a DDP 1 client over `WebSocket` (Bun's, or a `SocketLike` a
  test hands in): `connect`/`connected`, `ping`/`pong`, `sub`/`unsub` with
  `ready` and `nosub`, `added`/`changed` (`fields` and `cleared`)/`removed`
  to `onData`, `method` with `result`, and `login` with `{ resume }` or
  `{ user: { email }, password: { digest, algorithm: "sha-256" } }` (the
  token first, the password once it's refused; the token a login returns is
  kept for the next connect). A dropped socket reconnects with backoff
  (`minBackoffMs` doubling to `maxBackoffMs`, 1 s to 30 s), logs in and
  sends every subscription again. Frames are `EJSON` from `lib/compat`.
  Pending calls are rejected on a drop rather than re-sent.
- `hunts.ts` (`startHuntFeeds`): one subscription pair per hunt with a
  board, `Puzzles.publications.forHunt` (`{ huntId, includeDeleted: true }`,
  which the server honours for admins only; the service account stays an
  ordinary member, so a deleted puzzle stops being published and its card
  is hidden rather than handed to its `replacedBy`) and `Puzzles.publications.forPuzzleList`
  (`{ huntId }`; the tags come with it, as Jolly Roger has no tags-only
  publication; its bookmarks are ignored). Hunts are found from
  `Whiteboards` at start and from the change seam after (a hunt board
  added or removed). Documents are mirrored into `Puzzles`/`Tags` keeping
  only the fields the copies declare: `added` is a replacement upsert,
  `changed` a `$set`/`$unset`, `removed` a soft delete (so placement
  retires the card, as `destroyPuzzle`'s hook did), each in the order
  received. The puzzles a batch touched (for a tag, those carrying it, as
  `renameOrMergeTag` found them) go to `deferSyncPuzzlesOnBoard` 50 ms
  after the last change; `deferSyncRoundsOnBoard` isn't used, since no
  Jolly Roger tag path called it. A document the copy already holds as
  sent (a resend after a reconnect; `holds` compares the declared fields,
  allowing a default and the updated stamps) isn't written again, so the
  rooms hear nothing of it; the same for a `changed` that changes nothing
  and a `removed` of a copy already retired. After a connect the hunt's
  batch waits until both subscriptions are ready, then copies the server
  didn't send are retired and what changed goes to placement at once. A
  board's deletion drops the pair and the hunt's copies.
- `index.ts` (`startFeed`): the client on `<JR_URL>/websocket` with the
  configured credentials, plus the hunt feeds; `app.ts` starts it once the
  server is listening (unless `FEED=off`) and stops it first on shutdown.
- `config.ts`: `feed` from `JR_SERVICE_TOKEN`, `JR_SERVICE_EMAIL` and
  `JR_SERVICE_PASSWORD`, and `FEED`.

## `client/`: the board in the browser

Jolly Roger's whiteboard canvas (`imports/client/components/whiteboard/`,
the hooks it uses and the few components around it), built with Vite into
`dist/`, which `server/http.ts` serves at `/boards/:id`. Of the 119 files
brought across, 88 are byte-identical to their source but for their import
lines; the rest are listed below with what changed. Every import of a
Meteor package, a Jolly Roger model or a method goes to a module under
`client/` or `lib/` that keeps the shape the code expects, so most files
moved with import changes only.

### Tooling

- `vite.config.ts`: React, the `lib/*` and `client/*` aliases, and a plugin
  that swaps `lib/db.ts` and `lib/typedModel/userContext.ts` for
  `client/shims/*.ts` in the browser (the driver, and Node's
  `AsyncLocalStorage`; the models import both through `Model.ts` and never
  need them there). The models themselves are untouched. `index.html` is the
  page; `bun run build` writes `dist/`; `bun run dev:client` runs Vite with
  `/ws` and `/boards` proxied to the service (the board page itself stays
  Vite's).
- `tsconfig.json` adds `jsx: react-jsx`, the `client/*` path and `scripts`.
  `client/vite-env.d.ts` declares the stylesheet imports itself rather than
  referencing `vite/client`, whose `ImportMeta` clashes with Bun's.
- `lib/compat/ejson.ts` does its base64 through binary strings, so the same
  module runs in the browser; the wire format is unchanged.
- `client/styled.d.ts` types styled-components' theme as `client/theme.ts`'s
  `Theme` (Jolly Roger's `types/styled.d.ts`).

### The store (`client/store/`)

In place of Minimongo and `meteor/react-meteor-data`:

- `collection.ts`: `Collection<T>` keyed by `_id`, with `find(selector,
  { sort, projection | fields, limit, skip })` returning a `Cursor`
  (`fetch`, `map`, `forEach`, `count`, `observe`, `observeChanges`) and
  `findOne(id | selector, options)`. Selectors take equality (an array field
  matches a value in it, as Mongo's does), `$in`, `$nin`, `$ne`, `$exists`,
  `$gt`/`$gte`/`$lt`/`$lte` on numbers, strings and dates, dotted paths, and
  `$or`/`$and`/`$nor`; anything else throws. Sorts take several fields with
  missing values first. A projection copies the named top-level fields
  (`_id` always); without one the stored object itself is handed back, so
  identity survives across runs. `set(doc)` with `deleted: true` removes
  (the change seam's soft deletes); `replaceAll` is a snapshot.
- `tracker.ts`: `track(fn)` records which collections and cells `fn` read;
  `Cell<T>` is one reactive value.
- `useTracker.ts`: `useTracker(fn, deps, skipUpdate?)` on
  `useSyncExternalStore`: `fn` runs again when anything it read changes or
  `deps` change, and a result equal by value (`EJSON.equals`) to the last
  keeps the last, so unchanged documents keep their identity. The third
  argument is `react-meteor-data`'s comparator (`useRemoteDrags` uses it).
  `createTrackerStore` is the hook without React, for tests.
- `collections.ts`: `Whiteboards`, `WhiteboardNodes`, `WhiteboardEdges`,
  `WhiteboardVersions`, `BoardComments`, `Puzzles` and `Tags`, named as
  their models are so a `change` message finds its collection, plus
  `WhiteboardPresence` (one document per other connection, `_id` the
  connection id, `board` and `name` added, from `presence` and `live`
  messages; the viewer's own tab is left out as Jolly Roger's publication
  left it out) and `Users` (`{ _id, displayName }` for everyone seen on the
  board this session, from the welcome, `presence` and `live`). `applyWelcome`,
  `applyChange`, `applyLive` and `applyPresence` feed them.
- `current.ts`: cells for the welcome and the connection's state.

### The session (`client/session.ts`)

Opens the websocket, sends `hello { token, hideInk }`, answers `ping`,
hands `welcome`, `change`, `live` and `presence` to its handlers, and
answers `call(name, args)` with a promise settled by `result` or `error`
(a `ServiceError` with the code and reason; a `null` value reads as
`undefined`). Everything but a ping is handed on in bursts, as Meteor's
connection buffered its writes (5 ms after the last message, at most
500 ms after the first), so the documents one call wrote reach the store
in one go and render once, and the call's answer follows them. A dropped socket reconnects with backoff (1 s doubling to 30 s)
and a fresh hello, whose welcome brings the snapshot again; the close codes
the server won't take back (4400, 4401, 4403, 4404, 4503) leave it closed,
and 4401 after the token's `exp` is "expired", which the page shows as
"Reload to continue". A minute before `exp` it asks for a fresh token, and
every ten seconds until one comes: by default
`window.parent.postMessage({ t: "token" }, jrUrl)`, taking a reply
`{ t: "token", token }` from that origin (`requestToken` and `setToken` for
anything else). `setHideInk` sends another hello with the new `hideInk`, whose welcome
brings the snapshot again, with or without the ink's points.

### What stands in for Meteor

- `client/methods.ts`: `TypedCall` objects (`call(args, cb)`,
  `callPromise(args)`) under the names the methods had
  (`upsertWhiteboardNodes`, `fetchWhiteboardVersion`, ...), each dropping
  the `boardId` the Meteor methods wanted, so `boardWrites.ts`,
  `useWhiteboardUndo.ts` and the rest call them as they did. The comment
  calls are `postBoardComment`, `editBoardComment`, `deleteBoardComment`,
  `setBoardCommentResolved` and `reactToBoardComment`. `setWhiteboardLive`
  sends a `live` frame.
- `client/compat/meteor.ts`: `Meteor.userId()`, `Meteor.user()`,
  `Meteor.status()` and `Meteor.absoluteUrl()` over the cells, and
  `Meteor.Error` as `ServiceError`.
- `client/compat/router.ts`: `Link` as a plain `<a target="_top">` on the
  welcome's `jrUrl`, and `useNavigate` setting the top window's location,
  for links into Jolly Roger (a card's Open puzzle, a feeder's row, a
  double-clicked card).
- `client/compat/flags.ts`: `Flags.active(name)` from the welcome's `flags`.
- `client/access.ts`: the `WhiteboardAccess` and `WhiteboardAccessReason`
  types from `permission_stubs.ts`.
- `lib/compat/random` and `lib/compat/ejson` for `meteor/random` and
  `meteor/ejson`.

### Files changed beyond their imports

- `WhiteboardPage.tsx` (at `client/`): the board page without the puzzle
  page, chat sidebar, breadcrumb or React Router. Access comes from the
  welcome (`access`, `mayEdit` off meaning "archived", the board's policy
  as the reason for "comment"), the operator flag from the welcome, and
  "offline" from the connection's state; the query string (`?comment=`,
  `?puzzle=`, `?node=`, `?v=`) is read from the page's own url and cleared
  with `history.replaceState`. No "create whiteboard" page: a board comes
  from `POST /boards`, and a closed socket shows why (off, no board, not
  allowed, expired).
- `main.tsx`, `i18n.ts`, `app.css`: new. The entry opens the session with
  `?token=` (taken off the address bar), wires it to the store, and renders
  in Jolly Roger's theme by the system's colour scheme. i18next runs with
  no resources but the counted strings (`_one`/`_other`, from Jolly Roger's
  `en.json`, since a default can't say both "1 reply" and "2 replies"), so
  every other string is its inline default, and without HTML escaping
  (React escapes).
- `WhiteboardCanvas.tsx`: no `puzzleId` prop (comments are board-keyed), no
  presence subscription (presence comes with the room), no
  `PuzzlePeopleProvider`, no hunt name for the download's file name (the
  service doesn't know it, so a download is "hunt-...").
- `canvasChrome.tsx`: `PuzzlePeopleProvider` gone with the people.
- `PuzzleCardNode.tsx`: the people row (who's on a call or has the puzzle
  open) is gone; a locked puzzle shows as locked from `puzzle.locked` alone
  (no `allowUnlockablePuzzles` hunt setting, no `lockedSummary` in the copy).
- `FeedersButton.tsx`: no `lockedSummary`.
- `CommentComposer.tsx`: a textarea in place of the chat editor. Enter
  sends, Shift+Enter breaks the line, `@` offers the names of the people
  seen on the board (those here now first) and completes to the name as
  text; no mentions, puzzle links or images.
- `CommentPanel.tsx`: over `BoardComments` and the comment calls; no
  `huntId`/`puzzleId`, no roles, no Discord avatars; "operator" from the
  welcome; Escape in the composer is judged on the textarea.
- `CommentText.tsx` (new, for `ChatMessage`): text as markdown, mentions as
  `@name`, puzzle links into Jolly Roger; no images or role mentions.
- `CommentReactions.tsx` (new, for `ChatMessageReactions`): one
  `comment.react { on }` call per toggle, and a row of eight emoji in place
  of the emoji-picker-react picker.
- `CommentLayer.tsx`, `CommentList.tsx`, `useBoardComments.ts`,
  `useWhiteboardComments.ts`: `BoardComments` types and the board's id in
  place of chat and the backing puzzle.
- `useLinkedComment.ts`: "comments loaded" is the welcome having arrived,
  in place of `ChatLoadedContext`.
- `EditPolicyModal.tsx`: the people who may edit are a textarea of Jolly
  Roger user ids, one per line, in place of react-select over the hunt's
  members (the service knows no names but those seen on the board). No
  `huntId`, and no "everyone is an operator" note.
- `HistoryPanel.tsx`: no versions subscription (they come with the
  snapshot); names from `Users`.
- `Avatar.tsx`, `AvatarStack.tsx`, `NodeContributors.tsx`,
  `useAvatarUsers.ts`: initials only; `discordAccount` is gone.
- `LockBadge.tsx`, `useWhiteboardNames.ts`, `indexedDisplayNames.ts`:
  `Users` in place of `MeteorUsers`. A name is known only once its owner has
  been on the board this session; otherwise "Unknown"/"Someone".
- `CursorLayer.tsx` and `useWhiteboardLive.ts`: the cursor goes every
  100 ms like a drag (was 200), and each hop on screen glides for the gap
  since the previous update, clamped to 60 to 250 ms, so a remote cursor
  doesn't stop between updates.
- `useImageTool.ts`, `useChatImagesEnabled.ts`, `uploadChatImage.ts`: the
  Image button stays, disabled while the welcome says `imagesEnabled` is
  off; `uploadChatImage` fails every upload as "nowhere to store images"
  until uploads have their workstream, and takes no puzzle id.
- `useTagSynonyms.ts`: the built-in `TAG_SYNONYMS` (no settings
  subscription), as the server does.
- `RelativeTime.tsx`: `window.setTimeout` for `Meteor.setTimeout`.
- `theme.ts`: `reactSelectTheme` removed with react-select.
- `search.ts`: the guess matcher dropped (no guesses here).
- `lib/chatMessagePlainText.ts`, `lib/nodeIsMention.ts`,
  `lib/nodeIsPuzzle.ts`: over the `BoardComments` content types, without
  image and role-mention nodes; the firehose form is gone.

Not brought across: `PeopleContext.ts`, `ChatLoadedContext.ts`,
`ShowOnBoardLink.tsx` (a Jolly Roger page's link into the board),
`useTypedSubscribe.ts`, `usePuzzleViewers*.ts`, `useMentionableUsers.ts`,
`useEditorImageUpload.ts`, `useSubscribeDisplayNames.ts`, `FancyEditor`,
`ReactionPicker`, `ChatMessage`, `ChatMessageReactions`, and the puzzle
page the board sat in.

Where this leans on the server: `welcome` carries `jrUrl` (from
`JR_URL`), `imagesEnabled` (false until uploads exist) and `flags` (the
active flag names), added in `server/ws.ts`.

### Tests (client)

`tests/client/store.test.ts` covers the query operators, sorts, projections,
`deleted` removal, observe/observeChanges and the tracker store (24 cases
with `useTracker.test.tsx`, which renders a component under happy-dom and
sees it re-render on a change and on new deps). `tests/client/session.test.ts`
(10) runs the session against `tests/server/service.ts`: the welcome and
its extras, call resolution and refusal by id, live and presence, a
reconnect with a fresh hello after `closeRooms`, a terminal close, and
token renewal through `requestToken`.

`scripts/seed-dev.ts` fills a running service with the fixture hunt and
prints board links with tokens for two made-up people, for looking at the
client in a browser.

## Tests (acceptance)

`tests/acceptance/whiteboard.tsx` is the source's file of the same name (204
cases of Testing Library and `fireEvent` inside a real browser against the
real app), run the way the source ran it, in the browser, with the page
driven by Playwright from Node (`run.ts`; the source used
`meteortesting:mocha` with its Playwright driver). The bundle is a second
Vite build (`vite.acceptance.config.ts`, in development mode for React's
`act`) of `tests/acceptance/index.html`, whose `runner.ts` loads mocha's
browser build, sets it up, imports the tests, and reports each result to the
console and the whole run to `window.__results`. `serve.ts` starts the
service in test mode for it; `server/testMode.ts` is the endpoints
(`/test/reset`, `/test/token`, `/test/fixture`), served only with
`TEST_MODE=1` and covered by `tests/server/testMode.test.ts`, which also
checks they 404 without it.

The helpers at the top of the test file are rewritten for the data layer
(`harness.tsx`), and the test bodies are the source's but for these:

- `render(<TestApp />)` plus `goTo(url)` is `goTo(url)`: the page reads its
  address when it mounts, so going somewhere sets the address and renders
  the board page afresh, into a fixed container over the runner's report.
  `location.current?.search` is `window.location.search`.
- Logging in and out is `login(person)` and `logout()` on the harness, a
  person being a token's claims (`OPERATOR`, `MEMBER`, `SECOND`); the
  `createTestUser`, `addHuntUser` and `promoteOperator` calls go. Archiving
  the hunt renews every open session's token with `mayEdit` off, which is
  what Jolly Roger would mint.
- The second connection (`other`) is a `BoardConnection`: `other.callAsync`
  is `other.call` (which also takes `setWhiteboardLive`, as a live frame,
  and `updateProfile`, as a renewed token with the new name), its presence
  subscription is `other.join()` (a socket on the board is on the board;
  `stop` closes it a turn later, unless a call follows at once, as Jolly
  Roger's immediate removal was undone by a live update sent straight
  after before anyone's buffered writes flushed; the next call or join
  opens another socket), and `theirPresence` is `other.presence`.
- `typedSubscribe.async(...)` calls go: the data is in the store. Reads are
  the store's sync `findOne`, `fetch` and `count` (still awaited).
  `ChatMessages` is `BoardComments`, `sendChatMessage` is
  `postBoardComment` with `{ text, anchor }`, `deleteWhiteboardComment` and
  `setWhiteboardCommentResolved` are the board comment calls.
- Jolly Roger's methods the tests called are small objects over
  `/test/fixture`: `createPuzzle`, `addPuzzleTag`, `removePuzzleTag`,
  `destroyPuzzle`, `undestroyPuzzle`, `setPuzzleAnswers`,
  `markPuzzleDeleted`, `clearWhiteboardVersions`, `fillInk`,
  `setImageBucket`. `clearPuzzleSubscribers` as a round trip is
  `pageConnection().roundTrip()`. Every fixture write ends with the same
  round trip, so it settles once the page's store has what it changed, as
  a Meteor method's promise settled after its writes had reached the
  client.
- The comment composer is a textarea: `[data-slate-editor]` is `textarea`
  and typing is a change event (`typeInto`).
- The "offline" test sets the `connection` cell where it stubbed
  `Meteor.status`; the double-click test checks `navigation.went()` (the
  router shim's `topNavigation` seam) where it read the router's location.
- A download is named `hunt-...`: the service doesn't know the hunt's name.
- "turns the Image tool, pasting and dropping off" has no upload to spy on
  (the port's `uploadChatImage` is a module function); it checks nothing
  landed on the board instead. The three image tests that only place image
  nodes by hand open the board with `openBoard()` rather than waiting for
  an enabled Image tool.
- `assert.isRejected` (chai-as-promised) is a local `rejects`.
- `stabilize` waits for the page's socket to be open with no call awaiting
  its answer, then a turn. Meteor's waited for every subscription to be
  ready, polling every 200 ms, which also gave an async fetch time to land:
  `openHistoryRow` waits for the preview's banner, since a version is
  unpacked after its call answers and a viewer's click would otherwise land
  on the live node.
- "deleted and replaced puzzles" takes its stand-ins round off the board
  afterwards. Left there, "forgets what could be undone once the layout is
  reset" (which keeps a note far down the board while it resets the layout)
  puts that round's frame below the note, and the phone tests, which open
  the board fitted to everything, then see no cards.
- Chrome's "ResizeObserver loop completed with undelivered notifications" is
  a window error, not an exception, and mocha's browser build would count
  it as the running test's uncaught error; the runner keeps it from mocha.
  The tests that care about it (`collectPageErrors`) listen for the error
  event themselves and still see it.
- The reaction picker is a row of emoji buttons labelled with the emoji, so
  the phone test finds `button[aria-label="✅"]` where it found
  emoji-picker-react's `[data-unified="2705"]`.

Of the source's 204 cases, 184 are kept (186 as run, since the touch
target test is written for three zooms) and 20 dropped, with the reason:

- `offers operators a button to create the board` and `doesn't offer to
  create a board on an archived hunt`: the create-board page (a board comes
  from `POST /boards`).
- `has the minimise chat toggle at the top of the board, as on a puzzle's
  page`, `shows a comment on the board from chat`, `switches between the
  board and chat on a narrow screen`, `shows a comment from chat on a
  phone, above the sheet`: chat.
- `sends the backing puzzle's page to the board`, `goes from a puzzle's
  page to its card on the board`, `keeps a replaced puzzle's card where it
  was, for its replacement` (driven from the puzzle list): Jolly Roger's
  own pages.
- `shows the people the puzzle list would on a card`: people on cards from
  Jolly Roger's presence.
- `gets a handle from typedSubscribe.async for a subscription that's
  already ready`: `typedSubscribe`.
- `adds an image from the Image tool in the middle of the view, no wider
  than 480`, `pastes an image at the pointer, at its own size`, `adds an
  image file dropped on the board where it's dropped`, `leaves an image
  dropped into a comment to the comment`, `says why an upload failed, and
  leaves nothing on the board`: image uploads.
- `uploads an image pasted into a comment and puts it in`, `says why an
  image upload failed, and won't send the failed image`, `says so, and
  uploads nothing, when the server has nowhere for images`: images in the
  comment composer.
- `telling a puzzle's people about a comment on its card` (the whole
  describe, one test): notifications.
- `shows the canvas, styled, and chat once there's a board` keeps its
  canvas half as `shows the canvas, styled, once there's a board`.

What the tests found and what changed for them:

- `client/store/useTracker.ts`: a tracker whose result is a `Map` or `Set`
  never updated, since `EJSON.equals` (as Meteor's) doesn't look inside
  them and read two different ones as equal. Such results now compare by
  identity (`useRoundStates` is one: a round's count never changed).
- `client/session.ts`: messages are handed on in bursts, as Meteor's
  connection buffered its writes (above), so the documents one call wrote
  render once and a frame and its notes move as one.
- Hidden ink comes as outlines without points (above), so a frame fitted
  while ink is hidden accounts for the strokes, and hiding or showing ink is
  another hello on the same socket rather than a reconnect, during which
  the board had gone view-only.
- `lib/compat/ejson.ts`: an undefined field was written as `null` where
  Meteor's (through `JSON.stringify`) left it out, so a comment on the bare
  board went over as `anchor: { node: null }` and the schema refused it.
- `server/live.ts`: a renewed token's name (and user) reaches the
  connection's presence, so a rename is heard by the others.
- `client/session.ts`: `inFlight`, how many calls await their answer, for
  the harness's `stabilize`.
- `client/compat/router.ts`: `topNavigation.go` is the one place the top
  window is sent to Jolly Roger, so a test page can record it.
- `client/methods.ts`: `setWhiteboardLive` has a `name` ("live");
  `client/compat/meteor.ts` has `Meteor.defer`.

## Left for later workstreams

- Image uploads and the signed policy; the `tag.synonyms` setting.
- Names for people who haven't been on the board this session (a
  comment's author, a version's editors, who locked a node): the feed or
  the token could bring them.
- The edit policy's list of editors as names rather than ids, once the
  service knows the hunt's members.
- Jolly Roger's adapter answering `{ t: "token" }` from the frame with a
  fresh token, and passing `?comment=`, `?puzzle=`, `?node=` and `?v=`
  through to the iframe's url.
