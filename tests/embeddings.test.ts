import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../src/lib/embeddings/fake";
import { VoyageEmbeddingProvider } from "../src/lib/embeddings/voyage";
import { cosine } from "../src/lib/hash";

describe("fake embedding provider", () => {
  it("produces stable vectors of the configured length", async () => {
    const a = new FakeEmbeddingProvider(256);
    const first = await a.embedQuery("hybrid retrieval combines vectors and full text");
    const second = await a.embedQuery("hybrid retrieval combines vectors and full text");
    expect(first).toHaveLength(256);
    expect(second).toEqual(first);
  });

  it("puts related text closer than unrelated text", async () => {
    const provider = new FakeEmbeddingProvider(256);
    const all = await provider.embedDocuments(["pgvector hnsw index for embeddings", "the bakery sold bread and jam", "hybrid search with pgvector index"]);
    expect(cosine(all[0]!, all[2]!)).toBeGreaterThan(cosine(all[0]!, all[1]!));
  });

  it("refuses a dimension that would make nonsense vectors", () => {
    expect(() => new FakeEmbeddingProvider(2)).toThrow(/at least 8/);
  });
});

describe("voyage embedding provider", () => {
  it("sends the documented request shape and reads the vectors back", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const inputs = (JSON.parse(String(init.body)).input as unknown[]).length;
      return new Response(JSON.stringify({ data: Array.from({ length: inputs }, () => ({ embedding: new Array(512).fill(0.1) })) }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new VoyageEmbeddingProvider("test-key-not-secret", 512, "voyage-4-lite", undefined, fakeFetch);
    const vector = await provider.embedQuery("what is the step limit");

    expect(calls[0]!.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(calls[0]!.body).toEqual({ input: ["what is the step limit"], model: "voyage-4-lite", input_type: "query", output_dimension: 512 });
    expect(vector).toHaveLength(512);

    await provider.embedDocuments(["doc one", "doc two"]);
    expect(calls[1]!.body.input_type).toBe("document");
    expect(calls[1]!.body.input).toEqual(["doc one", "doc two"]);
  });

  it("keeps the API key out of any message it throws", async () => {
    const failing = (async () => new Response("quota exceeded", { status: 429 })) as unknown as typeof fetch;
    const provider = new VoyageEmbeddingProvider("sk-secret-value", 1024, "voyage-4", undefined, failing);
    await expect(provider.embedQuery("anything")).rejects.toThrow(/429 quota exceeded/);
  });

  it("rejects a dimension the provider does not offer", () => {
    expect(() => new VoyageEmbeddingProvider("k", 768, "voyage-4")).toThrow(/256, 512, 1024 or 2048/);
    expect(() => new VoyageEmbeddingProvider("", 1024, "voyage-4")).toThrow(/VOYAGE_API_KEY/);
  });
});
