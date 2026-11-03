import { describe, expect, it } from "vitest";
import { findTool, heuristicPlanner, runAgent, tools, type Plan } from "../src/lib/agent";
import { loadConfig } from "../src/lib/config";
import { FakeEmbeddingProvider } from "../src/lib/embeddings/fake";
import { createRetriever } from "../src/lib/retrieval";
import { MemoryStore } from "../src/lib/store/memory";
import type { RetrievalResult } from "../src/lib/retrieval";
import type { Chunk, Retrieved } from "../src/lib/types";

const provider = new FakeEmbeddingProvider(256);

function chunkOf(owner: string, path: string, content: string, id: string): Chunk & { id: string } {
  return { docId: `doc-${id}`, ownerId: owner, sourcePath: path, chunkIndex: 0, content, contentHash: `hash-${id}`, tokenEstimate: 5, id };
}

function empty(): RetrievalResult {
  return { results: [], weak: true, reason: "no-results", topSimilarity: 0, lexicalOverlap: false, matchedTerms: 0, rareTerms: 0 };
}

async function fixture(ownerChunks: (Chunk & { id: string })[]) {
  const store = new MemoryStore(256);
  for (const c of ownerChunks) await store.upsert([c], [await provider.embedQuery(c.content)]);
  const retrieve = createRetriever(store, (t) => provider.embedQuery(t), { topK: 3, weakSimilarity: 0 });
  const config = loadConfig({ AGENT_MAX_STEPS: "4" } as unknown as NodeJS.ProcessEnv);
  return { store, retrieve, config };
}

function scripted(plans: Plan[]): { plan(step: number): Promise<Plan> } {
  let i = 0;
  return {
    async plan() {
      const next = plans[i] ?? plans.at(-1)!;
      i++;
      return next;
    },
  };
}

const ACME_CHUNK = chunkOf("acme", "runbook.md", "The step limit stops a runaway agent before it spends the afternoon.", "1");
const GLOBEX_CHUNK = chunkOf("globex", "payroll.md", "Globex payroll keys and rotation schedule.", "2");

describe("the tool surface", () => {
  it("offers exactly two read-only tools", () => {
    expect(tools.map((t) => t.name)).toEqual(["search_docs", "read_chunk"]);
    expect(findTool("delete_documents")).toBeUndefined();
  });

  it("search_docs refuses an empty query rather than dumping the corpus", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    await expect(tools[0]!.run({ query: "   " }, { ownerId: "acme", retrieve, store })).rejects.toThrow(/needs a query/);
  });

  it("read_chunk gives another owner's id and a missing id the same answer", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK, GLOBEX_CHUNK]);
    void config;
    const foreign = await tools[1]!.run({ id: "2" }, { ownerId: "acme", retrieve, store });
    const missing = await tools[1]!.run({ id: "does-not-exist" }, { ownerId: "acme", retrieve, store });
    expect(foreign.summary).toMatch(/not found/i);
    expect(missing.summary).toBe(foreign.summary);
    expect(foreign.detail).not.toContain("payroll");
  });
});

describe("the bounded agent loop", () => {
  it("runs the tools in order and logs every step", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    const result = await runAgent(
      {
        config,
        retrieve,
        store,
        planner: scripted([
          { action: "search_docs", input: { query: "step limit" }, tokensIn: 100, tokensOut: 20 },
          { action: "read_chunk", input: { id: "1" }, tokensIn: 200, tokensOut: 30 },
          { action: "final", answer: "The step limit is four.", tokensIn: 50, tokensOut: 10 },
        ]),
      },
      { question: "what stops a runaway agent?", ownerId: "acme" }
    );

    expect(result.answer).toBe("The step limit is four.");
    expect(result.stoppedBy).toBe("final");
    expect(result.steps.map((s) => s.action)).toEqual(["search_docs", "read_chunk", "final"]);
    expect(result.steps[0]!.resultSummary).toMatch(/chunks|nothing relevant/);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("stops at the step limit and says it does not know", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    const result = await runAgent(
      { config, retrieve, store, planner: scripted([{ action: "search_docs", input: { query: "step limit" }, tokensIn: 1, tokensOut: 1 }]) },
      { question: "what stops a runaway agent?", ownerId: "acme" }
    );
    expect(result.steps).toHaveLength(config.maxAgentSteps);
    expect(result.stoppedBy).toBe("max-steps");
    expect(result.answer.startsWith("I don't know.")).toBe(true);
  });

  it("stops at the spend cap before it can overspend", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    const capped = { ...config, maxAgentSpendUsd: 0.001 };
    const result = await runAgent(
      {
        config: capped,
        retrieve,
        store,
        planner: scripted([
          { action: "search_docs", input: { query: "step limit" }, tokensIn: 1_000_000, tokensOut: 100 },
          { action: "final", answer: "should never get here", tokensIn: 0, tokensOut: 0 },
        ]),
      },
      { question: "what stops a runaway agent?", ownerId: "acme" }
    );
    expect(result.stoppedBy).toBe("spend-cap");
    expect(result.steps.at(-1)!.action).toBe("refused");
    expect(result.answer.startsWith("I don't know.")).toBe(true);
  });

  it("refuses a tool that is not on the list, even if something asked for it", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    const result = await runAgent(
      { config, retrieve, store, planner: scripted([{ action: "delete_documents" as never, input: { ids: ["1"] }, tokensIn: 0, tokensOut: 0 }]) },
      { question: "anything", ownerId: "acme" }
    );
    expect(result.stoppedBy).toBe("invalid-tool");
    expect(result.steps.at(-1)!.resultSummary).toMatch(/unknown tool/);
    expect(result.answer.startsWith("I don't know.")).toBe(true);
  });

  it("rejects an empty question", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    await expect(runAgent({ config, retrieve, store }, { question: "  ", ownerId: "acme" })).rejects.toThrow(/question is required/);
  });

  it("the offline planner answers from search and refuses when nothing matched", async () => {
    const { store, retrieve, config } = await fixture([ACME_CHUNK]);
    const found = await runAgent({ config, retrieve, store, planner: heuristicPlanner() }, { question: "step limit runaway agent", ownerId: "acme" });
    expect(found.stoppedBy).toBe("final");
    expect(found.steps[0]!.action).toBe("search_docs");
    expect(found.answer).toContain("step limit");

    const nothing = await runAgent({ config, retrieve: async () => empty(), store, planner: heuristicPlanner() }, { question: "lunar landing date", ownerId: "acme" });
    expect(nothing.answer.startsWith("I don't know.")).toBe(true);
  });
});
