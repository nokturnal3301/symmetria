/**
 * The hidden embedding columns of each assembled table and the columns whose
 * text they describe. Writes read it: an UPDATE that changes a source clears
 * the embedding, which would otherwise describe the old text.
 */
export type EmbeddingColumn = {
  readonly column: string;
  readonly sources: readonly string[];
};

export const embeddingColumns = new WeakMap<
  object,
  readonly EmbeddingColumn[]
>();
