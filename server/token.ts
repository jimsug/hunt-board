import { createHmac, timingSafeEqual } from "node:crypto";
import type { Claims } from "lib/access";
import { ServiceError } from "lib/compat/error";
import { ClaimsSchema } from "lib/protocol";

// The token Jolly Roger mints for the iframe:
// <base64url(JSON claims)>.<base64url(HMAC-SHA256(claims, secret))>. The
// service only verifies; signToken is here for tests and for the adapter on
// Jolly Roger's side to share.

export const TOKEN_VERSION = 1;
// How far ahead a token's exp may be. Jolly Roger mints them for five
// minutes, so one further out is forged or from a clock that's off.
export const MAX_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

const base64url = (bytes: Buffer) => bytes.toString("base64url");

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest();

export function signToken(claims: Claims, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${base64url(sign(payload, secret))}`;
}

const invalid = (reason: string) => new ServiceError(401, reason);

// The claims a token carries, or a 401 ServiceError saying why not. The
// signature is checked before the claims are looked at, so nothing about an
// unsigned token's contents is told apart.
export function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
): Claims {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw invalid("Malformed token");
  }
  const [payload, signature] = parts;
  const expected = sign(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalid("Bad token signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalid("Malformed token");
  }
  const result = ClaimsSchema.safeParse(parsed);
  if (!result.success) {
    throw invalid(
      (parsed as { v?: unknown })?.v !== TOKEN_VERSION
        ? "Unsupported token version"
        : "Malformed token claims",
    );
  }
  const claims = result.data;
  if (claims.exp <= now) throw invalid("Token expired");
  if (claims.exp > now + MAX_TOKEN_LIFETIME_MS) {
    throw invalid("Token expiry too far ahead");
  }
  return claims;
}
