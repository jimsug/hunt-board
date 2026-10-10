import { TAG_SYNONYMS, type TagSynonymRule } from "lib/tagNames";

// The synonym table for a component to pass to the tag helpers. Jolly
// Roger's tag.synonyms setting isn't fed to the service yet, so it's the
// built-in one (as the server's own tagSynonyms.ts has it).
export default function useTagSynonyms(): readonly TagSynonymRule[] {
  return TAG_SYNONYMS;
}
