import { resolve } from "node:path";
import { loadConfig } from "../src/lib/config";
import { createEmbeddingProvider } from "../src/lib/embeddings/index";
import { collectFiles, fileToChunks } from "../src/lib/ingest";
import { MemoryStore } from "../src/lib/store/memory";
import { createPostgresStore } from "../src/lib/store/postgres";
import type { Store } from "../src/lib/store/store";

/**
 * `npm run ingest ./docs`
 *
 * Re-runnable by design: a file whose chunks are unchanged is skipped, a file
 * that changed replaces its own chunks and nothing else. Run it twice and the
 * second run should report all-skipped.
 *
 *   npm run ingest ./docs -- --owner acme
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = argv.filter((a) => a !== "--");
  const ownerIndex = args.indexOf("--owner");
  const owner = ownerIndex >= 0 ? args[ownerIndex + 1] ?? "default" : "default";
  const paths = args.filter((a, i) => !a.startsWith("--") && i !== ownerIndex + 1);
  if (paths.length === 0) {
    console.error("usage: npm run ingest <folder-or-file> [-- --owner <id>]");
    return 1;
  }

  const config = loadConfig(env);
  const embeddings = createEmbeddingProvider(config);
  let store: Store;
  if (config.databaseUrl) {
    store = await createPostgresStore(config.databaseUrl, config.dimensions);
  } else {
    store = new MemoryStore(config.dimensions);
    console.warn("no DATABASE_URL: indexing into memory only, nothing persists. Set DATABASE_URL to keep it.");
  }

  const warnings: string[] = [];
  let inserted = 0;
  let skipped = 0;
  let replaced = 0;
  let files = 0;

  for (const path of paths) {
    const abs = resolve(process.cwd(), path);
    const found = collectFiles(abs);
    if (found.length === 0) {
      warnings.push(`${path}: no .md, .txt or .pdf files found`);
      continue;
    }
    for (const file of found) {
      const { chunks, warning } = await fileToChunks(file, {
        owner,
        relativeTo: abs,
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
      });
      if (warning) {
        warnings.push(`${file}: ${warning}`);
        continue;
      }
      const vectors = await embeddings.embedDocuments(chunks.map((c) => c.content));
      const result = await store.upsert(chunks, vectors);
      inserted += result.inserted;
      skipped += result.skipped;
      replaced += result.replaced;
      files++;
      console.log(`${chunks.length.toString().padStart(4)} chunks  +${result.inserted} ~${result.replaced} =${result.skipped}  ${chunks[0]?.sourcePath ?? file}`);
    }
  }

  console.log(`\nprovider ${embeddings.name} (${config.dimensions}d), store ${store.name}, owner "${owner}"`);
  console.log(`${files} files: ${inserted} inserted, ${replaced} replaced, ${skipped} unchanged`);
  for (const w of warnings) console.warn(`warning: ${w}`);
  return 0;
}

if (process.argv[1]?.endsWith("scripts/ingest.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
