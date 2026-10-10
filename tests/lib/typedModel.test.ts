import { afterAll, beforeAll, describe, it } from "bun:test";
import { assert } from "chai";
import { Random } from "lib/compat/random";
import { connect, disconnect } from "lib/db";
import { foreignKey, nonEmptyString } from "lib/typedModel/customTypes";
import ensureIndexes from "lib/typedModel/ensureIndexes";
import Model, { resetClock, setClock } from "lib/typedModel/Model";
import { Id } from "lib/typedModel/regexes";
import SoftDeletedModel from "lib/typedModel/SoftDeletedModel";
import { withUser } from "lib/typedModel/userContext";
import { ModelValidationError } from "lib/typedModel/validateWrite";
import withCommon from "lib/typedModel/withCommon";
import { z } from "zod";

const MONGO_URL =
  process.env.MONGO_URL ?? "mongodb://127.0.0.1:27217/huntboard";

const user = Random.id();
const hunt = Random.id();
const asUser = <T>(fn: () => Promise<T>) => withUser(user, fn);

const Things = new Model(
  "test_things",
  withCommon(
    z.object({
      hunt: foreignKey,
      name: nonEmptyString,
      // Only some things have a nickname; the ones that don't must not
      // collide on the unique index over it
      nick: nonEmptyString.optional(),
      count: z.int32().nonnegative().default(0),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      labels: nonEmptyString.array().default([]),
    }),
  ),
);
Things.addIndex({ hunt: 1, name: 1 }, { unique: true });
Things.addIndex(
  { hunt: 1, nick: 1 },
  { unique: true, partialFilterExpression: { nick: { $exists: true } } },
);

const Notes = new SoftDeletedModel(
  "test_notes",
  withCommon(z.object({ hunt: foreignKey, text: nonEmptyString })),
);
Notes.addIndex({ deleted: 1, hunt: 1 });

const rejects = async (
  promise: Promise<unknown>,
  type: new (...args: any[]) => Error = ModelValidationError,
) => {
  try {
    await promise;
  } catch (error) {
    assert.instanceOf(error, type);
    return error as Error;
  }
  assert.fail(`expected a ${type.name}`);
};

