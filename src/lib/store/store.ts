import type { Chunk, StoredChunk } from "../types";

export type { StoredChunk };

export type VectorHit = { chunk: StoredChunk; similarity: number };
export type KeywordHit = { chunk: StoredChunk; rank: number };

export type UpsertResult = { inserted: number; skipped: number; replaced: number };

/** The slice of a database this code needs, so tests can record statements. */
export type QueryExecutor = {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Two implementations, one interface: the in-memory store the demo and tests use,
 * and the Postgres plus pgvector store the README points at. Both filter by owner
 * inside the lookup, so a caller cannot forget it in one of the two paths.
 */
export type Store = {
  readonly name: string;
  upsert(chunks: readonly Chunk[], embeddings: readonly number[][]): Promise<UpsertResult>;
  /** Used by re-indexing: a changed file replaces its old chunks. */
  removeDoc(docId: string, ownerId: string): Promise<number>;
  vectorSearch(queryVector: readonly number[], ownerId: string, limit: number): Promise<VectorHit[]>;
  keywordSearch(query: string, ownerId: string, limit: number): Promise<KeywordHit[]>;
  readChunk(id: string, ownerId: string): Promise<StoredChunk | null>;
  count(ownerId: string): Promise<number>;
};
