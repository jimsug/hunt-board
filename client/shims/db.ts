// What the browser gets in place of lib/db.ts (see vite.config.ts). The
// models are built at import time and only touch the database when a query
// runs, which nothing in the client does.

export function connect(): never {
  throw new Error("There is no database in the browser");
}

export function db(): never {
  throw new Error("There is no database in the browser");
}

export async function disconnect(): Promise<void> {}
