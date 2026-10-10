import { connect, disconnect } from "lib/db";
import ensureIndexes from "lib/typedModel/ensureIndexes";
import { startService } from "./app";
import { ConfigError, loadConfig } from "./config";
import Logger from "./logger";

// The process: read the configuration, connect, bring the indexes up to
// date, serve, and on SIGTERM or SIGINT close the sockets and disconnect.

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

await connect(config.mongoUrl);
await ensureIndexes(undefined, Logger);
const service = startService({ config });
Logger.info("Listening", { port: service.port, publicUrl: config.publicUrl });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  Logger.info("Stopping", { signal });
  try {
    await service.stop();
    await disconnect();
    process.exit(0);
  } catch (error) {
    Logger.error("Failed to stop cleanly", { error });
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
