import type { Config } from "../config";
import Logger from "../logger";
import { DdpClient } from "./ddp";
import type { HuntFeeds } from "./hunts";
import { startHuntFeeds } from "./hunts";

// The feed as the process runs it: a DDP client on Jolly Roger's websocket
// logged in as the service account, with a hunt feed on top. The resume
// token the first login hands back is what reconnects use, so the password
// is only sent when there's no token or the token has gone stale.

export interface Feed {
  client: DdpClient;
  hunts: HuntFeeds;
  stop(): Promise<void>;
}

export interface FeedOptions {
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
}

// Meteor's DDP endpoint is the app's origin with /websocket
export const ddpUrl = (jrUrl: string) =>
  `${jrUrl.replace(/^http/, "ws")}/websocket`;

export function startFeed(config: Config, options: FeedOptions = {}): Feed {
  const client = new DdpClient({
    url: ddpUrl(config.jrUrl),
    credentials: {
      token: config.feed.token,
      email: config.feed.email,
      password: config.feed.password,
    },
    ...options,
  });
  client.onLogin(({ id }) => {
    Logger.info("Logged in to Jolly Roger", { user: id });
  });
  client.onDisconnected(() => {
    Logger.warn("Lost the connection to Jolly Roger; reconnecting");
  });
  const hunts = startHuntFeeds({ client });
  client.connect();
  return {
    client,
    hunts,
    async stop() {
      await hunts.stop();
      client.close();
    },
  };
}
