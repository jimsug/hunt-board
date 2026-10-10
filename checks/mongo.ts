// Does the Mongo driver behave under Bun: connect, insert, update with
// $set/$unset, find with a projection and sort, aggregate, a unique index
// refusing a duplicate, and a clean close.
import { MongoClient } from "mongodb";

const url = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27217/huntboard";
const client = new MongoClient(url);
await client.connect();
const db = client.db();
const nodes = db.collection("nodes");
await nodes.drop().catch(() => undefined);
await nodes.createIndex({ board: 1, puzzle: 1 }, { unique: true, partialFilterExpression: { puzzle: { $type: "string" } } });

const { insertedId } = await nodes.insertOne({ _id: "n1" as never, board: "b", type: "sticky", position: { x: 1, y: 2 }, text: "hi" });
await nodes.insertMany([
  { _id: "n2" as never, board: "b", type: "puzzle", puzzle: "p1", position: { x: 0, y: 0 } },
  { _id: "n3" as never, board: "b", type: "frame", position: { x: 9, y: 9 }, width: 400, height: 300 },
]);
const dup = await nodes.insertOne({ _id: "n4" as never, board: "b", type: "puzzle", puzzle: "p1", position: { x: 0, y: 0 } }).then(() => "accepted", (e: Error) => (e.message.includes("E11000") ? "refused" : e.message));
const upd = await nodes.updateOne({ _id: "n1" as never, board: "b" }, { $set: { position: { x: 5, y: 6 } }, $unset: { text: "" } });
const found = await nodes.find({ board: "b" }, { projection: { type: 1, position: 1 } }).sort({ _id: 1 }).toArray();
const agg = await nodes.aggregate([{ $match: { board: "b" } }, { $group: { _id: "$type", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
const bulk = await nodes.bulkWrite([
  { updateOne: { filter: { _id: "n3" as never }, update: { $set: { width: 500 } } } },
  { deleteOne: { filter: { _id: "n2" as never } } },
]);
console.log(JSON.stringify({ insertedId, dup, modified: upd.modifiedCount, found, agg, bulk: { modified: bulk.modifiedCount, deleted: bulk.deletedCount } }, null, 1));
await client.close();
