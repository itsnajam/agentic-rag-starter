import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../src/lib/embeddings/fake";
import { createRetriever, fuse, RRF_K } from "../src/lib/retrieval";
import { MemoryStore } from "../src/lib/store/memory";
import { PostgresStore, vectorLiteral } from "../src/lib/store/postgres";
import type { QueryExecutor } from "../src/lib/store/store";
import { docIdFor } from "../src/lib/ingest";
import type { Chunk, StoredChunk } from "../src/lib/types";

const provider = new FakeEmbeddingProvider(256);

function makeChunk(owner: string, path: string, content: string, index = 0): Chunk {
  return {
    docId: docIdFor(path),
    ownerId: owner,
    sourcePath: path,
    chunkIndex: index,
    content,
    contentHash: `${path}-${index}`,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

const ACME = [
  makeChunk("acme", "runbook.md", "Payments retry twice then park the charge. The step limit stops a runaway agent."),
  makeChunk("acme", "runbook.md", "A dropped connection leaves the cart intact because the server holds the state.", 1),
  makeChunk("acme", "pricing.md", "Small jobs start at a fixed floor. Bigger work is quoted after a call."),
];
const OTHER = [makeChunk("globex", "secrets.md", "Globex payroll export keys and the step limit policy for acme.")];

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore(256);
  for (const group of [ACME, OTHER]) {
    const vectors = await provider.embedDocuments(group.map((c) => c.content));
    await store.upsert(group, vectors);
  }
  return store;
}

describe("reciprocal rank fusion", () => {
  it("prefers a chunk both searches liked over one that topped a single list", () => {
    const stub = (id: string): StoredChunk => ({
      docId: `doc-${id}`,
      ownerId: "acme",
      sourcePath: `${id}.md`,
      chunkIndex: 0,
      content: `content for ${id}`,
      contentHash: `hash-${id}`,
      tokenEstimate: 3,
      id,
    });
    const hits = (ids: string[]) => ids.map((id) => ({ chunk: stub(id), similarity: 0.5 }));
    const keyword = (ids: string[]) => ids.map((id) => ({ chunk: stub(id), rank: 1 }));
    const merged = fuse(hits(["a", "b"]), keyword(["b", "c"]));
    expect(merged[0]!.id).toBe("b");
    expect(merged.find((m) => m.id === "b")!.via).toEqual(["vector", "keyword"]);
    expect(merged.find((m) => m.id === "b")!.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 8);
  });

  it("keeps every chunk that either list produced", () => {
    const stubbed = (id: string): StoredChunk => ({ docId: id, ownerId: "acme", sourcePath: `${id}.md`, chunkIndex: 0, content: id, contentHash: id, tokenEstimate: 1, id });
    const merged = fuse([{ chunk: stubbed("a"), similarity: 0.9 }], [{ chunk: stubbed("z"), rank: 2 }]);
    expect(merged.map((m) => m.id).sort()).toEqual(["a", "z"]);
  });
});

describe("hybrid retrieval", () => {
  it("finds an exact identifier that a paraphrase-friendly vector would blur", async () => {
    const store = await seeded();
    const retrieve = createRetriever(store, (t) => provider.embedQuery(t), { topK: 3, weakSimilarity: 0 });
    const found = await retrieve("which file documents the PARKED charge state?", "acme");
    expect(found.results.map((r) => r.sourcePath)).toContain("runbook.md");
  });

  it("refuses when nothing in the corpus can answer", async () => {
    const store = await seeded();
    const retrieve = createRetriever(store, (t) => provider.embedQuery(t), { topK: 3, weakSimilarity: 0 });
    const found = await retrieve("what is the lunar landing date", "acme");
    expect(found.weak).toBe(true);
    expect(["no-results", "low-confidence"]).toContain(found.reason);
  });

  it("refuses a question that only shares common English with the corpus", async () => {
    const store = await seeded();
    const retrieve = createRetriever(store, (t) => provider.embedQuery(t), { topK: 3, weakSimilarity: 0.9 });
    const found = await retrieve("what is the average humidity in the greenhouse", "acme");
    expect(found.weak).toBe(true);
    expect(found.reason).toBe("low-confidence");
    expect(found.rareTerms).toBe(0);
  });
});

describe("document permissions", () => {
  it("never returns another owner's chunks from any read path", async () => {
    const store = await seeded();
    const vector = await provider.embedQuery("step limit policy");

    const asAcme = await store.vectorSearch(vector, "acme", 10);
    const asGlobex = await store.vectorSearch(vector, "globex", 10);
    expect(asAcme.every((h) => h.chunk.ownerId === "acme")).toBe(true);
    expect(asAcme.some((h) => h.chunk.sourcePath === "secrets.md")).toBe(false);
    expect(asGlobex.every((h) => h.chunk.ownerId === "globex")).toBe(true);

    const keyword = await store.keywordSearch("step limit", "acme", 10);
    expect(keyword.some((h) => h.chunk.sourcePath === "secrets.md")).toBe(false);

    const globexChunk = await store.readChunk((await store.all("globex"))[0]!.id, "acme");
    expect(globexChunk).toBeNull();

    expect(await store.count("acme")).toBe(ACME.length);
    expect(await store.count("globex")).toBe(OTHER.length);
  });

  it("drives the same denial through the retriever for both owners", async () => {
    const store = await seeded();
    const retrieve = createRetriever(store, (t) => provider.embedQuery(t), { topK: 5, weakSimilarity: 0 });
    const leak = await retrieve("Globex payroll export keys", "acme");
    expect(leak.results.some((r) => r.sourcePath === "secrets.md")).toBe(false);
    const own = await retrieve("Globex payroll export keys", "globex");
    expect(own.results.some((r) => r.sourcePath === "secrets.md")).toBe(true);
  });
});

/** Records what the Postgres store would run, without needing a database. */
function recorder(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db: QueryExecutor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows };
    },
  };
  return { db, calls };
}

