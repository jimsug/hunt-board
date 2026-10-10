import { describe, it } from "bun:test";
import { assert } from "chai";
import { EJSON } from "lib/compat/ejson";
import { ServiceError } from "lib/compat/error";
import { Random } from "lib/compat/random";
import { Id } from "lib/typedModel/regexes";

describe("Random.id", () => {
  it("makes 17-character ids the Id regex accepts", () => {
    for (let i = 0; i < 200; i++) {
      assert.match(Random.id(), Id);
    }
    assert.lengthOf(Random.id(5), 5);
  });

  it("doesn't repeat itself", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => Random.id()));
    assert.equal(ids.size, 1000);
  });
});

describe("EJSON", () => {
  const snapshot = {
    format: 1,
    nodes: [
      { _id: "n1", createdAt: new Date("2026-01-02T03:04:05.678Z"), x: 1.5 },
    ],
    bytes: new Uint8Array([0, 1, 2, 255]),
    nested: { when: [new Date(0)], none: null },
  };

  it("round-trips dates and binary data", () => {
    const text = EJSON.stringify(snapshot);
    assert.include(text, '{"$date":1767323045678}');
    assert.include(text, '{"$binary":"AAEC/w=="}');
    const back = EJSON.parse(text) as typeof snapshot;
    assert.instanceOf(back.nodes[0]?.createdAt, Date);
    assert.instanceOf(back.bytes, Uint8Array);
    assert.isTrue(EJSON.equals(back, snapshot));
  });

  it("escapes objects that look like its own forms", () => {
    const tricky = { a: { $date: 5 }, b: { $escape: 1 } };
    const text = EJSON.stringify(tricky);
    assert.include(text, '"a":{"$escape":{"$date":5}}');
    assert.deepEqual(EJSON.parse(text), tricky);
  });

  it("keeps non-finite numbers", () => {
    const back = EJSON.parse(EJSON.stringify([Infinity, -Infinity, NaN]));
    assert.deepEqual(back, [Infinity, -Infinity, NaN]);
  });

  it("writes canonical output with sorted keys", () => {
    assert.equal(
      EJSON.stringify({ b: { d: 1, c: 2 }, a: [3] }, { canonical: true }),
      '{"a":[3],"b":{"c":2,"d":1}}',
    );
  });

  it("compares dates by time, binaries by bytes and objects by content", () => {
    assert.isTrue(EJSON.equals(new Date(5), new Date(5)));
    assert.isFalse(EJSON.equals(new Date(5), new Date(6)));
    assert.isTrue(EJSON.equals(new Uint8Array([1]), new Uint8Array([1])));
    assert.isFalse(EJSON.equals(new Uint8Array([1]), new Uint8Array([2])));
    assert.isTrue(EJSON.equals({ a: 1, b: [2] }, { b: [2], a: 1 }));
    assert.isFalse(
      EJSON.equals({ a: 1, b: 2 }, { b: 2, a: 1 }, { keyOrderSensitive: true }),
    );
    assert.isFalse(EJSON.equals({ a: 1 }, { a: 1, b: undefined }));
    assert.isTrue(EJSON.equals(NaN, NaN));
    assert.isFalse(EJSON.equals(null, {}));
  });

  it("clones deeply", () => {
    const copy = EJSON.clone(snapshot);
    assert.notStrictEqual(copy.nodes[0], snapshot.nodes[0]);
    assert.notStrictEqual(copy.bytes, snapshot.bytes);
    assert.isTrue(EJSON.equals(copy, snapshot));
  });
});

describe("ServiceError", () => {
  it("carries Meteor.Error's fields", () => {
    const error = new ServiceError(403, "Not allowed", "board b1");
    assert.equal(error.error, 403);
    assert.equal(error.reason, "Not allowed");
    assert.equal(error.details, "board b1");
    assert.equal(error.message, "Not allowed [403]");
    assert.instanceOf(error, Error);
  });
});
