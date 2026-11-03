/**
 * Embeddings sit behind four methods so the demo, the tests and a real provider
 * all run through the same code path.
 */
export type EmbeddingProvider = {
  readonly name: string;
  readonly dimensions: number;
  /** Index-time vectors. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  /** One search-time vector. Asymmetric providers treat these differently. */
  embedQuery(text: string): Promise<number[]>;
};
