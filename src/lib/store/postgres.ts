import type { Chunk } from "../types";
import type { KeywordHit, QueryExecutor, Store, StoredChunk, UpsertResult, VectorHit } from "./store";

const COLUMNS = "id, doc_id, owner_id, source_path, chunk_index, content, content_hash, token_estimate";

/** pgvector takes a bracketed list. Only finite numbers may go in it. */
export function vectorLiteral(vector: readonly number[]): string {
  for (const n of vector) {
    if (!Number.isFinite(n)) throw new Error("embeddings must be finite numbers");
  }
  return `[${vector.join(",")}]`;
}

function toChunk(row: Record<string, unknown>): StoredChunk {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    ownerId: String(row.owner_id),
    sourcePath: String(row.source_path),
    chunkIndex: Number(row.chunk_index),
    content: String(row.content),
    contentHash: String(row.content_hash),
    tokenEstimate: Number(row.token_estimate),
  };
}

/**
 * Postgres plus pgvector. The permission filter is part of every statement, not
 * a JavaScript check afterwards, so a chunk belonging to somebody else never
 * leaves the database. All values are bound parameters.
 */
export class PostgresStore implements Store {
  readonly name = "postgres";

  constructor(
    private readonly db: QueryExecutor,
    private readonly dimensions: number
  ) {}

  async upsert(chunks: readonly Chunk[], embeddings: readonly number[][]): Promise<UpsertResult> {
    if (chunks.length !== embeddings.length) throw new Error("every chunk needs one embedding");
    const result: UpsertResult = { inserted: 0, skipped: 0, replaced: 0 };

    const byDoc = new Map<string, { chunk: Chunk; embedding: number[] }[]>();
    chunks.forEach((chunk, i) => {
      const list = byDoc.get(chunk.docId) ?? [];
      list.push({ chunk, embedding: embeddings[i]! });
      byDoc.set(chunk.docId, list);
    });

    for (const [docId, pieces] of [...byDoc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ownerId = pieces[0]!.chunk.ownerId;
      const existing = await this.db.query(`select chunk_index, content_hash from chunks where doc_id = $1 and owner_id = $2`, [docId, ownerId]);
      const same =
        existing.rows.length === pieces.length &&
        pieces.every((p) => existing.rows.find((r) => Number(r.chunk_index) === p.chunk.chunkIndex)?.content_hash === p.chunk.contentHash);

      if (same) {
        result.skipped += pieces.length;
        continue;
      }
      if (existing.rows.length > 0) {
        await this.db.query(`delete from chunks where doc_id = $1 and owner_id = $2`, [docId, ownerId]);
        result.replaced += pieces.length;
      } else {
        result.inserted += pieces.length;
      }
      for (const p of pieces) {
        if (p.embedding.length !== this.dimensions) {
          throw new Error(`embedding has ${p.embedding.length} dimensions, the column is ${this.dimensions}`);
        }
        await this.db.query(
          `insert into chunks (doc_id, owner_id, source_path, chunk_index, content, content_hash, token_estimate, embedding)
           values ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
          [p.chunk.docId, p.chunk.ownerId, p.chunk.sourcePath, p.chunk.chunkIndex, p.chunk.content, p.chunk.contentHash, p.chunk.tokenEstimate, vectorLiteral(p.embedding)]
        );
      }
    }
    return result;
  }

  async removeDoc(docId: string, ownerId: string): Promise<number> {
    const res = await this.db.query(`delete from chunks where doc_id = $1 and owner_id = $2`, [docId, ownerId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  /**
   * Cosine distance, ordered by the index operator so pgvector can use the HNSW
   * index, and filtered by owner in the same statement.
   */
  async vectorSearch(queryVector: readonly number[], ownerId: string, limit: number): Promise<VectorHit[]> {
    if (queryVector.length === 0 || limit <= 0) return [];
    const res = await this.db.query(
      `select ${COLUMNS}, 1 - (embedding <=> $1::vector) as similarity
       from chunks
       where owner_id = $2 and embedding <=> $1::vector < 1
       order by embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), ownerId, limit]
    );
    return res.rows.map((r) => ({ chunk: toChunk(r), similarity: Number(r.similarity) }));
  }

  async keywordSearch(query: string, ownerId: string, limit: number): Promise<KeywordHit[]> {
    if (!query.trim() || limit <= 0) return [];
    const res = await this.db.query(
      `select ${COLUMNS}, ts_rank(search, websearch_to_tsquery('english', $1)) as rank
       from chunks
       where owner_id = $2 and search @@ websearch_to_tsquery('english', $1)
       order by rank desc, id
       limit $3`,
      [query, ownerId, limit]
    );
    return res.rows.map((r) => ({ chunk: toChunk(r), rank: Number(r.rank) }));
  }

  async readChunk(id: string, ownerId: string): Promise<StoredChunk | null> {
    if (!/^\d+$/.test(id)) return null;
    const res = await this.db.query(`select ${COLUMNS} from chunks where id = $1 and owner_id = $2`, [id, ownerId]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? toChunk(row) : null;
  }

  async count(ownerId: string): Promise<number> {
    const res = await this.db.query(`select count(*)::int as count from chunks where owner_id = $1`, [ownerId]);
    return Number(res.rows[0]?.count ?? 0);
  }
}

/** Loaded only when a DATABASE_URL exists, so tests never need pg installed. */
export async function createPostgresStore(databaseUrl: string, dimensions: number): Promise<Store> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  return new PostgresStore({ query: (sql, params) => pool.query(sql, params as unknown[]) }, dimensions);
}
