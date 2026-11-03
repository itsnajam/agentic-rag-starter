import { sha256 } from "../hash";
import type { EmbeddingProvider } from "./provider";

/**
 * A deterministic local embedding: every token is hashed onto the vector and
 * accumulates with a sign taken from the same hash. No model, no network, no key.
 *
 * It is not a good embedding. It is a stable one: text sharing words lands
 * nearby, unrelated text does not, and that is enough to make the retrieval,
 * permission and answer plumbing testable anywhere. Real ranking claims need a
 * real provider, and `npm run eval` says in its own output which provider ran.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  constructor(readonly dimensions: number = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 8) throw new Error("fake embeddings need at least 8 dimensions");
  }

  private embed(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
    // Words plus bigrams, so phrase order has some influence.
    const grams: string[] = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
    for (const g of grams) {
      const h = sha256(g);
      const index = Number.parseInt(h.slice(0, 6), 16) % this.dimensions;
      const sign = (Number.parseInt(h.slice(6, 7), 16) & 1) === 0 ? 1 : -1;
      v[index] = (v[index] ?? 0) + sign;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    return v.map((x) => x / norm);
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }
}
