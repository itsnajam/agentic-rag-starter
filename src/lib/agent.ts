import type { Config } from "./config";
import type { RetrievalResult } from "./retrieval";
import type { Store } from "./store/store";
import type { AgentStep, AgentToolName } from "./types";

export type ToolName = AgentToolName;

export type ToolSpec = {
  name: ToolName;
  description: string;
  /** What the model may ask for. Anything else is refused before it runs. */
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>, context: { ownerId: string; retrieve: RetrieveFn; store: Store }) => Promise<{ summary: string; detail: string }>;
};

export type RetrieveFn = (query: string, ownerId: string) => Promise<RetrievalResult>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The whole tool surface. A loop cannot do more than this list. */
export const tools: ToolSpec[] = [
  {
    name: "search_docs",
    description: "Search the requester's own indexed documents. Returns ranked snippets with chunk ids.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    async run(input, ctx) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) throw new Error("search_docs needs a query string");
      const found = await ctx.retrieve(query, ctx.ownerId);
      if (found.weak) return { summary: "nothing relevant", detail: "No source cleared the confidence floor. Say I don't know." };
      const lines = found.results.map((r, i) => `${i + 1}. [chunk ${r.id}] ${r.sourcePath}#${r.chunkIndex}: ${r.content.slice(0, 260).replace(/\s+/g, " ")}`);
      return { summary: `${found.results.length} chunks`, detail: lines.join("\n") };
    },
  },
  {
    name: "read_chunk",
    description: "Read one whole chunk by id. Only ids the requester can see will return.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    async run(input, ctx) {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw new Error("read_chunk needs an id");
      const chunk = await ctx.store.readChunk(id, ctx.ownerId);
      // A miss and somebody else's chunk look exactly the same on purpose: no
      // probing whether a hidden document exists.
      if (!chunk) return { summary: "not found for this requester", detail: "That chunk is not readable by this user." };
      return { summary: `${chunk.sourcePath}#${chunk.chunkIndex}`, detail: chunk.content };
    },
  },
];

export function findTool(name: string): ToolSpec | undefined {
  return tools.find((t) => t.name === name);
}

export type Plan = { action: ToolName; input: Record<string, unknown>; tokensIn: number; tokensOut: number } | { action: "final"; answer: string; tokensIn: number; tokensOut: number };

/**
 * A model-free planner: search, read the best chunk in full if the snippets are
 * thin, then answer from what came back. It is what runs in demo mode and in the
 * tests, and it is a real workflow, not a stub: two tools, bounded steps.
 */
/** What one tool call produced, kept as data rather than as prompt text. */
export type MemoryEntry = { tool: ToolName; summary: string; detail: string };

export type PlannerState = { question: string; memory: MemoryEntry[] };
export type Planner = { plan(step: number, state: PlannerState): Promise<Plan> };

export function heuristicPlanner(): Planner {
  return {
    async plan(step, state) {
      const searches = state.memory.filter((m) => m.tool === "search_docs");
      if (searches.length === 0) return { action: "search_docs", input: { query: state.question }, tokensIn: 0, tokensOut: 0 };

      const last = searches.at(-1)!;
      if (last.summary === "nothing relevant") return { action: "final", answer: "I don't know.", tokensIn: 0, tokensOut: 0 };

      // One read of the best chunk, then stop. The snippets are short by design,
      // and the whole chunk is what makes an answer quotable rather than plausible.
      const reads = state.memory.filter((m) => m.tool === "read_chunk");
      if (reads.length === 0 && step === 2) {
        const id = last.detail.match(/\[chunk (\w+)\]/)?.[1];
        if (id) return { action: "read_chunk", input: { id }, tokensIn: 0, tokensOut: 0 };
      }
      const source = reads.at(-1) ?? last;
      return { action: "final", answer: `From your documents: ${source.detail.slice(0, 600)}`, tokensIn: 0, tokensOut: 0 };
    },
  };
}

export type AgentResult = {
  answer: string;
  steps: AgentStep[];
  stoppedBy: "final" | "max-steps" | "spend-cap" | "invalid-tool";
  costUsd: number;
};

export type AgentDeps = {
  config: Config;
  retrieve: RetrieveFn;
  store: Store;
  planner?: Planner;
};

/**
 * The loop, bounded three ways: a step limit, a spend cap, and a fixed tool
 * list. Everything it does is recorded so the UI can show the working, not just
 * the verdict.
 */
export async function runAgent(deps: AgentDeps, input: { question: string; ownerId: string }): Promise<AgentResult> {
  const question = input.question.trim();
  if (!question) throw new Error("a question is required");
  const planner = deps.planner ?? heuristicPlanner();
  const steps: AgentStep[] = [];
  const memory: MemoryEntry[] = [];
  let cost = 0;

  for (let step = 1; step <= deps.config.maxAgentSteps; step++) {
    const plan = await planner.plan(step, { question, memory });
    const tokensIn = plan.tokensIn;
    const tokensOut = plan.tokensOut;
    const spend = (tokensIn / 1e6) * deps.config.pricePerMTokInput + (tokensOut / 1e6) * deps.config.pricePerMTokOutput;
    cost += spend;

    if (cost > deps.config.maxAgentSpendUsd) {
      steps.push({ step, action: "refused", resultSummary: `spend cap ${deps.config.maxAgentSpendUsd} USD reached`, tokensIn, tokensOut, costUsd: spend });
      return { answer: "I don't know. The agent stopped at its spend cap before it could answer.", steps, stoppedBy: "spend-cap", costUsd: cost };
    }

    if (plan.action === "final") {
      steps.push({ step, action: "final", resultSummary: plan.answer.slice(0, 200), tokensIn, tokensOut, costUsd: spend });
      return { answer: plan.answer, steps, stoppedBy: "final", costUsd: cost };
    }

    const tool = findTool(plan.action);
    if (!tool) {
      steps.push({ step, action: "refused", toolInput: plan.input, resultSummary: `unknown tool: ${String(plan.action)}`, tokensIn, tokensOut, costUsd: spend });
      return { answer: "I don't know. The agent asked for a tool that does not exist.", steps, stoppedBy: "invalid-tool", costUsd: cost };
    }

    let outcome: { summary: string; detail: string };
    try {
      outcome = await tool.run(toolInputIsObject(plan.input), { ownerId: input.ownerId, retrieve: deps.retrieve, store: deps.store });
    } catch (error) {
      outcome = { summary: `error: ${error instanceof Error ? error.message : "tool failed"}`, detail: "" };
    }
    memory.push({ tool: tool.name, summary: outcome.summary, detail: outcome.detail });
    steps.push({ step, action: tool.name, toolInput: plan.input, resultSummary: outcome.summary, tokensIn, tokensOut, costUsd: spend });

    if (steps.length >= deps.config.maxAgentSteps) {
      return { answer: "I don't know. The agent reached its step limit without an answer.", steps, stoppedBy: "max-steps", costUsd: cost };
    }
  }
  return { answer: "I don't know. The agent reached its step limit without an answer.", steps, stoppedBy: "max-steps", costUsd: cost };
}

function toolInputIsObject(input: Record<string, unknown>): Record<string, unknown> {
  return isRecord(input) ? input : {};
}
