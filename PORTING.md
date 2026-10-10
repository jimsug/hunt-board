# Porting notes

What was changed on the way across from Jolly Roger (the `main-rebase-concise`
branch's `imports/lib`), so that a later sync from there is a diff, not a
rewrite. Anything not listed here is byte-identical to its source.

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

## Left for later workstreams

- The `meteor/check` patterns in `imports/server/whiteboardShared.ts`
  (`IdPattern`) and `imports/server/whiteboardEdits.ts` (`InkPointPattern`)
  are server-side and come with the server port.
- Observers: the three `observeChangesAsync`/`observeAsync` sites in the
  source's live cache will be room events, so the shim has no `observe`.
- The client will need `lib/db.ts` (the only runtime importer of `mongodb`)
  aliased away when the models are bundled for the browser.
