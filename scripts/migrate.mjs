/**
 * Controlled PostgreSQL migration runner implementing ADR-0002:
 * - Acquires a PostgreSQL transaction/session advisory lock (pg_try_advisory_lock) so concurrent deploys cannot race.
 * - Tracks applied migrations with SHA-256 checksums in `__stackmate_migrations`.
 * - Fails closed if a previously applied migration file was modified (checksum mismatch) or if SQL execution fails.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const isDryRun = process.argv.includes("--dry-run");
const connectionString = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;

const root = process.cwd();
const migrationsDir = join(root, "db", "migrations");
const journalPath = join(migrationsDir, "meta", "_journal.json");

const journal = JSON.parse(await readFile(journalPath, "utf8"));
const migrations = [];

for (const entry of journal.entries) {
  const filePath = join(migrationsDir, `${entry.tag}.sql`);
  const sql = await readFile(filePath, "utf8");
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  migrations.push({ idx: entry.idx, tag: entry.tag, sql, checksum });
}

if (isDryRun) {
  console.log(`[dry-run] Validated ${migrations.length} ordered SQL migrations:`);
  for (const m of migrations) {
    console.log(`  - [${m.idx}] ${m.tag}.sql (sha256: ${m.checksum.slice(0, 16)}...)`);
  }
  process.exit(0);
}

if (!connectionString) {
  console.error("ERROR: DATABASE_MIGRATION_URL or DATABASE_URL is required to apply migrations.");
  process.exit(1);
}

// NOTE: bare `import("pg")` does NOT resolve from the repo root under pnpm
// (pnpm isolates dependencies per workspace package). Resolve pg through
// the API package, which declares it as a dependency.
const requireFromApi = createRequire(join(root, "apps", "api", "package.json"));
let pgModule = null;
try {
  pgModule = requireFromApi("pg");
} catch {
  pgModule = null;
}
if (!pgModule) {
  console.error("ERROR: 'pg' driver is not installed. Run 'pnpm install' before running live database migrations.");
  process.exit(1);
}

const { Client } = pgModule.default ?? pgModule;
const client = new Client({ connectionString });
const ADVISORY_LOCK_ID = "849201746291045";

try {
  await client.connect();
  const lockRes = await client.query(`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS acquired`);
  if (!lockRes.rows[0]?.acquired) {
    throw new Error("Could not acquire PostgreSQL migration advisory lock; another migration is in progress.");
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS "__stackmate_migrations" (
      "id" serial PRIMARY KEY,
      "tag" varchar(160) NOT NULL UNIQUE,
      "checksum" varchar(64) NOT NULL,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  const appliedRes = await client.query(`SELECT "tag", "checksum" FROM "__stackmate_migrations" ORDER BY "id" ASC`);
  const appliedMap = new Map(appliedRes.rows.map((r) => [r.tag, r.checksum]));

  for (const m of migrations) {
    const existingChecksum = appliedMap.get(m.tag);
    if (existingChecksum) {
      if (existingChecksum !== m.checksum) {
        throw new Error(
          `CRITICAL: Applied migration '${m.tag}' checksum mismatch (expected ${existingChecksum}, found ${m.checksum}). Never edit an already-applied migration.`
        );
      }
      console.log(`Skipping already-applied migration: ${m.tag}`);
      continue;
    }

    console.log(`Applying migration: ${m.tag}...`);
    await client.query("BEGIN");
    try {
      await client.query(m.sql);
      await client.query(
        `INSERT INTO "__stackmate_migrations" ("tag", "checksum") VALUES ($1, $2)`,
        [m.tag, m.checksum]
      );
      await client.query("COMMIT");
      console.log(`Successfully applied migration: ${m.tag}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  console.log("All pending database migrations applied successfully.");
} finally {
  await client.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`).catch(() => {});
  await client.end().catch(() => {});
}
