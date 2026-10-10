import { EJSON } from "lib/compat/ejson";
import type { Dependency } from "./tracker";
import { noteRead } from "./tracker";

// An in-memory collection of documents keyed by _id, fed by the server's
// snapshot and change messages, with as much of Minimongo's query surface as
// the board's client uses: find and findOne with equality, $in, $nin, $ne,
// $exists, $gt/$gte/$lt/$lte (numbers, strings and dates), dotted paths and
// $or/$and, a sort by one or more fields, a projection, and observe and
// observeChanges for the hooks that watch presence.

export type Selector = Record<string, unknown>;

// Which fields to keep (truthy) or leave out (falsy), as Mongo reads it
export type Projection = Record<string, number | boolean>;

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  // Minimongo took either name
  projection?: Projection;
  fields?: Projection;
  limit?: number;
  skip?: number;
}

export interface ObserveCallbacks<T> {
  added?: (doc: T) => void;
  changed?: (doc: T, old: T) => void;
  removed?: (doc: T) => void;
}

export interface ObserveChangesCallbacks<T> {
  added?: (id: string, fields: Partial<T>) => void;
  changed?: (id: string, fields: Partial<T>) => void;
  removed?: (id: string) => void;
}

export interface ObserveHandle {
  stop(): void;
}

type Doc = { _id: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith("$"));

function getPath(doc: unknown, path: string): unknown {
  let value: unknown = doc;
  for (const part of path.split(".")) {
    if (!isPlainObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

// Mongo's equality: a field holding an array matches a value found in it.
function equalsOrContains(value: unknown, target: unknown): boolean {
  if (Array.isArray(value) && !Array.isArray(target)) {
    return value.some((item) => EJSON.equals(item, target));
  }
  return EJSON.equals(value, target);
}

// Where a value sorts among the types the board stores. Mongo puts missing
// values first, then numbers, strings, objects, arrays, booleans and dates.
function typeRank(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return 1;
  if (typeof value === "string") return 2;
  if (value instanceof Date) return 6;
  if (typeof value === "boolean") return 5;
  if (Array.isArray(value)) return 4;
  return 3;
}

export function compareValues(a: unknown, b: unknown): number {
  const rank = typeRank(a) - typeRank(b);
  if (rank !== 0) return rank;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return 0;
}

// Whether a comparison operator applies: both sides present and of a kind
// that orders.
const comparable = (value: unknown, target: unknown) =>
  value !== undefined &&
  value !== null &&
  typeRank(value) === typeRank(target) &&
  typeRank(value) !== 3 &&
  typeRank(value) !== 4;

function valueMatches(value: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equalsOrContains(value, condition);
  return Object.entries(condition).every(([operator, argument]) => {
    switch (operator) {
      case "$eq":
        return equalsOrContains(value, argument);
      case "$ne":
        return !equalsOrContains(value, argument);
      case "$in":
        return (argument as unknown[]).some((item) =>
          equalsOrContains(value, item),
        );
      case "$nin":
        return !(argument as unknown[]).some((item) =>
          equalsOrContains(value, item),
        );
      case "$exists":
        return (value !== undefined) === !!argument;
      case "$gt":
        return (
          comparable(value, argument) && compareValues(value, argument) > 0
        );
      case "$gte":
        return (
          comparable(value, argument) && compareValues(value, argument) >= 0
        );
      case "$lt":
        return (
          comparable(value, argument) && compareValues(value, argument) < 0
        );
      case "$lte":
        return (
          comparable(value, argument) && compareValues(value, argument) <= 0
        );
      default:
        throw new Error(`Unsupported query operator ${operator}`);
    }
  });
}

export function matches(doc: unknown, selector: Selector): boolean {
  return Object.entries(selector).every(([key, condition]) => {
    switch (key) {
      case "$or":
        return (condition as Selector[]).some((s) => matches(doc, s));
      case "$and":
        return (condition as Selector[]).every((s) => matches(doc, s));
      case "$nor":
        return !(condition as Selector[]).some((s) => matches(doc, s));
      default:
        return valueMatches(getPath(doc, key), condition);
    }
  });
}

export function compareBySort(
  sort: Record<string, 1 | -1>,
): (a: unknown, b: unknown) => number {
  const keys = Object.entries(sort);
  return (a, b) => {
    for (const [key, direction] of keys) {
      const order = compareValues(getPath(a, key), getPath(b, key));
      if (order !== 0) return order * direction;
    }
    return 0;
  };
}

// A copy of the document with only the projected fields (or without the
// excluded ones). Top-level names only; a dotted path keeps its top-level
// field whole. _id always comes along.
export function project<T extends Doc>(
  doc: T,
  projection: Projection | undefined,
): T {
  if (!projection) return doc;
  const entries = Object.entries(projection);
  if (entries.length === 0) return doc;
  const including = entries.some(([, value]) => !!value);
  const names = new Set(entries.map(([key]) => key.split(".")[0] ?? key));
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "_id" || names.has(key) === including) copy[key] = value;
  }
  return copy as T;
}

// Which top-level fields differ between two documents, with the new values
// (undefined for a field that's gone), as observeChanges reports them.
function changedFields<T extends Doc>(before: T, after: T): Partial<T> {
  const fields: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "_id") continue;
    const next = (after as Record<string, unknown>)[key];
    if (!EJSON.equals((before as Record<string, unknown>)[key], next)) {
      fields[key] = next;
    }
  }
  return fields as Partial<T>;
}

interface Observer<T extends Doc> {
  selector: Selector;
  projection: Projection | undefined;
  seen: Map<string, T>;
  onAdded: (doc: T) => void;
  onChanged: (doc: T, old: T) => void;
  onRemoved: (old: T) => void;
}

