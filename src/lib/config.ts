// One place where every tunable comes from, so a reader can change behaviour
// without hunting through the code. Nothing here reaches for the network.

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_VOYAGE_MODEL = "voyage-4-lite";
/** Voyage's own docs list 256, 512, 1024 and 2048 as the supported output sizes. */
export const ALLOWED_DIMENSIONS = [256, 512, 1024, 2048] as const;

export type EmbeddingProviderName = "fake" | "voyage";

export type Config = {
  claudeModel: string;
  anthropicApiKey: string | undefined;
  embeddingProvider: EmbeddingProviderName;
  voyageApiKey: string | undefined;
  voyageModel: string;
  dimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  /** Below this fused score the answer is a refusal, not a guess. */
  weakScore: number;
  maxAgentSteps: number;
  /** Stop the loop once estimated spend passes this. */
  maxAgentSpendUsd: number;
  pricePerMTokInput: number;
  pricePerMTokOutput: number;
  databaseUrl: string | undefined;
  /** True when there is no database: the app runs on the in-memory store. */
  demoMode: boolean;
};

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.EMBEDDING_PROVIDER ?? "fake") as EmbeddingProviderName;
  if (provider !== "fake" && provider !== "voyage") {
    throw new Error(`EMBEDDING_PROVIDER must be "fake" or "voyage", got "${provider}"`);
  }
  const dimensions = int(env.EMBEDDING_DIMENSIONS, provider === "fake" ? 256 : 1024, "EMBEDDING_DIMENSIONS");
  if (provider === "voyage" && !(ALLOWED_DIMENSIONS as readonly number[]).includes(dimensions)) {
    throw new Error(`EMBEDDING_DIMENSIONS must be one of ${ALLOWED_DIMENSIONS.join(", ")} for voyage, got ${dimensions}`);
  }
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  const chunkSize = int(env.CHUNK_SIZE, 900, "CHUNK_SIZE");
  const chunkOverlap = int(env.CHUNK_OVERLAP, 150, "CHUNK_OVERLAP");
  if (chunkOverlap >= chunkSize) throw new Error("CHUNK_OVERLAP must be smaller than CHUNK_SIZE");

  return {
    claudeModel: env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    embeddingProvider: provider,
    voyageApiKey: env.VOYAGE_API_KEY?.trim() || undefined,
    voyageModel: env.VOYAGE_MODEL?.trim() || DEFAULT_VOYAGE_MODEL,
    dimensions,
    chunkSize,
    chunkOverlap,
    topK: int(env.RETRIEVAL_TOP_K, 5, "RETRIEVAL_TOP_K"),
    weakScore: Number(env.RETRIEVAL_WEAK_SCORE ?? 0.02),
    maxAgentSteps: int(env.AGENT_MAX_STEPS, 6, "AGENT_MAX_STEPS"),
    maxAgentSpendUsd: Number(env.AGENT_MAX_SPEND_USD ?? 0.25),
    pricePerMTokInput: Number(env.COST_PER_M_INPUT_USD ?? 3),
    pricePerMTokOutput: Number(env.COST_PER_M_OUTPUT_USD ?? 15),
    databaseUrl,
    demoMode: !databaseUrl,
  };
}
