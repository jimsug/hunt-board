# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

## Layout

- `lib/` is shared pure code: the board logic under `lib/whiteboard/`, the models under `lib/models/`, the typed-model shim over the Mongo driver under `lib/typedModel/`, the replacements for the Meteor packages the code used under `lib/compat/`, who may do what from a token's claims in `lib/access.ts`, and the call schemas in `lib/protocol.ts`. `lib/db.ts` holds the connection.
- `server/` is the whiteboard server: placement and boards (`whiteboard.ts`), edits, versions, resets, the edit policy, comments, in-memory presence (`live.ts`), the call dispatcher (`methods.ts`) and the change seam the rooms will subscribe to (`changes.ts`). No websocket, HTTP or feed yet.
- `client/` is empty for now.
- `tests/` holds the `bun test` suites. `tests/lib/typedModel.test.ts` and everything under `tests/server/` need a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`), whose contents they empty between tests.
- `checks/` are the runtime probes written before the port started; they aren't part of the build.

Code is ported from Jolly Roger's `imports/lib` and `imports/server`; `PORTING.md` lists what was changed on the way.

## Configuration

Read from the environment: `MONGO_URL`; `FLAGS`, a comma-separated list of switches to turn on (`disable.whiteboard`, `disable.whiteboard_live`, `disable.whiteboard_versions`), which a `settings` document can also set at run time; `S3_IMAGE_BUCKET_NAME` and `S3_IMAGE_BUCKET_REGION` for the bucket image nodes may point at; `LOG_LEVEL=debug` for the dropped-update log.

## Commands

```
bun install
bun run check      # tsc --noEmit, biome check
bun run format     # biome check --write
bun test
```

The runtime checks (`bun run check:mongo`, `check:ws`, `checks/crypto.ts`) need a Mongo on `MONGO_URL` too.
