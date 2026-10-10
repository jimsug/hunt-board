// The parts of Meteor's EJSON the board uses: JSON with dates and binary
// data, plus a deep equality and clone that understand them. The wire and
// storage format matches Meteor's, so a version snapshot written by the
// Meteor app reads here and vice versa: a Date is {$date: ms}, a Uint8Array
// is {$binary: base64}, a non-finite number is {$InfNaN: 1|-1|0}, and a
// plain object that would be mistaken for one of those is {$escape: {...}}.

type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

type Converter = {
  matchJSONValue: (obj: Record<string, unknown>) => boolean;
  matchObject: (obj: unknown) => boolean;
  toJSONValue: (obj: any) => JSONValue;
  fromJSONValue: (obj: any) => unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

const hasOwn = (obj: object, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string) =>
  new Uint8Array(Buffer.from(text, "base64"));

const builtinConverters: Converter[] = [
  {
    matchJSONValue: (obj) =>
      hasOwn(obj, "$date") && Object.keys(obj).length === 1,
    matchObject: (obj) => obj instanceof Date,
    toJSONValue: (obj: Date) => ({ $date: obj.getTime() }),
    fromJSONValue: (obj: { $date: number }) => new Date(obj.$date),
  },
  {
    matchJSONValue: (obj) =>
      hasOwn(obj, "$InfNaN") && Object.keys(obj).length === 1,
    matchObject: (obj) =>
      typeof obj === "number" && (Number.isNaN(obj) || !Number.isFinite(obj)),
    toJSONValue: (obj: number) => ({
      $InfNaN: Number.isNaN(obj) ? 0 : obj > 0 ? 1 : -1,
    }),
    fromJSONValue: (obj: { $InfNaN: number }) =>
      obj.$InfNaN === 0 ? NaN : obj.$InfNaN > 0 ? Infinity : -Infinity,
  },
  {
    matchJSONValue: (obj) =>
      hasOwn(obj, "$binary") && Object.keys(obj).length === 1,
    matchObject: (obj) => obj instanceof Uint8Array,
    toJSONValue: (obj: Uint8Array) => ({ $binary: toBase64(obj) }),
    fromJSONValue: (obj: { $binary: string }) => fromBase64(obj.$binary),
  },
  {
    // Escaping one level: a plain object that happens to look like one of
    // the forms above is wrapped so it comes back as itself.
    matchJSONValue: (obj) =>
      hasOwn(obj, "$escape") && Object.keys(obj).length === 1,
    matchObject: (obj) => {
      if (!isPlainObject(obj)) return false;
      const keyCount = Object.keys(obj).length;
      if (keyCount !== 1 && keyCount !== 2) return false;
      return builtinConverters.some((converter) =>
        converter.matchJSONValue(obj),
      );
    },
    toJSONValue: (obj: Record<string, unknown>) => {
      const newObj: Record<string, JSONValue> = {};
      for (const [key, value] of Object.entries(obj)) {
        newObj[key] = toJSONValue(value);
      }
      return { $escape: newObj };
    },
    fromJSONValue: (obj: { $escape: Record<string, unknown> }) => {
      const newObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj.$escape)) {
        newObj[key] = fromJSONValue(value);
      }
      return newObj;
    },
  },
];

function toJSONValue(item: unknown): JSONValue {
  for (const converter of builtinConverters) {
    if (converter.matchObject(item)) return converter.toJSONValue(item);
  }
  if (Array.isArray(item)) return item.map(toJSONValue);
  if (isPlainObject(item)) {
    const newObj: Record<string, JSONValue> = {};
    for (const [key, value] of Object.entries(item)) {
      newObj[key] = toJSONValue(value);
    }
    return newObj;
  }
  if (item === undefined) return null;
  return item as JSONValue;
}

function fromJSONValue(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(fromJSONValue);
  if (isPlainObject(item)) {
    for (const converter of builtinConverters) {
      if (converter.matchJSONValue(item)) return converter.fromJSONValue(item);
    }
    const newObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      newObj[key] = fromJSONValue(value);
    }
    return newObj;
  }
  return item;
}

// Sorts keys at every level, so the same value always serialises the same
// way (which is what a content hash needs).
function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key] as JSONValue);
    }
    return sorted;
  }
  return value;
}

function stringify(
  item: unknown,
  options: { canonical?: boolean; indent?: boolean | number | string } = {},
): string {
  let json = toJSONValue(item);
  if (options.canonical) json = canonicalize(json);
  const indent =
    options.indent === true
      ? 2
      : options.indent === false
        ? undefined
        : options.indent;
  return JSON.stringify(json, null, indent);
}

function parse(text: string): unknown {
  return fromJSONValue(JSON.parse(text));
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

// Deep equality that compares dates by time and binaries by bytes. Key order
// doesn't matter unless keyOrderSensitive is set.
function equals(
  a: unknown,
  b: unknown,
  options: { keyOrderSensitive?: boolean } = {},
): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => equals(item, b[i], options));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  if (options.keyOrderSensitive) {
    return aKeys.every(
      (key, i) => key === bKeys[i] && equals(a[key], b[key], options),
    );
  }
  return aKeys.every(
    (key) => hasOwn(b, key) && equals(a[key], b[key], options),
  );
}

function clone<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = clone(item);
  }
  return copy as T;
}

export const EJSON = {
  stringify,
  parse,
  toJSONValue,
  fromJSONValue,
  equals,
  clone,
  isBinary,
};
