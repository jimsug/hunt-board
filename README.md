# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

## Layout

- `lib/` is shared pure code: the board logic under `lib/whiteboard/`, the models under `lib/models/`, the typed-model shim over the Mongo driver under `lib/typedModel/`, and the replacements for the Meteor packages the code used under `lib/compat/`. `lib/db.ts` holds the connection.
- `server/` and `client/` are empty for now.
- `tests/` holds the `bun test` suites. `tests/lib/typedModel.test.ts` needs a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`).
- `checks/` are the runtime probes written before the port started; they aren't part of the build.

Code is ported from Jolly Roger's `imports/lib`; `PORTING.md` lists what was changed on the way.

## Commands

```
bun install
bun run check      # tsc --noEmit, biome check
bun run format     # biome check --write
bun test
```

The runtime checks (`bun run check:mongo`, `check:ws`, `checks/crypto.ts`) need a Mongo on `MONGO_URL` too.
