import { loadConfig, type Config } from "../config";
import { FakeEmbeddingProvider } from "./fake";
import type { EmbeddingProvider } from "./provider";
import { VoyageEmbeddingProvider } from "./voyage";

export type { EmbeddingProvider } from "./provider";

export function createEmbeddingProvider(cfg: Config): EmbeddingProvider {
  if (cfg.embeddingProvider === "voyage") {
    return new VoyageEmbeddingProvider(cfg.voyageApiKey ?? "", cfg.dimensions, cfg.voyageModel);
  }
  return new FakeEmbeddingProvider(cfg.dimensions);
}

export function embeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  return createEmbeddingProvider(loadConfig(env));
}
