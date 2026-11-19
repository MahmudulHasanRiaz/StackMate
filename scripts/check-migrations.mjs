import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const schemaDir = join(root, "db", "schema");
const migrationsDir = join(root, "db", "migrations");
const journalPath = join(migrationsDir, "meta", "_journal.json");

const journal = JSON.parse(await readFile(journalPath, "utf8"));
if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
  throw new Error("Migration journal has no entries.");
}

// Journal entries must be ordered, uniquely tagged, and backed by a file.
const seenTags = new Set();
let prevIdx = -1;
const allMigrationSql = [];
for (const entry of journal.entries) {
  if (typeof entry.idx !== "number" || entry.idx <= prevIdx) {
    throw new Error(`Migration journal entries must have strictly increasing idx (bad entry: ${JSON.stringify(entry)}).`);
  }
  prevIdx = entry.idx;
  if (seenTags.has(entry.tag)) {
    throw new Error(`Duplicate migration journal tag: ${entry.tag}`);
  }
  seenTags.add(entry.tag);
  const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
  const sqlContent = await readFile(sqlFile, "utf8");
  if (sqlContent.trim().length < 50) {
    throw new Error(`Migration file ${entry.tag}.sql is unexpectedly empty.`);
  }
  allMigrationSql.push({ tag: entry.tag, sql: sqlContent });
}

// Every .sql file in db/migrations/ must be listed in the journal (no orphan
// migrations that the runner would never apply), and vice versa.
const sqlFilesOnDisk = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));
for (const tag of sqlFilesOnDisk) {
  if (!seenTags.has(tag)) {
    throw new Error(`Migration file ${tag}.sql exists on disk but is missing from db/migrations/meta/_journal.json.`);
  }
}

// Verify every pgTable("table_name", ...) in db/schema/*.ts has a
// corresponding CREATE TABLE in the UNION of all committed SQL migrations
// (not just 0000 — later migrations such as 0002_sequence_counters add
// tables too). This is a table-presence check, not a full column diff:
// drizzle-kit check/generate remains the authority for column fidelity
// (see docs/implementation/STATUS.md — CHECK constraints and some index
// details are SQL-only today and generate would not reproduce them).
const schemaFiles = (await readdir(schemaDir)).filter((f) => f.endsWith(".ts") && f !== "index.ts");
const combinedSql = allMigrationSql.map((m) => m.sql).join("\n");

const declaredTables = [];
for (const file of schemaFiles) {
  const content = await readFile(join(schemaDir, file), "utf8");
  const matches = content.matchAll(/pgTable\(\s*["']([a-z0-9_]+)["']/g);
  for (const m of matches) {
    declaredTables.push({ file, table: m[1] });
  }
}

if (declaredTables.length === 0) {
  throw new Error("No pgTable declarations found in db/schema/*.ts.");
}

for (const { file, table } of declaredTables) {
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+"${table}"`, "i");
  if (!pattern.test(combinedSql)) {
    throw new Error(
      `Migration drift detected: Table '${table}' declared in db/schema/${file} is missing from the committed SQL migrations (${allMigrationSql.map((m) => m.tag).join(", ")}).`
    );
  }
}

console.log(
  `Migration consistency check passed: ${declaredTables.length} Drizzle tables verified against ${allMigrationSql.length} committed SQL migrations (${allMigrationSql.map((m) => m.tag).join(", ")}).`
);
