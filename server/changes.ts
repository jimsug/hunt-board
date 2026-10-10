import { EventEmitter } from "node:events";
import BoardComments from "lib/models/BoardComments";
import Puzzles from "lib/models/Puzzles";
import Tags from "lib/models/Tags";
import WhiteboardEdges from "lib/models/WhiteboardEdges";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import Whiteboards from "lib/models/Whiteboards";
import WhiteboardVersions from "lib/models/WhiteboardVersions";
import type { StoredDocument } from "lib/typedModel/cursor";
import type Model from "lib/typedModel/Model";
import { normalizeSelector } from "lib/typedModel/Model";

// The seam between the writes and the rooms. Jolly Roger's publications
// watched the collections; here every write through a watched model ends by
// calling notify with the document as the write left it (or null once it's
// gone), and the room layer subscribes to send each one down as a `change`.
// A soft delete is a change whose doc has deleted: true.

export interface Change {
  collection: string;
  id: string;
  doc: StoredDocument | null;
}
type Listener = (change: Change) => void;

const changes = new EventEmitter();
changes.setMaxListeners(0);

export function notify(
  collection: string,
  id: string,
  doc: StoredDocument | null,
) {
  changes.emit("change", { collection, id, doc } satisfies Change);
}

// Hears every change until the returned function is called.
export function onChange(listener: Listener): () => void {
  changes.on("change", listener);
  return () => {
    changes.off("change", listener);
  };
}

const watched = new Set<Model<any, any>>();

type AnyModel = Model<any, any>;

// Wraps the model's writes so each one notifies the documents it touched,
// read back after the write so what goes out is what's stored. An update
// finds the documents its selector matches first, since a selector that
// doesn't pin an id says nothing about which were written.
export function watchModel(model: AnyModel) {
  if (watched.has(model)) return;
  watched.add(model);
  const collection = () => model.rawCollection();
  const idsMatching = async (selector: unknown) =>
    (
      await collection()
        .find(normalizeSelector(selector as never), { projection: { _id: 1 } })
        .toArray()
    ).map((doc) => doc._id as string);
  const emit = async (ids: string[]) => {
    if (ids.length === 0) return;
    const docs = await collection()
      .find({ _id: { $in: ids } } as never)
      .toArray();
    const byId = new Map(docs.map((doc) => [doc._id as string, doc]));
    for (const id of ids) {
      notify(model.name, id, (byId.get(id) as StoredDocument) ?? null);
    }
  };

  const insertAsync = model.insertAsync.bind(model);
  model.insertAsync = async (doc) => {
    const id = await insertAsync(doc);
    await emit([id]);
    return id;
  };
  const insertManyAsync = model.insertManyAsync.bind(model);
  model.insertManyAsync = async (docs) => {
    const ids = await insertManyAsync(docs);
    await emit(ids);
    return ids;
  };
  const updateAsync = model.updateAsync.bind(model);
  model.updateAsync = async (selector, mod, options = {}) => {
    const filter = normalizeSelector(selector as never);
    const before =
      typeof filter._id === "string" ? [filter._id] : await idsMatching(filter);
    const affected = await updateAsync(selector, mod, options);
    // An upsert that inserted matches its own selector now
    const ids =
      before.length === 0 && options.upsert
        ? await idsMatching(filter)
        : before;
    await emit(ids);
    return affected;
  };
  const upsertAsync = model.upsertAsync.bind(model);
  model.upsertAsync = async (selector, mod, options = {}) => {
    const filter = normalizeSelector(selector as never);
    const before =
      typeof filter._id === "string" ? [filter._id] : await idsMatching(filter);
    const result = await upsertAsync(selector, mod, options);
    await emit(result.insertedId ? [...before, result.insertedId] : before);
    return result;
  };
  const removeAsync = model.removeAsync.bind(model);
  model.removeAsync = async (selector) => {
    const ids = await idsMatching(selector);
    const removed = await removeAsync(selector);
    await emit(ids);
    return removed;
  };
}

// The collections a room sends down
for (const model of [
  Whiteboards,
  WhiteboardNodes,
  WhiteboardEdges,
  WhiteboardVersions,
  BoardComments,
  Puzzles,
  Tags,
]) {
  watchModel(model);
}
