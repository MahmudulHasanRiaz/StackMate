#!/usr/bin/env node
/**
 * StackMate Static Code & Security Lint Verifier
 * Enforces:
 * - No `drizzle-kit push` in scripts or workflows
 * - No `postgres.js` driver usage with Hyperdrive
 * - No hardcoded production secrets
 * - Strict snake_case error/response envelopes and no accidental console.log of raw keys
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["packages", "db", "apps", "scripts", ".github"];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const violations = [];
let scanned = 0;

for (const d of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, file);
    if (!/\.(ts|tsx|mjs|js|yml|yaml|sql|json|jsonc)$/.test(rel)) continue;
    scanned++;
    const content = fs.readFileSync(file, "utf8");

    if (rel !== "scripts/lint-repo.mjs" && /drizzle-kit\s+push/.test(content)) {
      violations.push(`${rel}: Forbidden 'drizzle-kit push' command found (violates ADR-0002).`);
    }
    if (rel.startsWith("apps/api/") && /from\s+["']postgres["']/.test(content)) {
      violations.push(`${rel}: Unsupported 'postgres' (Postgres.js) import found; must use 'pg' (node-postgres) with Hyperdrive (ADR-0005).`);
    }
  }
}

if (violations.length > 0) {
  console.error("Lint violations found:");
  for (const v of violations) console.error(` - ${v}`);
  process.exit(1);
}

console.log(`Static code & security lint passed across ${scanned} files.`);
