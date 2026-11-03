import { ownerOf } from "@/app/api/chat/route";
import { runAgent } from "@/lib/agent";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * One bounded agent run. Not streamed: the point of this endpoint is the step log,
 * so the whole trace comes back with the answer and the UI can show both.
 */
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

  const { config, retrieve, store } = await getRuntime();
  const result = await runAgent({ config, retrieve, store }, { question, ownerId: ownerOf(request) });
  return Response.json({
    ...result,
    bounds: { maxSteps: config.maxAgentSteps, maxSpendUsd: config.maxAgentSpendUsd },
  });
}
