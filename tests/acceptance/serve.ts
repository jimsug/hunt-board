import { connect, disconnect } from "lib/db";
import ensureIndexes from "lib/typedModel/ensureIndexes";
import { startService } from "../../server/app";
import type { Config } from "../../server/config";

// The service as the acceptance run wants it: test mode on, no feed, the
// scratch Mongo, serving the acceptance bundle from dist-acceptance/ on a
// free port, which it prints as "READY <url>" for the driver to pick up.
// Started by tests/acceptance/run.ts under bun; stopped with SIGTERM.

const distDir = new URL("../../dist-acceptance", import.meta.url).pathname;

const config: Config = {
  mongoUrl:
    process.env.MONGO_URL ?? "mongodb://127.0.0.1:27217/huntboard-acceptance",
  port: 0,
  publicUrl: "http://board.example.test",
  jrUrl: "http://jr.example.test",
  jrSharedSecret: "acceptance-shared-secret-of-32-chars-or-more",
  flags: [],
  s3ImageBucketName: undefined,
  s3ImageBucketRegion: undefined,
  feed: { enabled: false },
  testMode: true,
};

await connect(config.mongoUrl);
await ensureIndexes(undefined, { info() {}, warn() {} });
const service = startService({ config, port: 0, distDir });
console.log(`READY ${service.url}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await service.stop();
  await disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
