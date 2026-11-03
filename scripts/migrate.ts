import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config";

/**
 * Creates the pgvector schema. The vector length is substituted from config, so
 * the column and the embedding provider cannot drift apart silently.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("migrate needs DATABASE_URL. Without it the app runs in memory and needs no schema.");
    process.exit(1);
  }
  if (!Number.isInteger(config.dimensions) || config.dimensions < 1) {
    console.error(`EMBEDDING_DIMENSIONS must be a positive integer, got ${config.dimensions}`);
    process.exit(1);
  }

  const sql = readFileSync(join(process.cwd(), "db/schema.sql"), "utf8").replaceAll("__DIMENSIONS__", String(config.dimensions));
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await pool.query("begin");
    await pool.query(sql);
    await pool.query("commit");
    const check = await pool.query(
      `select atttypmod as dims from pg_attribute where attrelid = 'chunks'::regclass and attname = 'embedding'`
    );
    const dims = Number((check.rows[0] as { dims: number } | undefined)?.dims ?? -1);
    console.log(`schema ready: chunks.embedding is vector(${dims}), hnsw and gin indexes in place`);
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
