// HMAC token signing and timing-safe verification under Bun's Node crypto
import { createHmac, timingSafeEqual } from "node:crypto";
const secret = "s3cret";
const claims = { scope: { hunt: "h1" }, user: "u1", name: "Ada", mayEdit: true, exp: Date.now() + 300_000 };
const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
const sig = createHmac("sha256", secret).update(body).digest("base64url");
const token = `${body}.${sig}`;
const [b, s] = token.split(".");
const expected = createHmac("sha256", secret).update(b!).digest();
const ok = timingSafeEqual(expected, Buffer.from(s!, "base64url"));
const bad = timingSafeEqual(expected, Buffer.from(createHmac("sha256", "other").update(b!).digest("base64url"), "base64url"));
console.log(JSON.stringify({ tokenLength: token.length, ok, bad, claims: JSON.parse(Buffer.from(b!, "base64url").toString()) }));
