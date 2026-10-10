import { type Db, MongoClient } from "mongodb";

// The one connection the process holds. Models look their collections up
// through db() on each call, so they can be built at import time and used
// once connect() has run.
let client: MongoClient | undefined;
let database: Db | undefined;

export async function connect(url: string): Promise<Db> {
  if (client) {
    throw new Error("Already connected");
  }
  // Meteor's driver drops undefined fields rather than writing them as null,
  // and the models' optional fields rely on that: an unset field is absent.
  // It also handed binary fields back as Uint8Arrays, where the driver's
  // own Binary would trip Buffer.concat on a version's chunks.
  client = new MongoClient(url, {
    ignoreUndefined: true,
    promoteBuffers: true,
  });
  await client.connect();
  database = client.db();
  return database;
}

export function db(): Db {
  if (!database) {
    throw new Error("Not connected to Mongo: call connect(url) first");
  }
  return database;
}

export async function disconnect(): Promise<void> {
  const closing = client;
  client = undefined;
  database = undefined;
  await closing?.close();
}