describe("typedModel over the Mongo driver", () => {
  beforeAll(async () => {
    const db = await connect(MONGO_URL);
    await Promise.all(
      [Things, Notes].map((model) =>
        db
          .collection(model.name)
          .drop()
          .catch(() => undefined),
      ),
    );
    await ensureIndexes([Things, Notes], { info() {}, warn() {} });
  });
  afterAll(async () => {
    resetClock();
    await disconnect();
  });

  describe("insert", () => {
    it("stamps the common fields, applies defaults and generates an id", async () => {
      const now = new Date("2026-01-02T03:04:05Z");
      setClock(() => now);
      try {
        const id = await asUser(() =>
          Things.insertAsync({ hunt, name: "stamped" }),
        );
        assert.match(id, Id);
        const doc = await Things.findOneAsync(id);
        assert.deepEqual(doc, {
          _id: id,
          hunt,
          name: "stamped",
          count: 0,
          labels: [],
          createdAt: now,
          createdBy: user,
          updatedAt: now,
        });
      } finally {
        resetClock();
      }
    });

    it("keeps an id the caller gives", async () => {
      const _id = Random.id();
      const id = await asUser(() =>
        Things.insertAsync({ _id, hunt, name: "own id" }),
      );
      assert.equal(id, _id);
    });

    it("refuses a document that doesn't fit the schema", async () => {
      const error = await rejects(
        asUser(() => Things.insertAsync({ hunt, name: "" })),
      );
      assert.include(error.message, "test_things: name");
      assert.isUndefined(await Things.findOneAsync({ hunt, name: "" }));
    });

    it("refuses a field the schema doesn't know", async () => {
      await rejects(
        asUser(() =>
          Things.insertAsync({ hunt, name: "extra", bogus: 1 } as any),
        ),
      );
    });

    it("needs a user to stamp createdBy", async () => {
      const error = await rejects(Things.insertAsync({ hunt, name: "nobody" }));
      assert.include(error.message, "createdBy");
    });

    it("inserts many at once with ids and stamps", async () => {
      const ids = await asUser(() =>
        Things.insertManyAsync([
          { hunt, name: "many one" },
          { hunt, name: "many two", labels: ["x"] },
        ]),
      );
      assert.lengthOf(ids, 2);
      const docs = await Things.find({ _id: { $in: ids } }).fetchAsync();
      assert.sameMembers(
        docs.map((d) => d.name),
        ["many one", "many two"],
      );
      assert.ok(docs.every((d) => d.createdBy === user && d.createdAt));
    });

    it("inserts nothing for an empty list", async () => {
      assert.deepEqual(await Things.insertManyAsync([]), []);
    });
  });

  describe("update", () => {
    it("sets fields, stamps updatedAt and reports the match count", async () => {
      const id = await asUser(() => Things.insertAsync({ hunt, name: "upd" }));
      const before = (await Things.findOneAsync(id))?.updatedAt;
      const later = new Date(Date.now() + 60_000);
      setClock(() => later);
      try {
        const n = await asUser(() =>
          Things.updateAsync(id, { $set: { count: 3 } }),
        );
        assert.equal(n, 1);
      } finally {
        resetClock();
      }
      const doc = await Things.findOneAsync(id);
      assert.equal(doc?.count, 3);
      assert.equal(doc?.updatedBy, user);
      assert.notEqual(+doc!.updatedAt, +before!);
      assert.equal(+doc!.updatedAt, +later);
    });

    it("validates the fields being set", async () => {
      const id = await asUser(() => Things.insertAsync({ hunt, name: "bad" }));
      const error = await rejects(
        Things.updateAsync(id, { $set: { count: -1 } }),
      );
      assert.include(error.message, "count");
      await rejects(Things.updateAsync(id, { $set: { name: "" } }));
      await rejects(Things.updateAsync(id, { $set: { bogus: 1 } } as any));
      assert.equal((await Things.findOneAsync(id))?.count, 0);
    });

    it("validates a dotted path and a pushed element", async () => {
      const id = await asUser(() =>
        Things.insertAsync({ hunt, name: "dotted", position: { x: 1, y: 2 } }),
      );
      await Things.updateAsync(id, { $set: { "position.x": 5 } });
      assert.deepEqual((await Things.findOneAsync(id))?.position, {
        x: 5,
        y: 2,
      });
      await rejects(
        Things.updateAsync(id, { $set: { "position.x": "five" } } as any),
      );
      await Things.updateAsync(id, { $push: { labels: "ok" } });
      await rejects(Things.updateAsync(id, { $push: { labels: "" } }));
      await rejects(
        Things.updateAsync(id, { $addToSet: { labels: { $each: ["a", ""] } } }),
      );
      assert.deepEqual((await Things.findOneAsync(id))?.labels, ["ok"]);
    });

    it("updates one document unless multi is set", async () => {
      const scope = Random.id();
      await asUser(() =>
        Things.insertManyAsync([
          { hunt: scope, name: "m1" },
          { hunt: scope, name: "m2" },
        ]),
      );
      assert.equal(
        await Things.updateAsync({ hunt: scope }, { $set: { count: 1 } }),
        1,
      );
      assert.equal(
        await Things.updateAsync(
          { hunt: scope },
          { $set: { count: 2 } },
          { multi: true },
        ),
        2,
      );
      assert.equal(
        await Things.find({ hunt: scope, count: 2 }).countAsync(),
        2,
      );
    });

    it("upserts with a generated id and insert-time stamps", async () => {
      const scope = Random.id();
      const result = await asUser(() =>
        Things.upsertAsync(
          { hunt: scope, name: "upserted" },
          { $set: { count: 7 } },
        ),
      );
      assert.equal(result.numberAffected, 1);
      assert.match(result.insertedId ?? "", Id);
      const doc = await Things.findOneAsync(result.insertedId!);
      assert.equal(doc?.count, 7);
      assert.deepEqual(doc?.labels, []);
      assert.equal(doc?.createdBy, user);
      const again = await asUser(() =>
        Things.upsertAsync(
          { hunt: scope, name: "upserted" },
          { $set: { count: 8 } },
        ),
      );
      assert.equal(again.numberAffected, 1);
      assert.isUndefined(again.insertedId);
      assert.equal((await Things.findOneAsync(result.insertedId!))?.count, 8);
    });

    it("validates a replacement document", async () => {
      const id = await asUser(() =>
        Things.insertAsync({ hunt, name: "replaced" }),
      );
      await rejects(
        asUser(() => Things.updateAsync(id, { hunt, name: "" } as any)),
      );
      const existing = await Things.findOneAsync(id);
      await asUser(() =>
        Things.updateAsync(id, {
          ...existing!,
          name: "replacement",
        }),
      );
      assert.equal((await Things.findOneAsync(id))?.name, "replacement");
    });
  });

  describe("find", () => {
    const scope = Random.id();
    beforeAll(async () => {
      await asUser(() =>
        Things.insertManyAsync(
          ["c", "a", "b"].map((name, i) => ({ hunt: scope, name, count: i })),
        ),
      );
    });

    it("fetches with a sort, limit and projection", async () => {
      const docs = await Things.find(
        { hunt: scope },
        { sort: { name: 1 }, limit: 2, projection: { name: 1 } },
      ).fetchAsync();
      assert.deepEqual(
        docs.map((d) => d.name),
        ["a", "b"],
      );
      assert.isUndefined(docs[0]?.count);
      assert.isDefined(docs[0]?._id);
    });

    it("maps, iterates and counts", async () => {
      const cursor = Things.find({ hunt: scope }, { sort: { count: -1 } });
      assert.deepEqual(await cursor.mapAsync((d) => d.name), ["b", "a", "c"]);
      const seen: string[] = [];
      await cursor.forEachAsync((d, i) => {
        seen.push(`${i}:${d.name}`);
      });
      assert.deepEqual(seen, ["0:b", "1:a", "2:c"]);
      assert.equal(await cursor.countAsync(), 3);
      assert.equal(
        await Things.find({ hunt: scope }, { limit: 2 }).countAsync(),
        2,
      );
      assert.equal(await Things.find({ hunt: Random.id() }).countAsync(), 0);
    });

    it("finds one by id or by query", async () => {
      const a = await Things.findOneAsync({ hunt: scope, name: "a" });
      assert.equal(a?.count, 1);
      assert.equal((await Things.findOneAsync(a!._id))?.name, "a");
      assert.isUndefined(await Things.findOneAsync(Random.id()));
      const last = await Things.findOneAsync(
        { hunt: scope },
        { sort: { count: -1 }, projection: { count: 1 } },
      );
      assert.equal(last?.count, 2);
    });

    it("removes by selector", async () => {
      const id = await asUser(() =>
        Things.insertAsync({ hunt: scope, name: "gone" }),
      );
      assert.equal(await Things.removeAsync(id), 1);
      assert.isUndefined(await Things.findOneAsync(id));
      assert.equal(await Things.removeAsync({ hunt: scope, name: "gone" }), 0);
    });
  });

  describe("indexes", () => {
    it("has the declared indexes and nothing else", async () => {
      const names = (await Things.rawCollection().listIndexes().toArray()).map(
        (index) => index.name,
      );
      assert.sameMembers(names, ["_id_", "hunt_1_name_1", "hunt_1_nick_1"]);
    });

    it("refuses a duplicate under a unique index", async () => {
      const scope = Random.id();
      await asUser(() => Things.insertAsync({ hunt: scope, name: "once" }));
      const error = await rejects(
        asUser(() => Things.insertAsync({ hunt: scope, name: "once" })),
        Error,
      );
      assert.include(error.message, "E11000");
    });

    it("lets documents without the field through a partial unique index", async () => {
      const scope = Random.id();
      await asUser(() =>
        Things.insertManyAsync([
          { hunt: scope, name: "no nick 1" },
          { hunt: scope, name: "no nick 2" },
          { hunt: scope, name: "nick 1", nick: "n" },
        ]),
      );
      await rejects(
        asUser(() =>
          Things.insertAsync({ hunt: scope, name: "nick 2", nick: "n" }),
        ),
        Error,
      );
      assert.equal(await Things.find({ hunt: scope }).countAsync(), 3);
    });

    it("drops an index that is no longer declared", async () => {
      await Things.rawCollection().createIndex({ count: 1 });
      await ensureIndexes([Things], { info() {}, warn() {} });
      const names = (await Things.rawCollection().listIndexes().toArray()).map(
        (index) => index.name,
      );
      assert.notInclude(names, "count_1");
    });
  });

  describe("soft deletion", () => {
    it("hides destroyed documents from find and shows them to findDeleted", async () => {
      const scope = Random.id();
      const [keep, gone] = await asUser(() =>
        Notes.insertManyAsync([
          { hunt: scope, text: "keep" },
          { hunt: scope, text: "gone" },
        ]),
      );
      assert.equal(await Notes.destroyAsync(gone!), 1);
      assert.deepEqual(
        await Notes.find({ hunt: scope }).mapAsync((n) => n.text),
        ["keep"],
      );
      assert.isUndefined(await Notes.findOneAsync(gone!));
      assert.deepEqual(
        await Notes.findDeleted({ hunt: scope }).mapAsync((n) => n.text),
        ["gone"],
      );
      assert.equal(
        await Notes.findAllowingDeleted({ hunt: scope }).countAsync(),
        2,
      );
      assert.equal(
        (await Notes.findOneAllowingDeletedAsync(gone!))?.deleted,
        true,
      );
      assert.equal((await Notes.findOneDeletedAsync(gone!))?.text, "gone");
      assert.isUndefined(await Notes.findOneDeletedAsync(keep!));
      assert.equal(await Notes.undestroyAsync(gone!), 1);
      assert.equal(await Notes.find({ hunt: scope }).countAsync(), 2);
    });

    it("keeps deleted in a projection so the hidden flag is readable", async () => {
      const id = await asUser(() => Notes.insertAsync({ hunt, text: "proj" }));
      const doc = await Notes.findOneAsync(id, { projection: { text: 1 } });
      assert.deepEqual(doc as unknown, {
        _id: id,
        text: "proj",
        deleted: false,
      });
    });
  });
});
