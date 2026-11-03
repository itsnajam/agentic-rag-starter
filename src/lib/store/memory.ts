import { cosine } from "../hash";
import type { Chunk } from "../types";
import type { KeywordHit, Store, StoredChunk, UpsertResult, VectorHit } from "./store";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

type Row = { chunk: StoredChunk; embedding: number[] };

/**
 * The store that needs nothing installed, so the demo, the tests and
 * `npm run eval` exercise the same retrieval, permission and citation code the
 * Postgres path does. Every read filters by owner, the same way the SQL does.
 */
export class MemoryStore implements Store {
  readonly name = "memory";
  private rows: Row[] = [];
  private seq = 0;

  /** When set, an embedding of any other length is rejected instead of quietly mixed. */
  constructor(private readonly dimensions = 0) {}

  async upsert(chunks: readonly Chunk[], embeddings: readonly number[][]): Promise<UpsertResult> {
    if (chunks.length !== embeddings.length) throw new Error("every chunk needs one embedding");
    const result: UpsertResult = { inserted: 0, skipped: 0, replaced: 0 };

    // Work one document at a time: a file either matches what is already
    // indexed or it is replaced whole, which is what makes re-running ingest
    // safe on a corpus that changed under you.
    const byDoc = new Map<string, { chunk: Chunk; embedding: number[] }[]>();
    chunks.forEach((chunk, i) => {
      const list = byDoc.get(chunk.docId) ?? [];
      list.push({ chunk, embedding: embeddings[i]! });
      byDoc.set(chunk.docId, list);
    });

    for (const [docId, pieces] of [...byDoc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ownerId = pieces[0]!.chunk.ownerId;
      const current = this.rows.filter((r) => r.chunk.docId === docId && r.chunk.ownerId === ownerId);
      const same =
        current.length === pieces.length &&
        pieces.every((p) => current.find((r) => r.chunk.chunkIndex === p.chunk.chunkIndex)?.chunk.contentHash === p.chunk.contentHash);

      if (same) {
        result.skipped += pieces.length;
        continue;
      }
      for (const r of current) this.drop(r.chunk.id);
      for (const p of pieces) {
        if (this.dimensions > 0 && p.embedding.length !== this.dimensions) {
          throw new Error(`embedding has ${p.embedding.length} dimensions, store expects ${this.dimensions}`);
        }
        const id = `c${++this.seq}`;
        this.rows.push({ chunk: { ...p.chunk, id }, embedding: p.embedding });
        if (current.length > 0) result.replaced++;
        else result.inserted++;
      }
    }
    return result;
  }

  async removeDoc(docId: string, ownerId: string): Promise<number> {
    const doomed = this.rows.filter((r) => r.chunk.docId === docId && r.chunk.ownerId === ownerId);
    for (const r of doomed) this.drop(r.chunk.id);
    return doomed.length;
  }

  private drop(id: string): void {
    this.rows = this.rows.filter((r) => r.chunk.id !== id);
  }

  private ownedBy(ownerId: string): Row[] {
    return this.rows.filter((r) => r.chunk.ownerId === ownerId);
  }

  async vectorSearch(queryVector: readonly number[], ownerId: string, limit: number): Promise<VectorHit[]> {
    if (queryVector.length === 0 || limit <= 0) return [];
    return this.ownedBy(ownerId)
      .map((r) => ({ chunk: r.chunk, similarity: cosine(queryVector, r.embedding) }))
      .filter((h) => h.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, limit);
  }

  /**
   * A small BM25-style score: term frequency saturates, and a term that appears
   * in most chunks is worth less than one that narrows the field. Kept explicit
   * rather than clever, because a reader should be able to check the ranking.
   */
  async keywordSearch(query: string, ownerId: string, limit: number): Promise<KeywordHit[]> {
    const terms = [...new Set(tokenize(query))];
    const corpus = this.ownedBy(ownerId);
    if (terms.length === 0 || corpus.length === 0 || limit <= 0) return [];

    const docs = corpus.map((r) => ({ row: r, terms: tokenize(r.chunk.content) }));
    const df = new Map<string, number>();
    for (const d of docs) {
      for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const k1 = 1.2;
    const avgLen = docs.reduce((s, d) => s + d.terms.length, 0) / docs.length;
    const scored = docs
      .map((d) => {
        const len = d.terms.length || 1;
        let rank = 0;
        for (const term of terms) {
          const tf = d.terms.filter((t) => t === term).length;
          if (tf === 0) continue;
          const idf = Math.log(1 + (corpus.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
          rank += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - 0.75 + 0.75 * (len / avgLen)));
        }
        return { chunk: d.row.chunk, rank };
      })
      .filter((h) => h.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.chunk.id.localeCompare(b.chunk.id));

    return scored.slice(0, limit);
  }

  async readChunk(id: string, ownerId: string): Promise<StoredChunk | null> {
    return this.ownedBy(ownerId).find((r) => r.chunk.id === id)?.chunk ?? null;
  }

  async count(ownerId: string): Promise<number> {
    return this.ownedBy(ownerId).length;
  }

  /** Demo and test helper: everything this owner can see, in insertion order. */
  async all(ownerId: string): Promise<StoredChunk[]> {
    return this.ownedBy(ownerId).map((r) => r.chunk);
  }
}
