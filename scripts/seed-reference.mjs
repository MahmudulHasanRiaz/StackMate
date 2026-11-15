#!/usr/bin/env node
/**
 * Seed StackMate reference data (currencies, RBAC permissions, built-in
 * roles, payment provider presets) from db/migrations/0001_seed_reference_catalog.sql.
 *
 * Requires DATABASE_URL (or DATABASE_MIGRATION_URL). The seed SQL is
 * idempotent (INSERT ... ON CONFLICT DO NOTHING), so re-running is safe.
 * This is a data operation, not a migration: it does not touch the
 * __stackmate_migrations table. Run `pnpm db:migrate` first so the
 * 0000 schema exists; normally migration 0001 already applies the same
 * seed via the migration runner — use this script only to (re)seed an
 * existing database without re-running migrations.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const connectionString = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERROR: DATABASE_MIGRATION_URL or DATABASE_URL is required to seed reference data.");
  process.exit(1);
}

// NOTE: bare `import("pg")` does NOT resolve from the repo root under pnpm.
// Resolve pg through the API package, which declares it as a dependency.
const root = process.cwd();
const requireFromApi = createRequire(join(root, "apps", "api", "package.json"));
let pgModule = null;
try {
  pgModule = requireFromApi("pg");
} catch {
  pgModule = null;
}
if (!pgModule) {
  console.error("ERROR: 'pg' driver is not installed. Run 'pnpm install' first.");
  process.exit(1);
}

const { Client } = pgModule.default ?? pgModule;
const sql = await readFile(
  join(root, "db", "migrations", "0001_seed_reference_catalog.sql"),
  "utf8"
);

const client = new Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  const counts = await client.query(
    `SELECT (SELECT count(*) FROM "currencies") AS currencies, ` +
      `(SELECT count(*) FROM "permissions") AS permissions, ` +
      `(SELECT count(*) FROM "roles") AS roles, ` +
      `(SELECT count(*) FROM "payment_providers") AS payment_providers`
  );
  console.log("Reference data seeded (idempotent):", counts.rows[0]);
} finally {
  await client.end().catch(() => {});
}
