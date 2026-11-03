import { tokenize } from "../store/memory";
import type { Llm, LlmEvent, LlmMessage } from "./llm";

/**
 * A deterministic extractive responder for tests, `npm run eval` and the demo
 * mode. It reads only the retrieved sources, copies sentences that contain a
 * query term, and labels itself as extraction on every line, so nobody mistakes
 * it for a model answer.
 *
 * It is also inert by construction: nothing in a source can make it do anything
 * except be selected as text, which is why the injection test runs against it.
 */
export class OfflineLlm implements Llm {
  readonly name = "offline-extractive";
  readonly isModel = false;

  /** The last prompt, so a test can assert what this responder was handed. */
  lastSystem = "";
  lastMessages: LlmMessage[] = [];

  async *stream(system: string, messages: readonly LlmMessage[]): AsyncGenerator<LlmEvent> {
    this.lastSystem = system;
    this.lastMessages = [...messages];
    const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const sources = parseSources(system);
    const answer = extract(question, sources);
    yield { type: "text", text: answer };
    yield { type: "usage", inputTokens: Math.ceil(system.length / 4), outputTokens: Math.ceil(answer.length / 4) };
  }
}

export type Source = { index: number; path: string; content: string };

const SOURCE_BLOCK = /<source index="(\d+)" path="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/source>/g;

export function parseSources(system: string): Source[] {
  const out: Source[] = [];
  for (const m of system.matchAll(SOURCE_BLOCK)) {
    out.push({ index: Number(m[1]), path: m[2], content: m[3]! });
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * One sentence per source, the one that shares the most distinct query terms.
 * Taking the first sentence that contains any term at all produced a citation
 * that was technically on-topic and did not contain the number being asked for.
 */
function bestSentence(source: Source, terms: readonly string[]): string | undefined {
  let best: { text: string; hits: number } | undefined;
  for (const s of sentences(source.content)) {
    const lower = s.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { text: s, hits };
  }
  return best?.text;
}

function extract(question: string, sources: readonly Source[]): string {
  if (sources.length === 0) return "I don't know. Nothing was retrieved for this question.";
  const terms = [...new Set(tokenize(question))];
  const picked: string[] = [];
  for (const source of sources) {
    const match = bestSentence(source, terms);
    if (match) picked.push(`${match} [${source.index}]`);
    if (picked.length >= 3) break;
  }
  if (picked.length === 0) return "I don't know. The retrieved sources do not answer this question.";
  return `[offline extraction, not a model answer] ${picked.join(" ")}`;
}
