import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { chunk } from "./chunking";
import { sha256 } from "./hash";
import { pdfToText } from "./pdf";
import type { Chunk } from "./types";

const SUPPORTED = new Set([".md", ".markdown", ".txt", ".pdf"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "dist"]);

export function isSupported(path: string): boolean {
  return SUPPORTED.has(extname(path).toLowerCase());
}

/**
 * A document's stable id comes from its path, not its bytes, because re-indexing
 * an edited file has to find and replace the chunks that file already owns. The
 * content hash does the change detection one level down, per chunk.
 */
export function docIdFor(sourcePath: string): string {
  return sha256(sourcePath.split(sep).join("/")).slice(0, 16);
}

/** Sorted, so two runs over the same corpus produce the same ids. */
export function collectFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`no such path: ${root}`);
  if (statSync(root).isFile()) return [root];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...collectFiles(join(root, entry.name)));
    } else if (entry.isFile() && isSupported(entry.name)) {
      found.push(join(root, entry.name));
    }
  }
  return found.sort();
}

export type ReadOptions = { owner: string; relativeTo?: string; chunkSize: number; chunkOverlap: number };

export type FileChunks = { path: string; chunks: Chunk[]; warning?: string };

/** Turn one file into chunks. Unsupported extensions throw rather than return nothing. */
export async function fileToChunks(absPath: string, opts: ReadOptions): Promise<FileChunks> {
  const ext = extname(absPath).toLowerCase();
  if (!isSupported(absPath)) throw new Error(`unsupported file type "${ext}": ingest takes .md, .markdown, .txt and .pdf`);

  const raw = readFileSync(absPath);
  const text = ext === ".pdf" ? await pdfToText(new Uint8Array(raw)) : raw.toString("utf8");
  if (!text.trim()) {
    return { path: absPath, chunks: [], warning: ext === ".pdf" ? "no text layer (a scanned PDF needs OCR first)" : "empty file" };
  }

  const pieces = chunk(text, { size: opts.chunkSize, overlap: opts.chunkOverlap });
  const shown = opts.relativeTo && absPath.startsWith(opts.relativeTo) ? absPath.slice(opts.relativeTo.length + 1) : absPath;
  const docId = docIdFor(shown);
  return {
    path: absPath,
    chunks: pieces.map((content, chunkIndex) => ({
      docId,
      ownerId: opts.owner,
      sourcePath: shown,
      chunkIndex,
      content,
      contentHash: sha256(content).slice(0, 32),
      tokenEstimate: Math.ceil(content.length / 4),
    })),
  };
}
