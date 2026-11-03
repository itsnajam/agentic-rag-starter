// The shapes that cross module boundaries. Kept small on purpose: a starter you
// cannot read in one sitting is not a starter.

/** One indexed piece of one document. */
export type Chunk = {
  /** Stable id for the whole file, derived from its content hash. */
  docId: string;
  /** Every retrieval is filtered by this. It is the permission key. */
  ownerId: string;
  /** Where it came from, shown to the reader in the citation. */
  sourcePath: string;
  /** Position inside the file, so a reader can go back and check. */
  chunkIndex: number;
  content: string;
  /** Content hash of the chunk itself, used to skip unchanged work. */
  contentHash: string;
  tokenEstimate: number;
  embedding?: number[];
};

/** A source line attached to an answer. Nothing is cited without one. */
export type Citation = {
  /** 1-based, and the number the answer refers to as [1], [2]. */
  index: number;
  sourcePath: string;
  docId: string;
  chunkIndex: number;
  /** The exact text the answer was allowed to use. */
  snippet: string;
};

export type Identity = {
  userId: string;
};

/** A chunk once it is stored, with the id the read_chunk tool asks for. */
export type StoredChunk = Chunk & { id: string };

/** A scored chunk coming out of retrieval, before the answer step. */
export type Retrieved = StoredChunk & {
  score: number;
  /** Which sub-results put it here, so the fusion can be explained. */
  via: Array<"vector" | "keyword">;
};

export type AgentToolName = "search_docs" | "read_chunk";

export type AgentStep = {
  step: number;
  /** What the model asked for, or "final" when it answered. */
  action: AgentToolName | "final" | "refused";
  toolInput?: Record<string, unknown>;
  /** How much came back, never the whole payload, so the log stays readable. */
  resultSummary: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};
