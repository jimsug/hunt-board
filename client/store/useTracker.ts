import { EJSON } from "lib/compat/ejson";
import type { DependencyList } from "react";
import { useMemo, useRef, useSyncExternalStore } from "react";
import type { Dependency } from "./tracker";
import { track } from "./tracker";

// A value computed from the store that's computed again whenever anything it
// read changes, for useSyncExternalStore. Reads are tracked on every run, so
// the dependencies follow what the function actually looked at.
export interface TrackerStore<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

// Whether a fresh result is the same as the last, so the component keeps the
// old one (and its identity). Dates and documents compare by value; a Map or
// Set compares by identity, as EJSON doesn't look inside them.
const sameResult = (previous: unknown, next: unknown) =>
  EJSON.equals(previous, next);

export function createTrackerStore<T>(
  fn: () => T,
  skipUpdate: (previous: T, next: T) => boolean = sameResult,
): TrackerStore<T> {
  let value: T;
  let computed = false;
  let dirty = true;
  // What the last run read, with the version each was at
  let versions = new Map<Dependency, number>();
  const listeners = new Set<() => void>();
  const subscriptions = new Map<Dependency, () => void>();

  const onChange = () => {
    dirty = true;
    for (const listener of [...listeners]) listener();
  };

  // Subscribed only while a listener is; a reader that isn't subscribed
  // compares versions instead.
  const syncSubscriptions = () => {
    if (listeners.size === 0) {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      return;
    }
    for (const [dependency, unsubscribe] of subscriptions) {
      if (!versions.has(dependency)) {
        unsubscribe();
        subscriptions.delete(dependency);
      }
    }
    for (const dependency of versions.keys()) {
      if (!subscriptions.has(dependency)) {
        subscriptions.set(dependency, dependency.subscribe(onChange));
      }
    }
  };

  const stale = () => {
    if (dirty) return true;
    for (const [dependency, version] of versions) {
      if (dependency.version !== version) return true;
    }
    return false;
  };

  const compute = () => {
    const { value: next, deps } = track(fn);
    versions = new Map([...deps].map((dep) => [dep, dep.version]));
    dirty = false;
    if (!computed || !skipUpdate(value, next)) value = next;
    computed = true;
    syncSubscriptions();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      syncSubscriptions();
      return () => {
        listeners.delete(listener);
        syncSubscriptions();
      };
    },
    getSnapshot() {
      if (stale()) compute();
      return value;
    },
  };
}

// Runs fn against the store and again whenever anything it read changes, or
// deps change, as meteor/react-meteor-data's useTracker did. skipUpdate says
// when a new result is close enough to the last to keep it.
export default function useTracker<T>(
  fn: () => T,
  deps: DependencyList = [],
  skipUpdate?: (previous: T, next: T) => boolean,
): T {
  const latest = useRef(fn);
  latest.current = fn;
  const skip = useRef(skipUpdate);
  skip.current = skipUpdate;
  const store = useMemo(
    () =>
      createTrackerStore(
        () => latest.current(),
        (previous, next) =>
          skip.current
            ? skip.current(previous, next)
            : sameResult(previous, next),
      ),
    // The caller's deps say when to start afresh
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
