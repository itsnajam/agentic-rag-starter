"use client";

import { useState } from "react";
import type { AgentStepView } from "./StepLog";
import { StepLog } from "./StepLog";

type CitationView = { index: number; sourcePath: string; chunkIndex: number; snippet: string };

type Event =
  | { type: "meta"; retrieval: { weak: boolean; reason: string | null; topSimilarity: number; llm: string } }
  | { type: "text"; text: string }
  | { type: "citations"; citations: CitationView[] }
  | { type: "done"; refused: boolean };

const SUGGESTIONS = [
  "Why carry text over into the next chunk?",
  "What does the fake embedding provider tell you about real search quality?",
  "What gets stripped out of retrieved text before it is wrapped in delimiters?",
];

export function Chat({ defaultOwner }: { defaultOwner: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<CitationView[]>([]);
  const [steps, setSteps] = useState<AgentStepView[]>([]);
  const [meta, setMeta] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [owner, setOwner] = useState(defaultOwner);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setAnswer("");
    setCitations([]);
    setSteps([]);
    setMeta("");
    try {
      const response = await fetch(agentMode ? "/api/agent" : "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": owner },
        body: JSON.stringify({ question: text }),
      });
      if (!response.ok) {
        setAnswer(`The server refused: ${(await response.text()).slice(0, 200)}`);
        return;
      }
      if (agentMode) {
        const result = (await response.json()) as { answer: string; steps: AgentStepView[]; stoppedBy: string; costUsd: number };
        setAnswer(result.answer);
        setSteps(result.steps ?? []);
        setMeta(`stopped by ${result.stoppedBy} | estimated cost $${result.costUsd.toFixed(6)}`);
        return;
      }
      // NDJSON, one event per line, read as it arrives.
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let stream = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as Event;
          if (event.type === "text") {
            stream += event.text;
            setAnswer(stream);
          } else if (event.type === "citations") {
            setCitations(event.citations);
          } else if (event.type === "meta") {
            setMeta(`${event.retrieval.llm} | top similarity ${event.retrieval.topSimilarity}${event.retrieval.weak ? " | retrieval judged weak" : ""}`);
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="badges">
        <label className="badge">
          <input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} /> agent mode
        </label>
        <label className="badge">
          as user{" "}
          <input
            type="text"
            value={owner}
            size={10}
            onChange={(e) => setOwner(e.target.value.replace(/[^\w.-]/g, "").slice(0, 64))}
            aria-label="user id used for document permissions"
          />
        </label>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          type="text"
          value={question}
          placeholder="Ask something your documents can answer"
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="question"
        />
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Working" : agentMode ? "Run agent" : "Ask"}
        </button>
      </form>

      <div className="hint">
        Try:{" "}
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => setQuestion(s)} style={{ marginRight: 6, marginBottom: 6 }}>
            {s}
          </button>
        ))}
      </div>

      <div className="answer" aria-live="polite">
        {answer || (agentMode ? "The agent will search, read one chunk if it needs to, then answer with its steps listed below." : "The answer appears here, with the sources it used.")}
      </div>

      {meta ? <p className="hint">{meta}</p> : null}

      {citations.length > 0 ? (
        <ul className="citations">
          {citations.map((c) => (
            <li key={`${c.index}-${c.sourcePath}-${c.chunkIndex}`}>
              [{c.index}] <code>{c.sourcePath}</code> chunk {c.chunkIndex}: {c.snippet.slice(0, 180)}
            </li>
          ))}
        </ul>
      ) : null}

      {steps.length > 0 ? <StepLog steps={steps} /> : null}
    </>
  );
}
