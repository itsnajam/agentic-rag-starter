export type LlmMessage = { role: "user" | "assistant"; content: string };

export type LlmEvent = { type: "text"; text: string } | { type: "usage"; inputTokens: number; outputTokens: number };

/**
 * Answering and agent steps both go through this, so the offline path used by
 * tests, eval and the demo is the same shape as the real one.
 */
export type Llm = {
  readonly name: string;
  readonly isModel: boolean;
  stream(system: string, messages: readonly LlmMessage[], maxTokens: number): AsyncGenerator<LlmEvent>;
};
