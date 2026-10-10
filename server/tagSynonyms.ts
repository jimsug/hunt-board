import { TAG_SYNONYMS, type TagSynonymRule } from "lib/tagNames";

// The synonym table the server applies. Jolly Roger lets its tag.synonyms
// setting replace the built-in table; until that setting is fed across, the
// built-in table is the one. Server code passes it to the tag helpers in
// lib/tagNames.ts.
export default function currentTagSynonyms(): readonly TagSynonymRule[] {
  return TAG_SYNONYMS;
}
