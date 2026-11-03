import type { EmbeddingProvider } from "./provider";

/**
 * Voyage text embeddings, which is what Anthropic's docs point at now that they
 * ship no embedding model of their own.
 *
 * Shape taken from the provider docs: POST https://api.voyageai.com/v1/embeddings
 * with `input`, `model`, optional `input_type` and optional `output_dimension`
 * (256, 512, 1024 or 2048). `input_type` is set to document or query because the
 * model family is trained asymmetrically and the wrong value costs relevance.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  constructor(
    private readonly apiKey: string,
    readonly dimensions: number,
    private readonly model: string,
    private readonly endpoint = "https://api.voyageai.com/v1/embeddings",
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!apiKey) throw new Error("voyage embeddings need VOYAGE_API_KEY");
    if (![256, 512, 1024, 2048].includes(dimensions)) {
      throw new Error(`voyage output_dimension must be 256, 512, 1024 or 2048, got ${dimensions}`);
    }
  }

  private async call(texts: readonly string[], inputType: "document" | "query"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: [...texts],
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
      }),
    });
    if (!response.ok) {
      throw new Error(`voyage embeddings failed: ${response.status} ${await safeBody(response)}`);
    }
    const json = (await response.json()) as { data?: { embedding?: number[] }[] };
    const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
    if (vectors.length !== texts.length) throw new Error(`voyage returned ${vectors.length} vectors for ${texts.length} inputs`);
    for (const v of vectors) {
      if (v.length !== this.dimensions) throw new Error(`voyage returned ${v.length} dimensions, expected ${this.dimensions}`);
    }
    return vectors;
  }

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return this.call(texts, "document");
  }

  embedQuery(text: string): Promise<number[]> {
    return this.call([text], "query").then((v) => v[0]!);
  }
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "no body";
  }
}