describe("postgres store statements", () => {
  it("filters by owner inside the SQL for every read", async () => {
    const { db, calls } = recorder();
    const store = new PostgresStore(db, 256);
    const vector = new Array(256).fill(0.1);

    await store.vectorSearch(vector, "acme", 5);
    await store.keywordSearch("step limit", "acme", 5);
    await store.readChunk("42", "acme");
    await store.count("acme");

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toMatch(/owner_id = \$\d/);
      expect(call.params).toContain("acme");
    }
    expect(calls[0]!.sql).toContain("<=>");
    expect(calls[1]!.sql).toContain("websearch_to_tsquery");
  });

  it("binds values instead of interpolating them", async () => {
    const { db, calls } = recorder();
    const store = new PostgresStore(db, 256);
    await store.keywordSearch("'; drop table chunks; --", "acme", 5);
    const params = calls[0]!.params;
    expect(calls[0]!.sql).not.toContain("drop table");
    expect(params).toContain("'; drop table chunks; --");
  });

  it("refuses a malformed vector rather than pasting it into SQL", () => {
    expect(vectorLiteral([0.1, 0.2])).toBe("[0.1,0.2]");
    expect(() => vectorLiteral([Number.NaN])).toThrow(/finite numbers/);
    expect(() => vectorLiteral([0.1, Number.POSITIVE_INFINITY])).toThrow(/finite numbers/);
  });

  it("re-embeds a changed document by deleting its own rows first", async () => {
    const existing = [{ chunk_index: 0, content_hash: "old-hash" }];
    const { db, calls } = recorder(existing);
    const store = new PostgresStore(db, 256);
    const chunk = makeChunk("acme", "runbook.md", "Completely rewritten content.");
    const result = await store.upsert([chunk], [new Array(256).fill(0.1)]);

    expect(result.replaced).toBe(1);
    const sql = calls.map((c) => c.sql).join(" ");
    expect(sql).toMatch(/delete from chunks where doc_id = \$1 and owner_id = \$2/);
    expect(sql).toMatch(/insert into chunks/);
  });
});
