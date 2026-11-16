/**
 * `symmetria/search`: what a table's `.search()` is declared with. `bm25()`
 * and `fullText()` match words; `embedder()` wraps a model that matches
 * meaning (`symmetria/voyage` and `symmetria/ollama` have ready ones).
 */
export {
  bm25,
  embedder,
  fullText,
  type EmbeddingModel,
  type MeaningSearch,
  type SearchDeclaration,
  type SearchParts,
  type WordsSearch,
} from "../schema/search";
export type { PartialSearch } from "../query/search";
