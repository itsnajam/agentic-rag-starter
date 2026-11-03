import { Chat } from "@/components/Chat";
import { DEMO_USER, getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { config, embeddings, llm, store, mode } = await getRuntime();
  const chunks = await store.count(DEMO_USER);

  return (
    <main>
      <h1>Agentic RAG Starter</h1>
      <p className="lede">Chat over your own documents with citations, plus one bounded agent loop.</p>

      <div className="badges">
        <span className="badge">store: {mode === "memory" ? `in memory (${chunks} chunks indexed)` : "postgres + pgvector"}</span>
        <span className="badge">embeddings: {embeddings.name} {config.dimensions}d</span>
        <span className="badge">answers: {llm.name}</span>
        <span className="badge">model id: {config.claudeModel}</span>
        <span className="badge">top k: {config.topK}</span>
        <span className="badge">agent: max {config.maxAgentSteps} steps, $ max {config.maxAgentSpendUsd}</span>
      </div>

      <Chat defaultOwner={DEMO_USER} />

      <p className="hint">
        Without a key the answer comes from the offline extractor, which copies the sentence it found and labels itself. Add
        ANTHROPIC_API_KEY for Claude, and VOYAGE_API_KEY with EMBEDDING_PROVIDER=voyage for real retrieval. Set DATABASE_URL and
        run <code>npm run db:up</code>, <code>npm run db:migrate</code>, <code>npm run ingest ./docs</code> to index your own files.
      </p>
    </main>
  );
}
