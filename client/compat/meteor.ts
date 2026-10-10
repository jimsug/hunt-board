import { connection, welcome } from "client/store/current";
import { ServiceError } from "lib/compat/error";

// The few Meteor globals the board's client reached for, over the store's
// cells: who the viewer is (from the welcome), whether the socket is up, and
// Jolly Roger's origin for absolute links. Meteor.Error is the service's
// error, which a call's refusal arrives as.

export const Meteor = {
  Error: ServiceError,
  userId(): string | null {
    return welcome.get()?.user ?? null;
  },
  user(): { _id: string; displayName: string } | null {
    const current = welcome.get();
    return current ? { _id: current.user, displayName: current.name } : null;
  },
  status(): { connected: boolean } {
    return { connected: connection.get().status === "open" };
  },
  // Runs fn once the current turn is over
  defer(fn: () => void): void {
    setTimeout(fn, 0);
  },
  // A link into Jolly Roger, from a path without its leading slash
  absoluteUrl(path = ""): string {
    const origin = welcome.get()?.jrUrl ?? window.location.origin;
    return `${origin}/${path.replace(/^\//, "")}`;
  },
};

// biome-ignore lint/style/noNamespace: so Meteor.Error names the type as well
export namespace Meteor {
  export type Error = ServiceError;
}
