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
// tables too).
const schemaFiles = (await readdir(schemaDir)).filter((f) => f.endsWith(".ts") && f !== "index.ts");
const combinedSql = allMigrationSql.map((m) => m.sql).join("\n");

const declaredTables = [];
// Map: table name -> Set of column names declared in the schema.
// The columns object is the first `{ ... }` after pgTable("name", —
// extracted with a brace-depth scan so nested defaults/callbacks do
// not cut it short. Column builders are the drizzle-orm pg-core
// calls (uuid/text/varchar/boolean/integer/bigint/timestamp/date/
// jsonb); the first string argument is the SQL column name.
const declaredColumns = new Map();
for (const file of schemaFiles) {
  const content = await readFile(join(schemaDir, file), "utf8");
  const tablePattern = /pgTable\(\s*["']([a-z0-9_]+)["']\s*,/g;
  for (const m of content.matchAll(tablePattern)) {
    const table = m[1];
    declaredTables.push({ file, table });
    const braceStart = content.indexOf("{", m.index + m[0].length);
    if (braceStart === -1) {
      throw new Error(`Cannot parse pgTable("${table}") in db/schema/${file}: no columns object found.`);
    }
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error(`Cannot parse pgTable("${table}") in db/schema/${file}: unbalanced braces.`);
    }
    const body = content.slice(braceStart, end);
    const cols = new Set();
    for (const c of body.matchAll(/\b(?:uuid|text|varchar|boolean|integer|bigint|timestamp|date|jsonb)\s*\(\s*"([a-z0-9_]+)"/g)) {
      cols.add(c[1]);
    }
    if (cols.size === 0) {
      throw new Error(`Cannot parse pgTable("${table}") in db/schema/${file}: no columns extracted.`);
    }
    const prev = declaredColumns.get(table);
    if (prev) {
      for (const c of cols) prev.add(c);
    } else {
      declaredColumns.set(table, cols);
    }
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

// Column-list compare (audit 2026-11-25 C-08): every column the
// Drizzle schema declares for a table must exist in the SQL for that
// table — either in its CREATE TABLE body or in a later
// ALTER TABLE ... ADD COLUMN. This catches the drift class the
// table-presence check cannot see (a column added to the schema
// without a migration). It is one-directional by design: SQL-only
// columns (e.g. a column added by a migration before its schema
// declaration lands) are reported by drizzle-kit generate instead,
// which remains the authority for full fidelity — CHECK constraints,
// some indexes, and the SQL-only FKs listed in db/schema/README.md
// are intentionally not reproduced from the schema.
const sqlColumns = new Map();
const createPattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([a-z0-9_]+)"\s*\(/gi;
for (const m of combinedSql.matchAll(createPattern)) {
  const table = m[1];
  const bodyStart = m.index + m[0].length - 1; // the opening paren
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < combinedSql.length; i++) {
    if (combinedSql[i] === "(") depth++;
    else if (combinedSql[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`Cannot parse CREATE TABLE "${table}" in the committed SQL migrations: unbalanced parentheses.`);
  }
  const cols = sqlColumns.get(table) ?? new Set();
  const body = combinedSql.slice(bodyStart, end);
  for (const c of body.matchAll(/^\s*"([a-z0-9_]+)"\s+(?:uuid|text|varchar|boolean|integer|bigint|timestamp|timestamptz|date|jsonb|serial|smallint|numeric|char|double)\b/gim)) {
    cols.add(c[1].toLowerCase());
  }
  sqlColumns.set(table, cols);
}
for (const m of combinedSql.matchAll(/ALTER\s+TABLE\s+"([a-z0-9_]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([a-z0-9_]+)"/gi)) {
  const cols = sqlColumns.get(m[1]) ?? new Set();
  cols.add(m[2].toLowerCase());
  sqlColumns.set(m[1], cols);
}

const columnDrift = [];
for (const [table, cols] of declaredColumns) {
  const inSql = sqlColumns.get(table) ?? new Set();
  const missing = [...cols].filter((c) => !inSql.has(c));
  if (missing.length > 0) {
    columnDrift.push(`'${table}': schema declares column(s) missing from SQL migrations: ${missing.join(", ")}`);
  }
}
if (columnDrift.length > 0) {
  throw new Error(`Migration drift detected (column lists):\n  - ${columnDrift.join("\n  - ")}`);
}

console.log(
  `Migration consistency check passed: ${declaredTables.length} Drizzle tables verified against ${allMigrationSql.length} committed SQL migrations (${allMigrationSql.map((m) => m.tag).join(", ")}).`
);
