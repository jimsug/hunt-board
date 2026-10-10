// Meteor's Random.id(): an id of 17 characters drawn from an alphabet that
// leaves out the characters that are easy to confuse (0, O, 1, l, I, ...).
// Every id the shim generates, and the Id regex that validates them, uses it.
const UNMISTAKABLE_CHARS =
  "23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz";

// The largest multiple of the alphabet's size that fits in a byte. Bytes at
// or above it are thrown away rather than wrapped, so every character is
// equally likely.
const UNBIASED_LIMIT =
  256 - (256 % UNMISTAKABLE_CHARS.length); /* 220 for 55 characters */

function id(charsCount = 17): string {
  let result = "";
  const bytes = new Uint8Array(charsCount * 2);
  while (result.length < charsCount) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      result += UNMISTAKABLE_CHARS[byte % UNMISTAKABLE_CHARS.length];
      if (result.length === charsCount) break;
    }
  }
  return result;
}

export const Random = { id, UNMISTAKABLE_CHARS };
