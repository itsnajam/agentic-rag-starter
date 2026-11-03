import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { embeddingProviderFromEnv } from "./embeddings/index";
import type { EmbeddingProvider } from "./embeddings/provider";
import { collectFiles, fileToChunks } from "./ingest";
import { createAnthropicLlm } from "./llm/anthropic";
import type { Llm } from "./llm/llm";
import { OfflineLlm } from "./llm/offline";
import { createRetriever, type Retrieve } from "./retrieval";
import { MemoryStore } from "./store/memory";
import { createPostgresStore } from "./store/postgres";
import type { Store } from "./store/store";

export type Runtime = {
  config: Config;
  embeddings: EmbeddingProvider;
  store: Store;
  retrieve: Retrieve;
  llm: Llm;
  /** "memory" when no DATABASE_URL is set, so the demo needs nothing installed. */
  mode: "memory" | "postgres";
};

/** Who is asking. Real deployments replace this with their session identity. */
export const DEMO_USER = "demo";

/**
 * Without a database the app indexes `data/corpus` into memory at startup, so a
 * clone can answer questions in thirty seconds with no keys and no containers.
 */
async function seedMemory(store: MemoryStore, embeddings: EmbeddingProvider, config: Config): Promise<number> {
  const dir = join(process.cwd(), "data", "corpus");
  let total = 0;
  for (const abs of collectFiles(dir)) {
    const { chunks, warning } = await fileToChunks(abs, { owner: DEMO_USER, relativeTo: dir, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap });
    if (warning || chunks.length === 0) continue;
    const vectors = await embeddings.embedDocuments(chunks.map((c) => c.content));
    const result = await store.upsert(chunks, vectors);
    total += result.inserted + result.replaced;
  }
  return total;
}

let cached: Promise<Runtime> | null = null;

/** One runtime per process: building it touches the filesystem and the database. */
export function getRuntime(): Promise<Runtime> {
  cached ??= build().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

async function build(): Promise<Runtime> {
  const config = loadConfig();
  const embeddings = embeddingProviderFromEnv();

  let store: Store;
  let mode: Runtime["mode"];
  if (config.databaseUrl) {
    store = await createPostgresStore(config.databaseUrl, config.dimensions);
    mode = "postgres";
  } else {
    const memory = new MemoryStore(config.dimensions);
    await seedMemory(memory, embeddings, config);
    store = memory;
    mode = "memory";
  }

  const retrieve = createRetriever(store, (text) => embeddings.embedQuery(text), {
    topK: config.topK,
    weakSimilarity: config.weakScore,
  });

  const llm: Llm = config.anthropicApiKey ? await createAnthropicLlm(config.anthropicApiKey, config.claudeModel) : new OfflineLlm();

  return { config, embeddings, store, retrieve, llm, mode };
}
