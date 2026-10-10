import type { Collection, Document, Filter, FindCursor, Sort } from "mongodb";

// What every collection holds as far as the driver's types are concerned:
// documents keyed by a string id (the driver assumes ObjectId otherwise)
export type StoredDocument = Document & { _id: string };

export interface FindOptions {
  projection?: Document | undefined;
  sort?: Sort | undefined;
  limit?: number | undefined;
  skip?: number | undefined;
}

// A query that hasn't run yet, with the async read methods of a Meteor
// cursor. Each read opens a fresh driver cursor, so a TypedCursor can be
// read more than once.
export class TypedCursor<T> {
  constructor(
    private readonly collection: () => Collection<StoredDocument>,
    private readonly filter: Filter<StoredDocument>,
    private readonly options: FindOptions = {},
  ) {}

  private raw(): FindCursor<T> {
    const { projection, sort, limit, skip } = this.options;
    return this.collection().find(this.filter, {
      ...(projection ? { projection } : {}),
      ...(sort ? { sort } : {}),
      ...(limit ? { limit } : {}),
      ...(skip ? { skip } : {}),
    }) as unknown as FindCursor<T>;
  }

  fetchAsync(): Promise<T[]> {
    return this.raw().toArray();
  }

  async mapAsync<U>(
    callback: (doc: T, index: number, cursor: this) => U | Promise<U>,
  ): Promise<U[]> {
    const results: U[] = [];
    let index = 0;
    for await (const doc of this.raw()) {
      results.push(await callback(doc, index, this));
      index += 1;
    }
    return results;
  }

  async forEachAsync(
    callback: (doc: T, index: number, cursor: this) => unknown,
  ): Promise<void> {
    let index = 0;
    for await (const doc of this.raw()) {
      await callback(doc, index, this);
      index += 1;
    }
  }

  countAsync(): Promise<number> {
    const { limit, skip } = this.options;
    return this.collection().countDocuments(this.filter, {
      ...(limit ? { limit } : {}),
      ...(skip ? { skip } : {}),
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.raw()[Symbol.asyncIterator]();
  }
}
