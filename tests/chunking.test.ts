import { describe, expect, it } from "vitest";
import { chunk } from "../src/lib/chunking";

const OPTIONS = { size: 200, overlap: 40 };

describe("chunking", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunk("", OPTIONS)).toEqual([]);
    expect(chunk("   \n\n  ", OPTIONS)).toEqual([]);
  });

  it("keeps a short document as one chunk", () => {
    const text = "HNSW is the honest default for a corpus this size.";
    expect(chunk(text, OPTIONS)).toEqual([text]);
  });

  it("never exceeds the requested size, even when a paragraph is huge", () => {
    const text = `${"alpha ".repeat(120)}\n\n${"beta ".repeat(150)}\n\nshort tail sentence here.`;
    const pieces = chunk(text, OPTIONS);
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(OPTIONS.size);
  });

  it("carries overlap forward so a fact on the boundary survives", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} explains retrieval quality in plain terms.`);
    const pieces = chunk(sentences.join("\n\n"), { size: 160, overlap: 60 });
    expect(pieces.length).toBeGreaterThan(1);
    // The next chunk should open with text that is still inside the previous one.
    const carried = pieces.slice(1).filter((next, i) => {
      const head = next.slice(0, 20);
      return head.length > 8 && pieces[i]!.includes(head);
    });
    expect(carried.length).toBe(pieces.length - 1);
  });

  it("is deterministic, so re-running ingest does not churn the index", () => {
    const text = "One sentence.\n\nAnother sentence about a different topic.\n\nThird one, longer than the others by a fair margin indeed.";
    expect(chunk(text, OPTIONS)).toEqual(chunk(text, OPTIONS));
  });

  it("refuses sizes that cannot produce a sensible split", () => {
    expect(() => chunk("text", { size: 0, overlap: 0 })).toThrow(/positive integer/);
    expect(() => chunk("text", { size: 100, overlap: 100 })).toThrow(/not including the chunk size/);
    expect(() => chunk("text", { size: 100, overlap: -1 })).toThrow(/not including the chunk size/);
  });

  it("hard-splits a single long word run rather than dropping it", () => {
    const pieces = chunk(`x${"y".repeat(500)}`, { size: 100, overlap: 10 });
    expect(pieces.join("").replace(/\s/g, "").length).toBeGreaterThan(480);
  });
});
