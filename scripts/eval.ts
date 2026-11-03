import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answer } from "../src/lib/answer";
import { loadConfig } from "../src/lib/config";
import { createEmbeddingProvider } from "../src/lib/embeddings/index";
import { collectFiles, fileToChunks } from "../src/lib/ingest";
import type { Llm } from "../src/lib/llm/llm";
import { OfflineLlm } from "../src/lib/llm/offline";
import { createRetriever } from "../src/lib/retrieval";
import { MemoryStore } from "../src/lib/store/memory";
import { createPostgresStore } from "../src/lib/store/postgres";
import type { Store } from "../src/lib/store/store";

type Expect = { sourcePath?: string; terms?: string[]; refuse?: boolean };
type Question = { id: string; question: string; expect: Expect };

const OWNER = "eval";

async function buildStore(config: ReturnType<typeof loadConfig>, embeddings: ReturnType<typeof createEmbeddingProvider>): Promise<{ store: Store; chunks: number }> {
  if (config.databaseUrl) {
    const store = await createPostgresStore(config.databaseUrl, config.dimensions);
    return { store, chunks: await store.count(OWNER) };
  }
  const store = new MemoryStore(config.dimensions);
  const dir = join(process.cwd(), "data", "corpus");
  let chunks = 0;
  for (const file of collectFiles(dir)) {
    const { chunks: pieces, warning } = await fileToChunks(file, { owner: OWNER, relativeTo: dir, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap });
    if (warning || pieces.length === 0) continue;
    const vectors = await embeddings.embedDocuments(pieces.map((p) => p.content));
    await store.upsert(pieces, vectors);
    chunks += pieces.length;
  }
  return { store, chunks };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const embeddings = createEmbeddingProvider(config);
  const { store, chunks } = await buildStore(config, embeddings);
  const llm: Llm = new OfflineLlm();
  const retrieve = createRetriever(store, (text) => embeddings.embedQuery(text), { topK: config.topK, weakSimilarity: config.weakScore });

  const questions = JSON.parse(readFileSync(join(process.cwd(), "eval/questions.json"), "utf8")) as Question[];
  const rows: string[] = [];
  let hits = 0;
  let answerable = 0;
  let cited = 0;
  let citationCheckable = 0;
  let supportCheckable = 0;
  let supported = 0;
  let refusalsOk = 0;
  let refusals = 0;
  let falseRefusals = 0;

  for (const q of questions) {
    const events = [];
    for await (const event of answer({ llm, config, retrieve }, { question: q.question, ownerId: OWNER })) events.push(event);

    const meta = events.find((e) => e.type === "meta")?.retrieval;
    const citationEvents = events.filter((e) => e.type === "citations").flatMap((e) => e.citations ?? []);
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    const refused = text.trim().startsWith("I don't know.");
    const paths = [...new Set(citationEvents.map((c) => c.sourcePath))];
    const found = await retrieve(q.question, OWNER);
    const rank = found.results.findIndex((r) => r.sourcePath === (q.expect.sourcePath ?? "")) + 1;

    if (q.expect.refuse) {
      refusals++;
      if (refused) refusalsOk++;
      else rows.push(`MISS refusal   ${q.id}: answered "${text.slice(0, 60)}..."`);
      continue;
    }

    answerable++;
    const hit = rank > 0 && rank <= config.topK;
    if (hit) hits++;
    if (meta?.weak) falseRefusals++;
    // Citing the right source is the spec metric. Whether the extracted sentence
    // actually contains the fact is reported separately, because a one-sentence
    // offline responder can name the right document and still quote the wrong
    // line of it, and pretending those are the same number hides a real gap.
    const citesRightSource = paths.includes(q.expect.sourcePath ?? "");
    if (q.expect.sourcePath) {
      citationCheckable++;
      if (citesRightSource) cited++;
    }
    const wantsTerms = q.expect.terms ?? [];
    const factSupported = wantsTerms.every((t) => text.toLowerCase().includes(t.toLowerCase()));
    if (wantsTerms.length > 0) {
      supportCheckable++;
      if (factSupported) supported++;
    }
    rows.push(
      `${hit ? "HIT " : "MISS"} ${String(rank || "-").padStart(2)}/${config.topK}  ${q.id.padEnd(22)} source=${citesRightSource ? "ok" : "no"} fact=${wantsTerms.length ? (factSupported ? "ok" : "no") : "-"} weak=${meta?.weak ? "yes" : "no"}  [${paths.join(", ") || "none"}]`
    );
  }

  const hitRate = answerable ? hits / answerable : 0;
  const citeRate = citationCheckable ? cited / citationCheckable : 0;
  const supportRate = supportCheckable ? supported / supportCheckable : 1;
  const refusalRate = refusals ? refusalsOk / refusals : 1;

  console.log(rows.join("\n"));
  console.log(`\nprovider: ${embeddings.name} (${config.dimensions}d)  store: ${store.name}  llm: ${llm.name}  chunks: ${chunks}`);
  console.log(`retrieval hit rate @${config.topK}: ${hits}/${answerable} = ${(hitRate * 100).toFixed(1)}%`);
  console.log(`cited the right source:            ${cited}/${citationCheckable} = ${(citeRate * 100).toFixed(1)}%`);
  console.log(`answer contains the expected fact: ${supported}/${supportCheckable} = ${(supportRate * 100).toFixed(1)}%  (informational)`);
  console.log(`correct refusals:                  ${refusalsOk}/${refusals} = ${(refusalRate * 100).toFixed(1)}%  (informational: see the note below)`);
  console.log(`answers wrongly refused:           ${falseRefusals}/${answerable}`);

  if (embeddings.name === "fake") {
    console.log("\nnote: the fake provider proves the plumbing (chunking, fusion, permissions, citations, refusal paths).");
    console.log("it says nothing about real search quality. Set EMBEDDING_PROVIDER=voyage and VOYAGE_API_KEY to measure that.");
  }

  // Gated on the two metrics that are measurable without a language model: did
  // retrieval put the right document in the top k, and did the answer cite it.
  // Refusal accuracy is printed but not gated here, because judging whether a
  // corpus can answer a question is a language task, and the 256-dimension fake
  // provider cannot tell "hosted version cost" from "chunk cost". The refusal
  // path itself is covered by tests/injection.test.ts on a clean corpus.
  const failing = hitRate < 0.8 || citeRate < 0.8 || falseRefusals > 0;
  if (failing) console.error("\neval failed its thresholds");
  else console.log("\neval passed its thresholds");
  return failing ? 1 : 0;
}

if (process.argv[1]?.endsWith("scripts/eval.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
