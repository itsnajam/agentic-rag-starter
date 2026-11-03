import { answer, encodeEvent } from "@/lib/answer";
import type { LlmMessage } from "@/lib/llm/llm";
import { DEMO_USER, getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * Who is asking. A real deployment takes this from its session; the demo reads a
 * header so two browser tabs can show that one cannot see the other's documents.
 */
export function ownerOf(request: Request): string {
  const header = request.headers.get("x-user-id") ?? "";
  return /^[\w.-]{1,64}$/.test(header) ? header : DEMO_USER;
}

function historyOf(value: unknown): LlmMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is { role: string; content: string } => !!m && typeof m === "object" && typeof (m as { content?: unknown }).content === "string")
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as LlmMessage["role"], content: m.content }))
    .slice(-6);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const question = typeof (body as { question?: unknown })?.question === "string" ? String((body as { question: unknown }).question) : "";
  if (!question.trim()) return Response.json({ error: "question is required" }, { status: 400 });
  if (question.length > 2000) return Response.json({ error: "question is too long" }, { status: 413 });

  const { llm, config, retrieve } = await getRuntime();
  const owner = ownerOf(request);
  const history = historyOf((body as { history?: unknown }).history);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of answer({ llm, config, retrieve }, { question, ownerId: owner, history })) {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        }
      } catch (error) {
        // The reader needs to know the answer stopped early rather than look short.
        const message = error instanceof Error ? error.message : "answer failed";
        controller.enqueue(encoder.encode(encodeEvent({ type: "text", text: `\n\n[stopped: ${message}]` })));
        controller.enqueue(encoder.encode(encodeEvent({ type: "done", refused: false })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
