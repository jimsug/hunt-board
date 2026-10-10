import type { Server } from "bun";
import type { Config } from "./config";
import { createHttpHandler } from "./http";
import Logger from "./logger";
import { closeRooms } from "./rooms";
import { deferredSyncsDone } from "./whiteboard";
import type { SocketData } from "./ws";
import { createWebSocketHandler } from "./ws";

// The served process, as one object: Bun.serve with the HTTP routes and the
// websocket on /ws, and a stop that closes every socket. main.ts runs it on
// the configured port; tests run it on port 0.

export interface ServiceOptions {
  config: Config;
  port?: number;
  distDir?: string;
  pingIntervalMs?: number;
}

export interface Service {
  server: Server<SocketData>;
  port: number;
  url: string;
  stop(): Promise<void>;
}

export function startService({
  config,
  port = config.port,
  distDir,
  pingIntervalMs,
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
  let stopped = false;
  return {
    server,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await closeRooms((member) => member.close(1001, "Service stopping"));
      server.stop(true);
      await deferredSyncsDone();
      Logger.info("Stopped");
    },
  };
}
