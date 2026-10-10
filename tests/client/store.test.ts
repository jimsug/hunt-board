import { describe, expect, it } from "bun:test";
import { Collection } from "../../client/store/collection";
import { Cell } from "../../client/store/tracker";
import { createTrackerStore } from "../../client/store/useTracker";

// The client's in-memory collections: the queries the board's hooks make,
// the sorts they ask for, and the tracker that re-runs them on change.

interface Doc {
  _id: string;
  board?: string;
  type?: string;
  tags?: string[];
  n?: number;
  at?: Date;
  nested?: { kind?: string };
  content?: { children: { text: string }[] };
  deleted?: boolean;
}

const fill = (docs: Doc[]) => {
  const collection = new Collection<Doc>("docs");
  for (const doc of docs) collection.set(doc);
  return collection;
};

const ids = (docs: Doc[]) => docs.map((d) => d._id);

describe("Collection.find", () => {
  const docs = fill([
    { _id: "a", board: "b1", type: "frame", n: 3, tags: ["x", "y"] },
    { _id: "b", board: "b1", type: "puzzle", n: 1, tags: ["y"] },
    { _id: "c", board: "b2", type: "ink", n: 2, nested: { kind: "k" } },
    { _id: "d", board: "b1", n: 10 },
  ]);

  it("matches equality, with an array field holding the value", () => {
    expect(ids(docs.find({ board: "b1" }).fetch())).toEqual(["a", "b", "d"]);
    expect(ids(docs.find({ tags: "y" }).fetch())).toEqual(["a", "b"]);
    expect(ids(docs.find({ tags: ["y"] }).fetch())).toEqual(["b"]);
  });

  it("matches $in, $nin and $ne, missing fields included", () => {
    expect(ids(docs.find({ type: { $in: ["frame", "ink"] } }).fetch())).toEqual(
      ["a", "c"],
    );
    expect(ids(docs.find({ type: { $nin: ["frame"] } }).fetch())).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(ids(docs.find({ type: { $ne: "puzzle" } }).fetch())).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(ids(docs.find({ _id: { $in: ["d", "zz"] } }).fetch())).toEqual([
      "d",
    ]);
  });

  it("matches $exists and dotted paths", () => {
    expect(ids(docs.find({ type: { $exists: true } }).fetch())).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(docs.find({ type: { $exists: false } }).fetch())).toEqual(["d"]);
    expect(ids(docs.find({ "nested.kind": "k" }).fetch())).toEqual(["c"]);
    expect(
      ids(docs.find({ "nested.kind": { $exists: false } }).fetch()),
    ).toEqual(["a", "b", "d"]);
  });

  it("compares numbers and dates with $gt and $lt", () => {
    expect(ids(docs.find({ n: { $gt: 2 } }).fetch())).toEqual(["a", "d"]);
    expect(ids(docs.find({ n: { $lt: 2 } }).fetch())).toEqual(["b"]);
    expect(ids(docs.find({ n: { $gte: 2, $lte: 3 } }).fetch())).toEqual([
      "a",
      "c",
    ]);
    const dated = fill([
      { _id: "old", at: new Date(1000) },
      { _id: "new", at: new Date(2000) },
      { _id: "none" },
    ]);
    expect(ids(dated.find({ at: { $gt: new Date(1500) } }).fetch())).toEqual([
      "new",
    ]);
    expect(ids(dated.find({ at: { $lt: new Date(1500) } }).fetch())).toEqual([
      "old",
    ]);
  });

  it("combines $or and $and", () => {
    expect(
      ids(docs.find({ $or: [{ type: "frame" }, { n: 10 }] }).fetch()),
    ).toEqual(["a", "d"]);
    expect(
      ids(docs.find({ $and: [{ board: "b1" }, { n: { $lt: 5 } }] }).fetch()),
    ).toEqual(["a", "b"]);
  });

  it("refuses an operator it doesn't know", () => {
    expect(() => docs.find({ n: { $regex: "x" } }).fetch()).toThrow(
      /Unsupported query operator \$regex/,
    );
  });

  it("sorts by one field either way, missing values first", () => {
    expect(ids(docs.find({}, { sort: { n: 1 } }).fetch())).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(ids(docs.find({}, { sort: { n: -1 } }).fetch())).toEqual([
      "d",
      "a",
      "c",
      "b",
    ]);
    expect(ids(docs.find({}, { sort: { type: 1, n: -1 } }).fetch())).toEqual([
      "d",
      "a",
      "c",
      "b",
    ]);
  });

  it("sorts dates, as versions and comments are sorted", () => {
    const dated = fill([
      { _id: "mid", at: new Date(1500) },
      { _id: "old", at: new Date(1000) },
      { _id: "new", at: new Date(2000) },
    ]);
    expect(ids(dated.find({}, { sort: { at: 1 } }).fetch())).toEqual([
      "old",
      "mid",
      "new",
    ]);
    expect(ids(dated.find({}, { sort: { at: -1 } }).fetch())).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("applies limit and skip after the sort", () => {
    expect(
      ids(docs.find({}, { sort: { n: 1 }, skip: 1, limit: 2 }).fetch()),
    ).toEqual(["c", "a"]);
  });

  it("projects to the named fields, keeping _id, under either name", () => {
    expect(docs.find({ _id: "a" }, { projection: { n: 1 } }).fetch()).toEqual([
      { _id: "a", n: 3 },
    ]);
    expect(docs.find({ _id: "a" }, { fields: { type: 1 } }).fetch()).toEqual([
      { _id: "a", type: "frame" },
    ]);
    expect(
      docs.find({ _id: "a" }, { projection: { tags: 0, n: 0 } }).fetch(),
    ).toEqual([{ _id: "a", board: "b1", type: "frame" }]);
  });

  it("hands back the stored document itself without a projection", () => {
    const [found] = docs.find({ _id: "a" }).fetch();
    expect(found).toBe(docs.findOne("a"));
  });

  it("counts, maps and iterates", () => {
    expect(docs.find({ board: "b1" }).count()).toBe(3);
    expect(docs.find({ board: "b2" }).map((d) => d._id)).toEqual(["c"]);
    const seen: string[] = [];
    docs.find({ n: { $gt: 2 } }).forEach((d) => seen.push(d._id));
    expect(seen).toEqual(["a", "d"]);
  });
});

describe("Collection.findOne", () => {
  const docs = fill([
    { _id: "a", n: 1 },
    { _id: "b", n: 2 },
  ]);

  it("takes an id or a selector", () => {
    expect(docs.findOne("b")?.n).toBe(2);
    expect(docs.findOne({ n: 1 })?._id).toBe("a");
    expect(docs.findOne("zz")).toBeUndefined();
    expect(docs.findOne({ n: 3 })).toBeUndefined();
  });
});

describe("Collection changes", () => {
  it("removes a document marked deleted, and one removed outright", () => {
    const docs = fill([{ _id: "a" }, { _id: "b" }]);
    docs.set({ _id: "a", deleted: true });
    expect(ids(docs.find().fetch())).toEqual(["b"]);
    docs.remove("b");
    expect(docs.size()).toBe(0);
  });

  it("replaces everything with a snapshot, leaving deleted ones out", () => {
    const docs = fill([{ _id: "a" }, { _id: "b" }]);
    docs.replaceAll([
      { _id: "b", n: 1 },
      { _id: "c" },
      { _id: "d", deleted: true },
    ]);
    expect(ids(docs.find().fetch())).toEqual(["b", "c"]);
    expect(docs.findOne("b")?.n).toBe(1);
  });

  it("tells subscribers once per change and bumps its version", () => {
    const docs = new Collection<Doc>("docs");
    let told = 0;
    const stop = docs.subscribe(() => {
      told += 1;
    });
    const before = docs.version;
    docs.set({ _id: "a" });
    docs.replaceAll([{ _id: "b" }, { _id: "c" }]);
    docs.remove("zz");
    expect(told).toBe(2);
    expect(docs.version).toBe(before + 2);
    stop();
    docs.set({ _id: "d" });
    expect(told).toBe(2);
  });

  it("observes additions, changes and removals that match the selector", () => {
    const docs = fill([{ _id: "a", board: "b1", n: 1 }]);
    const events: string[] = [];
    const handle = docs.find({ board: "b1" }).observe({
      added: (doc) => events.push(`added ${doc._id}`),
      changed: (doc, old) =>
        events.push(`changed ${doc._id} ${old.n}->${doc.n}`),
      removed: (doc) => events.push(`removed ${doc._id}`),
    });
    docs.set({ _id: "a", board: "b1", n: 2 });
    docs.set({ _id: "b", board: "b2" });
    docs.set({ _id: "b", board: "b1" });
    docs.set({ _id: "b", board: "b2" });
    docs.remove("a");
    handle.stop();
    docs.set({ _id: "c", board: "b1" });
    expect(events).toEqual([
      "added a",
      "changed a 1->2",
      "added b",
      "removed b",
      "removed a",
    ]);
  });

  it("reports the fields that changed to observeChanges, projected", () => {
    const docs = fill([{ _id: "a", n: 1, type: "x" }]);
    const events: unknown[] = [];
    docs.find({}, { fields: { n: 1 } }).observeChanges({
      added: (id, fields) => events.push(["added", id, fields]),
      changed: (id, fields) => events.push(["changed", id, fields]),
      removed: (id) => events.push(["removed", id]),
    });
    docs.set({ _id: "a", n: 1, type: "y" });
    docs.set({ _id: "a", n: 5, type: "y" });
    docs.set({ _id: "a", type: "y" });
    docs.set({ _id: "a", deleted: true });
    expect(events).toEqual([
      ["added", "a", { n: 1 }],
      ["changed", "a", { n: 5 }],
      ["changed", "a", { n: undefined }],
      ["removed", "a"],
    ]);
  });
});

describe("dotted paths through arrays", () => {
  const docs = fill([
    { _id: "a", content: { children: [{ text: "hello" }, { text: "there" }] } },
    { _id: "b", content: { children: [{ text: "bye" }] } },
    { _id: "c", content: { children: [] } },
  ]);
  it("matches any element's field, as Mongo does", () => {
    expect(
      ids(docs.find({ "content.children.text": "there" }).fetch()),
    ).toEqual(["a"]);
    expect(
      ids(
        docs.find({ "content.children.text": { $in: ["bye", "x"] } }).fetch(),
      ),
    ).toEqual(["b"]);
    expect(
      ids(docs.find({ "content.children.0.text": "hello" }).fetch()),
    ).toEqual(["a"]);
  });
  it("reads $ne and $exists against every element", () => {
    expect(
      ids(docs.find({ "content.children.text": { $ne: "hello" } }).fetch()),
    ).toEqual(["b", "c"]);
    expect(
      ids(docs.find({ "content.children.text": { $exists: false } }).fetch()),
    ).toEqual(["c"]);
    expect(
      ids(docs.find({ "content.children.text": { $exists: true } }).fetch()),
    ).toEqual(["a", "b"]);
  });
});

describe("createTrackerStore", () => {
  it("runs again when a collection it read changes, and not otherwise", () => {
    const docs = fill([{ _id: "a", n: 1 }]);
    const other = fill([{ _id: "z" }]);
    let runs = 0;
    const store = createTrackerStore(() => {
      runs += 1;
      return docs.find({}, { sort: { n: 1 } }).fetch();
    });
    let told = 0;
    const stop = store.subscribe(() => {
      told += 1;
    });
    expect(ids(store.getSnapshot())).toEqual(["a"]);
    expect(runs).toBe(1);
    other.set({ _id: "y" });
    expect(told).toBe(0);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    docs.set({ _id: "b", n: 0 });
    expect(told).toBe(1);
    expect(ids(store.getSnapshot())).toEqual(["b", "a"]);
    expect(runs).toBe(2);
    stop();
  });

  it("keeps the old result when the new one is the same by value", () => {
    const docs = fill([{ _id: "a", n: 1 }]);
    const store = createTrackerStore(() =>
      docs.find({}, { projection: { n: 1 } }).fetch(),
    );
    store.subscribe(() => {});
    const first = store.getSnapshot();
    docs.set({ _id: "a", n: 1, type: "touched" });
    expect(store.getSnapshot()).toBe(first);
    docs.set({ _id: "a", n: 2 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot()[0]?.n).toBe(2);
  });

  it("hands on a new Map or Set rather than reading them as equal", () => {
    const docs = fill([{ _id: "a", n: 1 }]);
    const store = createTrackerStore(
      () =>
        new Map(
          docs
            .find()
            .fetch()
            .map((doc) => [doc._id, doc.n]),
        ),
    );
    store.subscribe(() => {});
    const first = store.getSnapshot();
    expect(first.get("a")).toBe(1);
    docs.set({ _id: "a", n: 2 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().get("a")).toBe(2);
  });

  it("takes a comparator of its own", () => {
    const docs = fill([{ _id: "a", n: 1 }]);
    const store = createTrackerStore(
      () => docs.find().count(),
      (previous, next) => Math.abs(previous - next) < 2,
    );
    store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(1);
    docs.set({ _id: "b" });
    expect(store.getSnapshot()).toBe(1);
    docs.set({ _id: "c" });
    expect(store.getSnapshot()).toBe(3);
  });

  it("notices a change made before anyone subscribed", () => {
    const cell = new Cell(1);
    const store = createTrackerStore(() => cell.get() * 10);
    expect(store.getSnapshot()).toBe(10);
    cell.set(2);
    expect(store.getSnapshot()).toBe(20);
  });

  it("follows what the latest run read", () => {
    const which = new Cell<"a" | "b">("a");
    const a = new Cell(1);
    const b = new Cell(100);
    const store = createTrackerStore(() =>
      which.get() === "a" ? a.get() : b.get(),
    );
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    expect(store.getSnapshot()).toBe(1);
    which.set("b");
    expect(store.getSnapshot()).toBe(100);
    a.set(2);
    expect(told).toBe(1);
    b.set(101);
    expect(told).toBe(2);
    expect(store.getSnapshot()).toBe(101);
  });
});
