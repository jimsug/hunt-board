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
  mayEdit, exp, operator? }`), `boardAccess(claims, board)` returning edit,
  comment, view or none, `scopeMatches`, `isOperator` and `SERVICE_USER`,
  the id the service writes under when no person asked (seeding a board).
  It stands in for `whiteboardAccess(user, hunt, board)`: a scope that
  doesn't match the board is "none", `mayEdit: false` (Jolly Roger's
  archived hunt) is "view", and the edit policy decides the rest. "Operator"
  is `claims.operator === true`; Jolly Roger told its assigned operators
  from default-role ones (`userMayMakeOperatorForHunt`), the token doesn't.
- `lib/protocol.ts` is new: one Zod schema per call, mirroring the methods'
  `check()` patterns (`z.strictObject`, so an unknown key is refused as
  `check` refused it) without the `boardId`, which is the socket's. The
  `WhiteboardNodeInput`, `WhiteboardEdgeInput` and `CommentAnchorInput`
  types come from it. `comment.react` is `{ messageId, emoji, on }` in place
  of a reaction message and `removeChatReaction`. `ClaimsSchema` is the
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
  matches before writing, so a write costs a read or two more.
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
are `tests/server/fixtureHunt.ts`.

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
  has passed, and one more than five minutes ahead. The service never
  mints; `signToken` is for tests and Jolly Roger's adapter.
- `config.ts`: `loadConfig(env)` reads `MONGO_URL`, `PORT` (default 3100),
  `PUBLIC_URL`, `JR_URL`, `JR_SHARED_SECRET` (32 characters at least),
  `FLAGS` and `S3_IMAGE_BUCKET_NAME`/`_REGION`, and throws a `ConfigError`
  naming the variable. `PUBLIC_URL` and `JR_URL` must be bare origins.
  `flags.ts` and `images.ts` still read their variables themselves; the
  config only checks them.
- `rooms.ts`: a room per board, made by the first `joinRoom` (which loads
  the board; a second join while it loads shares the load) and dropped
  `ROOM_GRACE_MS` (5 s) after the last leave, so a reload doesn't reload the
  board. The room subscribes to `onChange` and forwards a `change` for the
  board document, its nodes, edges, versions and comments, and on a hunt
  board the hunt's puzzles and tags. A removal (`doc: null`) is forwarded
  only for an id the room has sent down, since nothing else says which
  board it was on; ink nodes are remembered the same way so a removed one
  is still kept from sockets that asked to hide ink. A change to the board
  document updates `live.board`, calls `clearLiveEditsOfNonEditors` and
  sends the cleared presences, then closes (4403) any socket whose access
  became none; the board document going altogether closes everyone (4404)
  and drops the room. A new member is seated before its snapshot is read,
  and what arrives meanwhile is queued and sent after the `welcome`.
  `snapshot(board, claims, { hideInk })` builds the welcome payload.
  `activityOf(boardId)` is who's been seen on the board since its room
  loaded (join and live updates), in memory only.
- `ws.ts`: the Bun.serve websocket handler. Frames are EJSON rather than
  plain JSON, so a live `editingAt`, a document's dates and an export's
  bytes cross the wire as what they are; the client parses with the same
  `EJSON`. Frames are handled one at a time per socket, so a call sent
  straight after the hello waits for the join. The first message must be
  `hello { token, hideInk? }`: a bad token closes 4401, no board for the
  scope 4404, `disable.whiteboard` 4503, anything else first 4400. A
  second `hello` renews the token (`renewClaims`: `setLiveClaims`, a
  `welcome` without the snapshot; another scope closes 4403). `call` goes
  through `callMethod` with the socket as the export connection and is
  answered `result { id, value }` or `error { id, code, reason }` (a
  `ServiceError` as is, anything else logged and 500 "Internal error").
  `live` goes through `applyLive` and the presence returned is sent to
  everyone else in the room; a refused update is answered `error` with
  `id: null`, as is a malformed frame after hello (before it, 4400). The
  server sends `ping` every 25 s and closes 4408 if the last one wasn't
  answered (any frame counts); a client `ping` gets `pong`. A socket whose
  token has been expired for a minute without a renewal is closed 4401 at
  its next ping. Frames over 64 KiB close 1009 unless they're a `call`,
  which may be as big as `MAX_CLIP_LENGTH` (a pasted board); binary frames
  close 1003.
- `http.ts`: `POST /boards`, `DELETE /boards/:id` and
  `GET /boards/:id/activity` behind a timing-safe `Authorization: Bearer`
  check, `GET /healthz`, and the client from `dist/` (`index.html` for `/`
  and `GET /boards/:id`, a placeholder page while there's no build;
  `/assets/*` cached as immutable). Every HTML response carries
  `Content-Security-Policy: frame-ancestors <JR_URL>`; API and asset
  responses carry nothing about framing. The board url `POST /boards`
  answers is `<PUBLIC_URL>/boards/<id>`; Jolly Roger adds `?token=`.
- `app.ts` is `startService({ config, port })`: Bun.serve with `/ws`
  upgraded and everything else routed to the HTTP handler, and a `stop()`
  that closes every room's sockets (1001) and the server. `main.ts` loads
  the config, connects, runs `ensureIndexes`, starts the service and stops
  it on SIGTERM or SIGINT before disconnecting.

Where this departs from the design document: EJSON frames; `welcome` also
carries `access` (what the policy makes of the token now), `operator` and
`connection` (the socket's id, which its own presence carries), and has no
`snapshot` on a renewal; `live` isn't echoed to its sender; errors outside
a call have `id: null`; the page lives at `/boards/:id`.

## Tests (process)

`tests/server/service.ts` starts the service on port 0 against the
scratch Mongo and wraps a Bun `WebSocket` as `TestClient` (`hello`, `call`,
`next`, `none`, `closed`). `token.test.ts` (9), `config.test.ts` (5),
`http.test.ts` (15), `ws.test.ts` (26) and `rooms.test.ts` (7) cover what
the design asks for; 62 cases in all.

## Left for later workstreams

- The client under `client/`, built to `dist/`.
- The feed: `syncPuzzlesOnBoard` and `deferSyncPuzzlesOnBoard` take the
  puzzle ids it mirrors; the `Puzzles` and `Tags` copies are written by it.
- Image uploads and the signed policy; the `tag.synonyms` setting.
- The client will need `lib/db.ts` (the only runtime importer of `mongodb`)
  aliased away when the models are bundled for the browser.