export class Cursor<T extends Doc> {
  constructor(
    private readonly collection: Collection<T>,
    private readonly selector: Selector,
    private readonly options: FindOptions,
  ) {}

  fetch(): T[] {
    return this.collection.query(this.selector, this.options);
  }

  map<R>(fn: (doc: T, index: number) => R): R[] {
    return this.fetch().map(fn);
  }

  forEach(fn: (doc: T, index: number) => void): void {
    this.fetch().forEach(fn);
  }

  count(): number {
    return this.fetch().length;
  }

  // Calls added for every match now, then follows the collection. Sorts and
  // limits aren't applied to what's observed.
  observe(callbacks: ObserveCallbacks<T>): ObserveHandle {
    return this.collection.observe({
      selector: this.selector,
      projection: this.options.projection ?? this.options.fields,
      seen: new Map(),
      onAdded: (doc) => callbacks.added?.(doc),
      onChanged: (doc, old) => callbacks.changed?.(doc, old),
      onRemoved: (old) => callbacks.removed?.(old),
    });
  }

  observeChanges(callbacks: ObserveChangesCallbacks<T>): ObserveHandle {
    return this.collection.observe({
      selector: this.selector,
      projection: this.options.projection ?? this.options.fields,
      seen: new Map(),
      onAdded: (doc) => {
        const { _id, ...fields } = doc;
        callbacks.added?.(_id, fields as Partial<T>);
      },
      onChanged: (doc, old) => {
        const fields = changedFields(old, doc);
        if (Object.keys(fields).length > 0)
          callbacks.changed?.(doc._id, fields);
      },
      onRemoved: (old) => callbacks.removed?.(old._id),
    });
  }
}

export class Collection<T extends Doc> implements Dependency {
  version = 0;
  private docs = new Map<string, T>();
  private listeners = new Set<() => void>();
  private observers = new Set<Observer<T>>();

  constructor(public readonly name: string) {}

  // Every document, in insertion order, without noting the read
  all(): T[] {
    return [...this.docs.values()];
  }

  size(): number {
    return this.docs.size;
  }

  find(selector: Selector = {}, options: FindOptions = {}): Cursor<T> {
    return new Cursor(this, selector, options);
  }

  findOne(
    selector: string | Selector = {},
    options: FindOptions = {},
  ): T | undefined {
    noteRead(this);
    if (typeof selector === "string") {
      const doc = this.docs.get(selector);
      return doc && project(doc, options.projection ?? options.fields);
    }
    return this.query(selector, { ...options, limit: 1 })[0];
  }

  query(selector: Selector, options: FindOptions): T[] {
    noteRead(this);
    let found: T[] = [];
    if (typeof selector._id === "string") {
      const doc = this.docs.get(selector._id);
      if (doc && matches(doc, selector)) found.push(doc);
    } else {
      for (const doc of this.docs.values()) {
        if (matches(doc, selector)) found.push(doc);
      }
    }
    if (options.sort) found.sort(compareBySort(options.sort));
    if (options.skip) found = found.slice(options.skip);
    if (options.limit !== undefined) found = found.slice(0, options.limit);
    const projection = options.projection ?? options.fields;
    return projection ? found.map((doc) => project(doc, projection)) : found;
  }

  // Puts a document in, replacing any under its id. A document marked
  // deleted (a soft delete) takes it out instead.
  set(doc: T): void {
    if ((doc as { deleted?: unknown }).deleted === true) {
      this.remove(doc._id);
      return;
    }
    const old = this.docs.get(doc._id);
    this.docs.set(doc._id, doc);
    for (const observer of this.observers) this.notice(observer, old, doc);
    this.changed();
  }

  remove(id: string): void {
    const old = this.docs.get(id);
    if (!old) return;
    this.docs.delete(id);
    for (const observer of this.observers)
      this.notice(observer, old, undefined);
    this.changed();
  }

  // Replaces everything, as a snapshot does, notifying once.
  replaceAll(docs: T[]): void {
    const next = new Map<string, T>();
    for (const doc of docs) {
      if ((doc as { deleted?: unknown }).deleted !== true)
        next.set(doc._id, doc);
    }
    const old = this.docs;
    this.docs = next;
    for (const observer of this.observers) {
      for (const [id, doc] of old) {
        if (!next.has(id)) this.notice(observer, doc, undefined);
      }
      for (const [id, doc] of next) this.notice(observer, old.get(id), doc);
    }
    this.changed();
  }

  clear(): void {
    this.replaceAll([]);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  observe(observer: Observer<T>): ObserveHandle {
    this.observers.add(observer);
    for (const doc of this.docs.values()) this.notice(observer, undefined, doc);
    return {
      stop: () => {
        this.observers.delete(observer);
      },
    };
  }

  private notice(
    observer: Observer<T>,
    old: T | undefined,
    doc: T | undefined,
  ) {
    const wasIn = old !== undefined && observer.seen.has(old._id);
    const isIn = doc !== undefined && matches(doc, observer.selector);
    const id = (doc ?? old)?._id;
    if (id === undefined) return;
    if (isIn) {
      const shown = project(doc, observer.projection);
      const before = observer.seen.get(id);
      observer.seen.set(id, shown);
      if (!wasIn || !before) observer.onAdded(shown);
      else if (!EJSON.equals(before, shown)) observer.onChanged(shown, before);
    } else if (wasIn) {
      const before = observer.seen.get(id);
      observer.seen.delete(id);
      if (before) observer.onRemoved(before);
    }
  }

  private changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
