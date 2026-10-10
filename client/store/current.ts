import type { Welcome } from "lib/protocol";
import { Cell } from "./tracker";

// What the connection tells the client about itself: the welcome (who the
// viewer is, what they may do, where Jolly Roger is) and whether the socket
// is up. Read through Meteor-shaped helpers in client/compat/meteor.ts and
// the page.

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "expired";

export interface ConnectionState {
  status: ConnectionStatus;
  // Why it closed, when it won't come back on its own
  code?: number;
  reason?: string;
}

export interface WelcomeExtras {
  // Jolly Roger's origin, for links out of the board
  jrUrl?: string;
  // Whether the server has somewhere to put images
  imagesEnabled?: boolean;
  // The feature flags that are on
  flags?: string[];
}

export type CurrentWelcome = Welcome & WelcomeExtras;

export const welcome = new Cell<CurrentWelcome | undefined>(undefined);
export const connection = new Cell<ConnectionState>({ status: "connecting" });
