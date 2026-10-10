import type { Collection, Document, Filter, UpdateFilter } from "mongodb";
import { z } from "zod";
import type {
  $ZodObjectConfig,
  $ZodShape,
  input,
  output,
  util,
} from "zod/v4/core";
import { Random } from "../compat/random";
import { db } from "../db";
import {
  type AutoPopulate,
  collectSchemaMetadata,
  type IsAutoPopulated,
} from "./autoPopulate";
import { type FindOptions, type StoredDocument, TypedCursor } from "./cursor";
import { stringId } from "./customTypes";
import {
  type IndexOptions,
  type IndexSpecification,
  type ModelIndexSpecification,
  normalizeIndexOptions,
  normalizeIndexSpecification,
} from "./indexes";
import { currentUserId } from "./userContext";
import validateSchema from "./validateSchema";
import { validateDocument, validateModifier } from "./validateWrite";

export type SchemaWithId<
  Schema extends z.ZodType,
  IdSchema extends z.ZodType<string> = typeof stringId,
> =
  Schema extends z.ZodObject<
    infer Shape extends $ZodShape,
    infer Config extends $ZodObjectConfig
  >
    ? z.ZodObject<util.Extend<Shape, { _id: IdSchema }>, Config>
    : z.ZodIntersection<Schema, z.ZodObject<{ _id: IdSchema }>>;

export type ModelType<M extends { _docType: unknown }> = M["_docType"];
// The value a key can take across the members of a (possibly union) input
// type; distributes so that variant-specific keys resolve to whichever
// variant declares them
type InputProp<I, K> = I extends any
  ? K extends keyof I
    ? I[K]
    : never
  : never;

// Keys that are optional at insertion time: auto-populated fields (branded on
// the input side) and fields with a Zod .default() (optional in input but
// required in output). Computed against a single member O of the output type
type OptionalInsertKeys<I, O> = {
  [K in keyof O]: [InputProp<I, K>] extends [never]
    ? never
    : IsAutoPopulated<InputProp<I, K>> extends true
      ? K
      : undefined extends InputProp<I, K>
        ? undefined extends O[K]
          ? never
          : K
        : never;
}[keyof O];

type InsertMember<I, O> = util.Flatten<
  Omit<O, OptionalInsertKeys<I, O>> & Partial<Pick<O, OptionalInsertKeys<I, O>>>
>;

// Distribute over the members of a union output so that variant-specific
// fields survive (Omit over a union would collapse it to its common keys)
export type InsertModelType<S extends z.ZodType> =
  output<S> extends infer O
    ? O extends any
      ? InsertMember<input<S>, O>
      : never
    : never;

// A query: a Mongo filter, or an id (which Meteor took as {_id: id})
export type Selector<T> = Filter<T> | string;
// An update: Mongo operators, or a whole replacement document
export type Modifier<T> = UpdateFilter<T> | Partial<T>;
export type { FindOptions };

// Given a query, attempt to compute what the result of that query must be.
// Primarily intended to be useful for discriminated unions, so it does not
// attempt to fully resolve all cases.
export type SelectorToResultType<T, S extends Selector<T>> = S extends string
  ? T & { _id: S }
  : util.Flatten<
      T & { [K in keyof S & keyof T as S[K] extends T[K] ? K : never]: S[K] }
    >;

// Allow overriding time for testing
let clock: () => Date;
export function setClock(newClock: () => Date) {
  clock = newClock;
}
export function resetClock() {
  clock = () => new Date();
}
resetClock();

export function normalizeSelector<T>(
  selector: Selector<T> | undefined,
): Filter<StoredDocument> {
  if (selector === undefined) return {};
  if (typeof selector === "string") return { _id: selector };
  return selector as Filter<StoredDocument>;
}

export interface UpdateOptions {
  multi?: boolean | undefined;
  upsert?: boolean | undefined;
  arrayFilters?: { [identifier: string]: any }[] | undefined;
}

export const AllModels = new Set<Model<any, any>>();

class Model<
  Schema extends z.ZodType,
  IdSchema extends z.ZodType<string> = typeof stringId,
