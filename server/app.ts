import type { Server } from "bun";
import type { Config } from "./config";
import type { Feed, FeedOptions } from "./feed";
import { startFeed } from "./feed";
import { createHttpHandler } from "./http";
import Logger from "./logger";
import { closeRooms } from "./rooms";
import { deferredSyncsDone } from "./whiteboard";
import { pruneWhiteboardVersions } from "./whiteboardVersions";
import type { SocketData } from "./ws";
import { createWebSocketHandler } from "./ws";

// The served process, as one object: Bun.serve with the HTTP routes and the
// websocket on /ws, the feed from Jolly Roger once the server is listening,
// the hourly prune of board history (Jolly Roger's cron job), and a stop
// that closes every socket. main.ts runs it on the configured port; tests
// run it on port 0.

// The prune runs a minute after start, then every hour
export const PRUNE_FIRST_DELAY_MS = 60 * 1000;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface ServiceOptions {
  config: Config;
  port?: number;
  distDir?: string;
  pingIntervalMs?: number;
  feedOptions?: FeedOptions;
  pruneFirstDelayMs?: number;
  pruneIntervalMs?: number;
  // What the prune runs, for tests
  prune?: (now: Date) => Promise<unknown>;
}

export interface Service {
  server: Server<SocketData>;
  port: number;
  url: string;
  // Undefined with FEED=off
  feed: Feed | undefined;
  stop(): Promise<void>;
}

export function startService({
  config,
  port = config.port,
  distDir,
  pingIntervalMs,
  feedOptions,
  pruneFirstDelayMs = PRUNE_FIRST_DELAY_MS,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
  prune = pruneWhiteboardVersions,
}: ServiceOptions): Service {
  const http = createHttpHandler({ config, distDir });
  const { upgrade, websocket } = createWebSocketHandler({
    secret: config.jrSharedSecret,
    jrUrl: config.jrUrl,
    pingIntervalMs,
  });
  const server = Bun.serve<SocketData>({
    port,
    hostname: "0.0.0.0",
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        if (upgrade(req, server)) return undefined;
        return new Response("Expected a websocket upgrade", { status: 426 });
      }
      return http(req);
    },
    websocket,
  });
  const boundPort = server.port ?? port;
  const feed = config.feed.enabled ? startFeed(config, feedOptions) : undefined;
  let stopped = false;

  // The timers never keep the process up on their own; a stop clears them,
  // and a pass under way finishes
  let pruning: Promise<void> = Promise.resolve();
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  const runPrune = () => {
    if (stopped) return;
    pruning = prune(new Date()).then(
      () => {},
      (error) => Logger.error("Failed to prune board history", { error }),
    );
  };
  const firstPrune = setTimeout(() => {
    runPrune();
    pruneTimer = setInterval(runPrune, pruneIntervalMs);
    pruneTimer.unref();
  }, pruneFirstDelayMs);
  firstPrune.unref();

  return {
    server,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    feed,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(firstPrune);
      if (pruneTimer) clearInterval(pruneTimer);
      await pruning;
      await feed?.stop();
      await closeRooms((member) => member.close(1001, "Service stopping"));
      server.stop(true);
      await deferredSyncsDone();
      Logger.info("Stopped");
    },
  };
}
