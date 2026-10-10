# hunt-board

The hunt whiteboard as a service: one process with websocket rooms and Mongo behind it, embedded by Jolly Roger as a document provider.

Runtime checks (`bun run check:mongo`, `check:ws`, `checks/crypto.ts`) need a Mongo on `MONGO_URL` (default `mongodb://127.0.0.1:27217/huntboard`).
