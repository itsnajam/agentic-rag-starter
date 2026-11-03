import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../src/lib/embeddings/fake";
import { collectFiles, docIdFor, fileToChunks } from "../src/lib/ingest";
import { MemoryStore } from "../src/lib/store/memory";

const OPTIONS = { chunkSize: 400, chunkOverlap: 60 };
const root = mkdtempSync(join(tmpdir(), "rag-ingest-"));
const pdfFixture = fileURLToPath(new URL("./fixtures/notes.pdf", import.meta.url));

async function index(store: MemoryStore, provider: FakeEmbeddingProvider, file: string, owner = "acme") {
  const { chunks } = await fileToChunks(file, { owner, relativeTo: root, ...OPTIONS });
  return store.upsert(chunks, await provider.embedDocuments(chunks.map((c) => c.content)));
}

describe("ingest", () => {
  beforeAll(() => {
    writeFileSync(join(root, "guide.md"), "# Guide\n\nRun npm run ingest to index a folder.\n\nHybrid search merges two rankings.\n");
    writeFileSync(join(root, "notes.txt"), "Plain text notes about the deployment runbook.");
    writeFileSync(join(root, "empty.md"), "   \n");
    writeFileSync(join(root, "image.png"), "not really a png");
  });

  it("collects supported files only, in a stable order", () => {
    const found = collectFiles(root).map((f) => f.split("/").pop());
    expect(found).toEqual(["empty.md", "guide.md", "notes.txt"]);
  });

  it("names a document by its path, so an edit keeps the same identity", () => {
    writeFileSync(join(root, "changing.md"), "First version of the document.");
    const before = docIdFor(join(root, "changing.md"));
    writeFileSync(join(root, "changing.md"), "Second version, completely rewritten from the top.");
    expect(docIdFor(join(root, "changing.md"))).toBe(before);
  });

  it("strips the corpus root so citations show a readable path", async () => {
    const { chunks } = await fileToChunks(join(root, "guide.md"), { owner: "acme", relativeTo: root, ...OPTIONS });
    expect(chunks[0]!.sourcePath).toBe("guide.md");
    expect(chunks[0]!.content).toContain("Hybrid search");
  });

  it("reports an empty file instead of indexing nothing silently", async () => {
    const { chunks, warning } = await fileToChunks(join(root, "empty.md"), { owner: "acme", relativeTo: root, ...OPTIONS });
    expect(chunks).toEqual([]);
    expect(warning).toMatch(/empty file/);
  });

  it("refuses a file type it cannot read", async () => {
    await expect(fileToChunks(join(root, "image.png"), { owner: "acme", ...OPTIONS })).rejects.toThrow(/unsupported file type/);
  });

  it("extracts text from a real PDF", async () => {
    const { chunks, warning } = await fileToChunks(pdfFixture, { owner: "acme", ...OPTIONS });
    expect(warning).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.content).toContain("Vector similarity finds paraphrase");
  });

  it("is idempotent: an unchanged file skips, a changed one replaces its own chunks", async () => {
    const store = new MemoryStore(256);
    const provider = new FakeEmbeddingProvider(256);
    writeFileSync(join(root, "loop.md"), "# Loop\n\nOne paragraph about step limits.\n\nAnother about spend caps.\n");
    const file = join(root, "loop.md");

    const first = await index(store, provider, file);
    expect(first.inserted).toBeGreaterThan(0);
    const afterFirst = await store.count("acme");

    const second = await index(store, provider, file);
    expect(second.inserted).toBe(0);
    expect(second.replaced).toBe(0);
    expect(second.skipped).toBe(first.inserted);
    expect(await store.count("acme")).toBe(afterFirst);

    writeFileSync(file, "# Loop\n\nStep limits stop a runaway agent before it spends the afternoon.\n");
    const third = await index(store, provider, file);
    expect(third.replaced).toBeGreaterThan(0);
    // The old paragraphs are gone, not stacked next to the new ones.
    const all = await store.all("acme");
    expect(all.some((c) => c.content.includes("Another about spend caps."))).toBe(false);
    expect(all.filter((c) => c.sourcePath === "loop.md")).toHaveLength(third.replaced);
  });

  it("rejects an embedding of the wrong length rather than mixing dimensions", async () => {
    const store = new MemoryStore(64);
    const { chunks } = await fileToChunks(join(root, "guide.md"), { owner: "acme", relativeTo: root, ...OPTIONS });
    await expect(store.upsert(chunks, chunks.map(() => new Array(32).fill(0.1)))).rejects.toThrow(/dimensions/);
  });
});
