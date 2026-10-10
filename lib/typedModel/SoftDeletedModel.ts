import { z } from "zod";
import type { $ZodObjectConfig, $ZodShape, output, util } from "zod/v4/core";
import type { FindOptions, TypedCursor } from "./cursor";
import { deleted } from "./customTypes";
import type { Selector, SelectorToResultType } from "./Model";
import Model, { type SchemaWithId } from "./Model";

const injectQuery = <S extends Record<string, any>>(
  selector: S | string | undefined,
  injection: S,
) => {
  if (!selector) {
    return injection;
  }
  if (typeof selector === "string") {
    return { _id: selector, ...injection };
  }
  if ("$query" in selector) {
    return {
      ...selector,
      $query: {
        $and: [selector.$query, injection],
      },
    };
  }

  return {
    $and: [selector, injection],
  };
};

const injectOptions = <Opts extends FindOptions>(options: Opts | undefined) => {
  if (options?.projection) {
    return {
      ...options,
      projection: {
        ...options.projection,
        deleted: 1,
      },
    };
  }

  return options;
};

type SoftDeletedSchema<Schema extends z.ZodType> =
  Schema extends z.ZodObject<
    infer Shape extends $ZodShape,
    infer Config extends $ZodObjectConfig
  >
    ? z.ZodObject<util.Extend<Shape, { deleted: typeof deleted }>, Config>
    : z.ZodIntersection<Schema, z.ZodObject<{ deleted: typeof deleted }>>;

// The output type of a SoftDeletedModel's full schema (including _id via Model)
type SDModelType<Schema extends z.ZodType> = output<
  SchemaWithId<SoftDeletedSchema<Schema>>
>;

class SoftDeletedModel<Schema extends z.ZodType> extends Model<
  SoftDeletedSchema<Schema>
> {
  constructor(name: string, schema: Schema) {
    super(
      name,
      (schema instanceof z.ZodObject
        ? schema.extend({ deleted })
        : schema.and(z.object({ deleted }))) as any,
    );
  }

  destroyAsync(selector: Selector<SDModelType<Schema>>): Promise<number> {
    return this.updateAsync(
      selector as any,
      { $set: { deleted: true } } as any,
      { multi: true },
    );
  }

  undestroyAsync(selector: Selector<SDModelType<Schema>>): Promise<number> {
    return this.updateAsync(
      selector as any,
      { $set: { deleted: false } } as any,
      { multi: true },
    );
  }

  find<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): TypedCursor<SelectorToResultType<SDModelType<Schema>, S>> {
    return super.find(
      injectQuery(selector, { deleted: false }) as any,
      injectOptions(options),
    ) as any;
  }

  findOneAsync<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): Promise<SelectorToResultType<SDModelType<Schema>, S> | undefined> {
    return super.findOneAsync(
      injectQuery(selector, { deleted: false }) as any,
      injectOptions(options),
    ) as any;
  }

  findAllowingDeleted<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): TypedCursor<SelectorToResultType<SDModelType<Schema>, S>> {
    return super.find(selector as any, injectOptions(options)) as any;
  }

  findOneAllowingDeletedAsync<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): Promise<SelectorToResultType<SDModelType<Schema>, S> | undefined> {
    return super.findOneAsync(selector as any, injectOptions(options)) as any;
  }

  findDeleted<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): TypedCursor<SelectorToResultType<SDModelType<Schema>, S>> {
    return super.find(
      injectQuery(selector, { deleted: true }) as any,
      injectOptions(options),
    ) as any;
  }

  findOneDeletedAsync<S extends Selector<SDModelType<Schema>>>(
    selector?: S,
    options?: FindOptions,
  ): Promise<SelectorToResultType<SDModelType<Schema>, S> | undefined> {
    return super.findOneAsync(
      injectQuery(selector, { deleted: true }) as any,
      injectOptions(options),
    ) as any;
  }
}

export default SoftDeletedModel;
