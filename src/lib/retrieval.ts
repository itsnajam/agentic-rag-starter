import { tokenize } from "./store/memory";
import type { KeywordHit, Store, VectorHit } from "./store/store";
import type { Retrieved, StoredChunk } from "./types";

/** Standard reciprocal rank fusion constant. */
export const RRF_K = 60;

/**
 * Two rankings, one list. A vector search finds paraphrase and a full-text
 * search finds the exact term, error code or product name; each votes by where
 * it placed a chunk, so a chunk both engines like beats one only one of them
 * likes. The scores are ranks, not distances, which is what makes the two
 * lists comparable when one is cosine similarity and the other is ts_rank.
 */
export function fuse(vector: readonly VectorHit[], keyword: readonly KeywordHit[]): Retrieved[] {
  const scores = new Map<string, { chunk: StoredChunk; score: number; via: Retrieved["via"]; similarity: number }>();

  vector.forEach((hit, i) => {
    scores.set(hit.chunk.id, {
      chunk: hit.chunk,
      score: 1 / (RRF_K + i + 1),
      via: hit.similarity > 0 ? ["vector"] : [],
      similarity: hit.similarity,
    });
  });

  keyword.forEach((hit, i) => {
    const add = 1 / (RRF_K + i + 1);
    const seen = scores.get(hit.chunk.id);
    if (seen) {
      seen.score += add;
      if (!seen.via.includes("keyword")) seen.via.push("keyword");
    } else {
      scores.set(hit.chunk.id, { chunk: hit.chunk, score: add, via: ["keyword"], similarity: 0 });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .map((s) => ({ ...s.chunk, score: s.score, via: s.via }));
}

export type RetrievalResult = {
  results: Retrieved[];
  /** True when the answer must be a refusal rather than a guess. */
  weak: boolean;
  reason: "no-results" | "low-confidence" | null;
  topSimilarity: number;
  lexicalOverlap: boolean;
  /** Distinct query terms present in the best match. */
  matchedTerms: number;
  /** Of those, the ones rare enough in the candidate pool to count as a topic. */
  rareTerms: number;
};

export type Retrieve = (query: string, ownerId: string) => Promise<RetrievalResult>;

/**
 * How many of the candidate chunks contain each query term. A term that shows up
 * in a couple of chunks is a topic; a term in most of them is English filler like
 * "rate" or "index". Rareness is measured over the candidate pool the retriever
 * already has, which is an approximation, and it is stated as one rather than
 * presented as corpus truth.
 */
function documentFrequency(terms: readonly string[], candidates: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const term of terms) {
    df.set(term, candidates.filter((c) => c.includes(term)).length);
  }
  return df;
}

/**
 * Hybrid retrieval for one owner. The store filters by owner, so what comes back
 * here is already only what this identity may read.
 */
export function createRetriever(
  store: Store,
  embedQuery: (text: string) => Promise<number[]>,
  options: { topK: number; candidateMultiplier?: number; weakSimilarity?: number; fusionDepth?: number }
): Retrieve {
  const candidates = Math.max(options.topK, options.topK * (options.candidateMultiplier ?? 3));

  return async (query, ownerId) => {
    const [vector, keyword] = await Promise.all([
      store.vectorSearch(await embedQuery(query), ownerId, candidates),
      store.keywordSearch(query, ownerId, candidates),
    ]);

    const fused = fuse(vector, keyword).slice(0, options.fusionDepth ?? Math.max(options.topK * 2, options.topK));
    const results = fused.slice(0, options.topK);
    const topSimilarity = vector[0]?.similarity ?? 0;
    const terms = [...new Set(tokenize(query))];
    const pool = [...new Map([...vector, ...keyword].map((h) => [h.chunk.id, h.chunk.content.toLowerCase()])).values()];
    const df = documentFrequency(terms, pool);
    const rareLimit = Math.max(1, Math.ceil(pool.length * 0.25));
    const matched = results[0] ? terms.filter((t) => results[0]!.content.toLowerCase().includes(t)) : [];
    const rareMatches = matched.filter((t) => (df.get(t) ?? 0) <= rareLimit);
    const lexicalOverlap = matched.length > 0;
    const base = { topSimilarity, lexicalOverlap, matchedTerms: matched.length, rareTerms: rareMatches.length };

    if (results.length === 0) return { results, weak: true, reason: "no-results", ...base };

    // Two independent ways to be too weak to answer. No distinctive query term in
    // the best match means the overlap is common English, which is how "churn
    // rate" retrieves "hit rate". A low similarity means the vectors disagree even
    // when a word matched. A real provider will mostly use the second one; the
    // fake one needs the first, and both are checked.
    if (rareMatches.length === 0) return { results, weak: true, reason: "low-confidence", ...base };
    if (topSimilarity < (options.weakSimilarity ?? 0.02)) return { results, weak: true, reason: "low-confidence", ...base };
    return { results, weak: false, reason: null, ...base };
  };
}