> {
  declare _docType: output<SchemaWithId<Schema, IdSchema>>;
  schema: SchemaWithId<Schema, IdSchema>;
  autoPopulated: Record<string, AutoPopulate>;
  defaults: Record<string, () => unknown>;
  indexes: ModelIndexSpecification[] = [];
  // The schema a replacement document is checked against: the full one with
  // _id optional, since a replacement keeps the _id of the document it
  // replaces.
  private replacementSchema: z.ZodType;

  constructor(
    public name: string,
    inputSchema: Schema,
    idSchema?: IdSchema,
  ) {
    const id = idSchema ?? stringId;
    const merged =
      inputSchema instanceof z.ZodObject
        ? inputSchema.extend({ _id: id })
        : inputSchema.and(z.object({ _id: id }));
    this.schema = merged as any;
    validateSchema(this.schema);
    this.replacementSchema =
      merged instanceof z.ZodObject ? merged.partial({ _id: true }) : merged;
    const metadata = collectSchemaMetadata(this.schema);
    this.autoPopulated = metadata.autoPopulated;
    this.defaults = metadata.defaults;
    AllModels.add(this);
  }

  // The driver's collection, for queries the model doesn't cover
  // (aggregations, bulk writes). Looked up on each call so the model can be
  // built before the connection is.
  rawCollection(): Collection<
    output<SchemaWithId<Schema, IdSchema>> & Document
  > {
    return db().collection(this.name);
  }

  private untypedCollection = (): Collection<StoredDocument> =>
    db().collection(this.name);

  autoPopulatedFields(): Record<AutoPopulate["when"], Record<string, unknown>> {
    const now = clock();

    const result: Record<AutoPopulate["when"], Record<string, unknown>> = {
      insert: {},
      update: {},
      always: {},
    };

    for (const [key, auto] of Object.entries(this.autoPopulated)) {
      switch (auto.value) {
        case "timestamp":
          result[auto.when][key] = now;
          break;
        case "id":
          // _id is generated at insert time, and generating one in a
          // modifier's $setOnInsert conflicts with upserts whose selector
          // pins _id. Any other id-typed field is the caller's
          // responsibility (and the schema check will verify it's present).
          break;
        case "userId": {
          // There's only a user inside withUser; outside it, the schema
          // check catches a missing required value
          const userId = currentUserId();
          if (userId !== undefined) {
            result[auto.when][key] = userId;
          }
          break;
        }
        default:
          auto.value satisfies never;
      }
    }

    return result;
  }

  defaultFields(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.defaults).map(([key, value]) => [key, value()]),
    );
  }

  private prepareInsert(
    doc: InsertModelType<SchemaWithId<Schema, IdSchema>>,
    autoPopulated: Record<AutoPopulate["when"], Record<string, unknown>>,
  ): StoredDocument {
    return validateDocument(this.name, this.schema, {
      _id: Random.id(),
      ...this.defaultFields(),
      ...autoPopulated.insert,
      ...autoPopulated.always,
      ...(doc as Record<string, unknown>),
    });
  }

  async insertAsync(
    doc: InsertModelType<SchemaWithId<Schema, IdSchema>>,
  ): Promise<output<IdSchema>> {
    const finalDoc = this.prepareInsert(doc, this.autoPopulatedFields());
    await this.untypedCollection().insertOne(finalDoc);
    return finalDoc._id as output<IdSchema>;
  }

  // Inserts several documents in one round trip, filling in defaults and
  // auto-populated fields the same way insertAsync does.
  async insertManyAsync(
    docs: InsertModelType<SchemaWithId<Schema, IdSchema>>[],
  ): Promise<output<IdSchema>[]> {
    if (docs.length === 0) {
      return [];
    }
    const autoPopulated = this.autoPopulatedFields();
    const finalDocs = docs.map((doc) => this.prepareInsert(doc, autoPopulated));
    await this.untypedCollection().insertMany(finalDocs);
    return finalDocs.map((doc) => doc._id as output<IdSchema>);
  }

  autoPopulateModifier(
    mod: Modifier<output<SchemaWithId<Schema, IdSchema>>>,
  ): any {
    // An empty modifier is a (no-op) modifier, not a replacement, so we only
    // treat mod as a replacement if it has at least one non-operator key
    const keys = Object.keys(mod);
    const isReplacement =
      keys.length > 0 && !keys.some((key) => key.startsWith("$"));
    const autoPopulated = this.autoPopulatedFields();

    let finalMod: any;

    if (isReplacement) {
      // We *don't* populate "insert" fields on replacements (since that's not
      // an insert), so the caller is responsible for making sure those fields
      // are populated (the schema check will verify). We will set "update" and
      // "always" fields, though (though they can be overridden by the caller)
      finalMod = {
        ...autoPopulated.update,
        ...autoPopulated.always,
        ...mod,
      };
    } else {
      // For non-replacements, we put insert fields into $setOnInsert, and
      // update and always fields into $set. (If this isn't an upsert, Mongo
      // ignores $setOnInsert.)
      const operators = mod as UpdateFilter<StoredDocument>;
      finalMod = {
        ...operators,
        $setOnInsert: {
          ...this.defaultFields(),
          ...autoPopulated.insert,
          ...operators.$setOnInsert,
        },
        $set: {
          ...autoPopulated.update,
          ...autoPopulated.always,
          ...operators.$set,
        },
      };

      // We also need to scrub any $setOnInsert fields that show up on other
      // operators
      for (const operator of Object.keys(finalMod)) {
        if (operator === "$setOnInsert") continue;
        if (typeof finalMod[operator] !== "object") continue;

        for (const key of Object.keys(finalMod[operator])) {
          delete finalMod.$setOnInsert[key];
        }
      }

      // Drop any operators we left empty, since Mongo rejects empty atomic
      // operations
      for (const operator of ["$set", "$setOnInsert"]) {
        if (
          finalMod[operator] &&
          Object.keys(finalMod[operator]).length === 0
        ) {
          delete finalMod[operator];
        }
      }
    }

    return finalMod;
  }

  private isReplacement(mod: Record<string, unknown>): boolean {
    const keys = Object.keys(mod);
    return keys.length > 0 && !keys.some((key) => key.startsWith("$"));
  }

  // Runs an update, replacement or upsert, returning the driver's counts.
  // Meteor's "number affected" is the number of documents matched (an
  // upsert's inserted document included), which is what the callers that
  // check for a lost race look at.
  private async write(
    selector: Selector<output<SchemaWithId<Schema, IdSchema>>>,
    mod: Modifier<output<SchemaWithId<Schema, IdSchema>>>,
    options: UpdateOptions,
  ): Promise<{ numberAffected: number; insertedId?: output<IdSchema> }> {
    const filter = normalizeSelector(selector);
    const finalMod = this.autoPopulateModifier(mod);
    const collection = this.untypedCollection();
    if (this.isReplacement(finalMod)) {
      const replacement = validateDocument<StoredDocument>(
        this.name,
        this.replacementSchema,
        finalMod,
      );
      const result = await collection.replaceOne(filter, replacement, {
        ...(options.upsert ? { upsert: true } : {}),
      });
      return {
        numberAffected: result.matchedCount + result.upsertedCount,
        ...(result.upsertedId
          ? { insertedId: result.upsertedId as output<IdSchema> }
          : {}),
      };
    }

    // Mongo would give an upserted document an ObjectId; give it one of ours
    // unless the selector already pins it
    if (options.upsert && typeof filter._id !== "string") {
      finalMod.$setOnInsert = { _id: Random.id(), ...finalMod.$setOnInsert };
    }
    validateModifier(this.name, this.schema, finalMod);
    const writeOptions = {
      ...(options.upsert ? { upsert: true } : {}),
      ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
    };
    const result = options.multi
      ? await collection.updateMany(filter, finalMod, writeOptions)
      : await collection.updateOne(filter, finalMod, writeOptions);
    return {
      numberAffected: result.matchedCount + result.upsertedCount,
      ...(result.upsertedId
        ? { insertedId: result.upsertedId as output<IdSchema> }
        : {}),
    };
  }

  async updateAsync(
    selector: Selector<output<SchemaWithId<Schema, IdSchema>>>,
    mod: Modifier<output<SchemaWithId<Schema, IdSchema>>>,
    options: UpdateOptions = {},
  ): Promise<number> {
    const { numberAffected } = await this.write(selector, mod, options);
    return numberAffected;
  }

  async upsertAsync(
    selector: Selector<output<SchemaWithId<Schema, IdSchema>>>,
    mod: Modifier<output<SchemaWithId<Schema, IdSchema>>>,
    options: Omit<UpdateOptions, "upsert"> = {},
  ): Promise<{ numberAffected?: number; insertedId?: output<IdSchema> }> {
    return this.write(selector, mod, { ...options, upsert: true });
  }

  async removeAsync(
    selector: Selector<output<SchemaWithId<Schema, IdSchema>>>,
  ): Promise<number> {
    const result = await this.untypedCollection().deleteMany(
      normalizeSelector(selector),
    );
    return result.deletedCount;
  }

  find<const S extends Selector<output<SchemaWithId<Schema, IdSchema>>>>(
    selector?: S,
    options?: FindOptions,
  ): TypedCursor<
    SelectorToResultType<output<SchemaWithId<Schema, IdSchema>>, S>
  > {
    return new TypedCursor(
      this.untypedCollection,
      normalizeSelector(selector),
      options,
    );
  }

  async findOneAsync<
    const S extends Selector<output<SchemaWithId<Schema, IdSchema>>>,
  >(
    selector?: S,
    options?: FindOptions,
  ): Promise<
    SelectorToResultType<output<SchemaWithId<Schema, IdSchema>>, S> | undefined
  > {
    const { projection, sort, skip } = options ?? {};
    const doc = await this.untypedCollection().findOne(
      normalizeSelector(selector),
      {
        ...(projection ? { projection } : {}),
        ...(sort ? { sort } : {}),
        ...(skip ? { skip } : {}),
      },
    );
    return (doc ?? undefined) as
      | SelectorToResultType<output<SchemaWithId<Schema, IdSchema>>, S>
      | undefined;
  }

  addIndex(specification: IndexSpecification, options: IndexOptions = {}) {
    const normalizedIndex = normalizeIndexSpecification(specification);
    const normalizedOptions = normalizeIndexOptions(options);
    const stringified = JSON.stringify([normalizedIndex, normalizedOptions]);
    this.indexes.push({
      // We currently generate name here in the same way Mongo would implicitly,
      // but we will explicitly use this field's value for the index name when
      // actually creating the index, so if we want to support index name
      // overrides, we could.
      name: normalizedIndex.map(([k, v]) => `${k}_${v}`).join("_"),
      index: normalizedIndex,
      options: normalizedOptions,
      stringified,
    });
  }
}

export default Model;
