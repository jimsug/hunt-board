// Dependency tracking for the store, in the spirit of Meteor's Tracker but
// much smaller: while a function runs under track(), every collection or
// cell it reads notes itself, and useTracker re-runs the function when any of
// them changes.

export interface Dependency {
  // Bumped on every change, so a reader that isn't subscribed can still tell
  // it's stale
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

let reads: Set<Dependency> | undefined;

export function noteRead(dependency: Dependency) {
  reads?.add(dependency);
}

// Runs fn, returning its value and everything it read.
export function track<T>(fn: () => T): { value: T; deps: Set<Dependency> } {
  const previous = reads;
  const deps = new Set<Dependency>();
  reads = deps;
  try {
    return { value: fn(), deps };
  } finally {
    reads = previous;
  }
}

// One reactive value: the current user, the connection's status, and the
// like.
export class Cell<T> implements Dependency {
  version = 0;
  private value: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    noteRead(this);
    return this.value;
  }

  // The value without noting the read, for code outside a tracker
  peek(): T {
    return this.value;
  }

  set(value: T) {
    if (Object.is(value, this.value)) return;
    this.value = value;
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
