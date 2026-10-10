import { z } from "zod";
import type { $ZodType, $ZodTypes } from "zod/v4/core";

// What a model throws when a write doesn't fit its schema. The message names
// the model and lists the issues, so a failing write reads at a glance.
export class ModelValidationError extends Error {
  constructor(
    public model: string,
    public issues: z.core.$ZodIssue[],
  ) {
    super(
      `${model}: ${issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "(document)"}: ${issue.message}`,
        )
        .join("; ")}`,
    );
    this.name = "ModelValidationError";
  }
}

const unwrap = (raw: $ZodType): $ZodTypes => {
  let schema = raw as unknown as $ZodTypes;
  for (;;) {
    const { def } = schema._zod;
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "readonly":
        schema = def.innerType as unknown as $ZodTypes;
        break;
      default:
        return schema;
    }
  }
};

const isArrayIndex = (segment: string) =>
  /^\d+$/.test(segment) || segment === "$" || /^\$\[.*\]$/.test(segment);

// The schema at a dotted path into a document, or undefined where the path
// can't be followed (through a union, say). Array segments are an index or a
// positional operator.
export function schemaAt(
  raw: $ZodType,
  path: readonly string[],
): $ZodType | undefined {
  let schema: $ZodType | undefined = raw;
  for (const segment of path) {
    if (!schema) return undefined;
    const { def } = unwrap(schema)._zod;
    switch (def.type) {
      case "object":
        schema = def.shape[segment] as $ZodType | undefined;
        break;
      case "array":
        schema = isArrayIndex(segment) ? (def.element as $ZodType) : undefined;
        break;
      case "tuple":
        schema = /^\d+$/.test(segment)
          ? (def.items[Number(segment)] as $ZodType | undefined)
          : undefined;
        break;
      case "record":
        schema = def.valueType as $ZodType;
        break;
      default:
        return undefined;
    }
  }
  return schema;
}

const topLevelKeys = (raw: $ZodType): Set<string> | undefined => {
  const { def } = unwrap(raw)._zod;
  return def.type === "object" ? new Set(Object.keys(def.shape)) : undefined;
};

const unknownKeyIssue = (path: (string | number)[]): z.core.$ZodIssue =>
  ({
    code: "unrecognized_keys",
    keys: [String(path[path.length - 1])],
    path,
    message: "Unrecognized key",
    input: undefined,
  }) as z.core.$ZodIssue;

// Parses a whole document against the schema, which also fills in Zod
// defaults, and refuses keys the schema doesn't know about rather than
// letting them be silently dropped.
export function validateDocument<T>(
  model: string,
  schema: $ZodType,
  doc: Record<string, unknown>,
): T {
  const result = z.safeParse(schema as z.ZodType, doc);
  if (!result.success) {
    throw new ModelValidationError(model, result.error.issues);
  }
  const known = topLevelKeys(schema);
  if (known) {
    const unknown = Object.keys(doc).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new ModelValidationError(
        model,
        unknown.map((key) => unknownKeyIssue([key])),
      );
    }
  }
  return result.data as T;
}

const validateAt = (
  schema: $ZodType,
  path: string,
  value: unknown,
  issues: z.core.$ZodIssue[],
) => {
  const segments = path.split(".");
  const field = schemaAt(schema, segments);
  if (!field) {
    // A top-level key the schema doesn't have is a mistake; a deeper path
    // the walk couldn't follow is left to Mongo.
    if (segments.length === 1 && topLevelKeys(schema)) {
      issues.push(unknownKeyIssue(segments));
    }
    return;
  }
  const result = z.safeParse(field as z.ZodType, value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({ ...issue, path: [...segments, ...issue.path] });
    }
  }
};

// Checks the values a modifier sets against the schema: each $set and
// $setOnInsert entry (dotted paths included) against the field it names,
// and each $push or $addToSet value against the array's element. Other
// operators ($unset, $inc, $pull, ...) aren't checked.
export function validateModifier(
  model: string,
  schema: $ZodType,
  modifier: Record<string, unknown>,
): void {
  const issues: z.core.$ZodIssue[] = [];
  for (const operator of ["$set", "$setOnInsert"]) {
    const fields = modifier[operator];
    if (!fields || typeof fields !== "object") continue;
    for (const [path, value] of Object.entries(fields)) {
      validateAt(schema, path, value, issues);
    }
  }
  for (const operator of ["$push", "$addToSet"]) {
    const fields = modifier[operator];
    if (!fields || typeof fields !== "object") continue;
    for (const [path, value] of Object.entries(fields)) {
      const array = schemaAt(schema, path.split("."));
      if (!array) continue;
      const { def } = unwrap(array)._zod;
      if (def.type !== "array") continue;
      const element = def.element as $ZodType;
      const items =
        value && typeof value === "object" && "$each" in value
          ? ((value as { $each: unknown[] }).$each ?? [])
          : [value];
      for (const item of items) {
        const result = z.safeParse(element as z.ZodType, item);
        if (!result.success) {
          for (const issue of result.error.issues) {
            issues.push({
              ...issue,
              path: [...path.split("."), ...issue.path],
            });
          }
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new ModelValidationError(model, issues);
  }
}
