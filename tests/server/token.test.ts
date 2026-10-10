import { describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import {
  MAX_TOKEN_LIFETIME_MS,
  signToken,
  TOKEN_SKEW_MS,
  verifyToken,
} from "../../server/token";

describe("token", () => {
  const secret = "a-secret-that-is-long-enough-for-tests";
  const now = Date.now();
  const claims = (): Claims => ({
    v: 1,
    scope: { hunt: Random.id(), puzzle: Random.id() },
    user: Random.id(),
    name: "Someone",
    mayEdit: true,
    exp: now + 60 * 1000,
    operator: true,
  });

  const fails = (token: string, match: RegExp, at = now) => {
    try {
      verifyToken(token, secret, at);
    } catch (error) {
      assert.instanceOf(error, Error);
      assert.match((error as Error).message, match);
      assert.equal((error as { error?: number }).error, 401);
      return;
    }
    assert.fail("expected the token to be refused");
  };

  it("round trips the claims", () => {
    const original = claims();
    const token = signToken(original, secret);
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(verifyToken(token, secret, now), original);
  });

  it("leaves an absent puzzle and operator absent", () => {
    const { operator: _o, ...rest } = claims();
    const original: Claims = { ...rest, scope: { hunt: rest.scope.hunt } };
    const verified = verifyToken(signToken(original, secret), secret, now);
    assert.deepEqual(verified, original);
    assert.notProperty(verified, "operator");
    assert.notProperty(verified.scope, "puzzle");
  });

  it("refuses a bad signature", () => {
    const token = signToken(claims(), secret);
    const [payload] = token.split(".");
    fails(
      `${payload}.${Buffer.from("nope").toString("base64url")}`,
      /signature/i,
    );
    fails(
      signToken(claims(), "another-secret-that-is-long-enough"),
      /signature/i,
    );
  });

  it("refuses tampered claims", () => {
    const original = claims();
    const token = signToken(original, secret);
    const [, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({
        ...original,
        mayEdit: true,
        operator: true,
        user: Random.id(),
      }),
    ).toString("base64url");
    fails(`${tampered}.${signature}`, /signature/i);
  });

  it("refuses an expired token", () => {
    const token = signToken({ ...claims(), exp: now - 1 }, secret);
    fails(token, /expired/i);
    fails(signToken({ ...claims(), exp: now }, secret), /expired/i);
  });

  it("refuses an expiry further ahead than the lifetime plus the skew", () => {
    assert.equal(MAX_TOKEN_LIFETIME_MS, 5 * 60 * 1000);
    assert.equal(TOKEN_SKEW_MS, 60 * 1000);
    const furthest = now + MAX_TOKEN_LIFETIME_MS + TOKEN_SKEW_MS;
    fails(signToken({ ...claims(), exp: furthest + 1 }, secret), /too far/i);
    const justInside = signToken({ ...claims(), exp: furthest }, secret);
    assert.equal(verifyToken(justInside, secret, now).exp, furthest);
    // A token minted for five minutes by a clock a minute ahead
    const skewed = signToken(
      { ...claims(), exp: now + MAX_TOKEN_LIFETIME_MS + TOKEN_SKEW_MS / 2 },
      secret,
    );
    assert.equal(
      verifyToken(skewed, secret, now).exp,
      now + MAX_TOKEN_LIFETIME_MS + TOKEN_SKEW_MS / 2,
    );
  });

  it("refuses another version", () => {
    const token = signToken({ ...claims(), v: 2 as 1 }, secret);
    fails(token, /version/i);
  });

  it("refuses malformed tokens", () => {
    fails("", /malformed/i);
    fails("abc", /malformed/i);
    fails("a.b.c", /malformed/i);
    fails(".", /malformed/i);
    // Signed, but not JSON
    const payload = Buffer.from("not json").toString("base64url");
    const signed = signToken(claims(), secret).split(".")[1] ?? "";
    fails(`${payload}.${signed}`, /signature/i);
  });

  it("refuses claims with extra or missing fields", () => {
    const extra = { ...claims(), admin: true } as unknown as Claims;
    fails(signToken(extra, secret), /claims/i);
    const { name: _n, ...missing } = claims();
    fails(signToken(missing as Claims, secret), /claims/i);
  });
});
