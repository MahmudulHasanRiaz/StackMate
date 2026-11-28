#!/usr/bin/env node
/**
 * OpenAPI check — E-23 (TAD §18.4 "OpenAPI gate").
 *
 * CI gate: the generated contract must be valid and must match the
 * current route table. It
 *   1. regenerates the document in memory from the Hono app's
 *      `app.routes` (same builder as `scripts/generate-openapi.mjs`;
 *      legacy regex fallback from `apps/api/src/app.ts` only while the
 *      Hono app cannot be loaded yet — see that script's header),
 *   2. fails if `docs/openapi.json` differs (drift — re-run the
 *      generator and commit the result),
 *   3. validates structure: OpenAPI 3.1, info, non-empty paths, every
 *      operation has a unique operationId + at least one response, every
 *      `{param}` in a path is declared as a path parameter, every
 *      `$ref` resolves inside the document.
 *
 * Run: `node scripts/check-openapi.mjs`. Exit 0 = gate passes.
 * NOTE: this script does not edit workflow files — CI wiring is a
 * documented follow-up (the repo's workflows are owner-managed via the
 * GitHub web UI); run it from `pnpm check` / `validate-repo` instead
 * until the workflow is added.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, loadRoutes } from "./generate-openapi.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const DOC_PATH = join(REPO_ROOT, "docs/openapi.json");

const failures = [];
const fail = (message) => failures.push(message);

function resolveRef(doc, ref) {
  if (!ref.startsWith("#/")) return false;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = doc;
  for (const part of parts) {
    if (node === null || typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return true;
}

function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

const { routes, source } = await loadRoutes();
const regenerated = buildOpenApi(routes, { source });

let storedRaw;
try {
  storedRaw = await readFile(DOC_PATH, "utf8");
} catch {
  fail("docs/openapi.json is missing — run `node scripts/generate-openapi.mjs`.");
}
let stored = null;
if (storedRaw !== undefined) {
  try {
    stored = JSON.parse(storedRaw);
  } catch (err) {
    fail(`docs/openapi.json is not valid JSON: ${(err).message}`);
  }
}

if (stored) {
  if (JSON.stringify(stored) !== JSON.stringify(regenerated)) {
    fail(
      "docs/openapi.json is stale — it does not match a fresh generation " +
        `from the ${source === "hono" ? "Hono app (apps/api/src/hono-app.ts)" : "legacy route table (apps/api/src/app.ts)"}. ` +
        "Run `node scripts/generate-openapi.mjs` and commit the result."
    );
  }
}

const doc = stored ?? regenerated;
if (doc.openapi !== "3.1.0") fail(`openapi must be "3.1.0", got ${JSON.stringify(doc.openapi)}.`);
if (!doc.info?.title || !doc.info?.version) fail("info.title and info.version are required.");
if (!doc.paths || typeof doc.paths !== "object" || Object.keys(doc.paths).length === 0) {
  fail("paths must be a non-empty object.");
}

const operationIds = new Set();
let operationCount = 0;
for (const [path, ops] of Object.entries(doc.paths ?? {})) {
  if (typeof ops !== "object" || ops === null) {
    fail(`Path '${path}' has no operations object.`);
    continue;
  }
  const declaredParams = new Set(
    Object.values(ops)
      .flatMap((op) => (op && typeof op === "object" ? (op.parameters ?? []) : []))
      .filter((p) => p.in === "path")
      .map((p) => p.name)
  );
  for (const param of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
    if (!declaredParams.has(param)) {
      fail(`Path '${path}' uses {${param}} but declares no such path parameter.`);
    }
  }
  for (const [method, op] of Object.entries(ops)) {
    operationCount += 1;
    if (!op || typeof op !== "object") {
      fail(`Operation ${method.toUpperCase()} ${path} is not an object.`);
      continue;
    }
    if (!op.operationId || typeof op.operationId !== "string") {
      fail(`Operation ${method.toUpperCase()} ${path} has no operationId.`);
    } else if (operationIds.has(op.operationId)) {
      fail(`Duplicate operationId '${op.operationId}'.`);
    } else {
      operationIds.add(op.operationId);
    }
    if (!op.responses || typeof op.responses !== "object" || Object.keys(op.responses).length === 0) {
      fail(`Operation ${op.operationId ?? `${method} ${path}`} has no responses.`);
    }
  }
}

for (const ref of collectRefs(doc)) {
  if (!resolveRef(doc, ref)) fail(`Unresolved $ref '${ref}'.`);
}

if (operationCount === 0) fail("Document contains no operations.");

if (failures.length > 0) {
  console.error(`OpenAPI check FAILED (${failures.length} problem(s)):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `OpenAPI check passed: ${Object.keys(doc.paths).length} paths, ` +
    `${operationCount} operations, ${operationIds.size} unique operationIds, all $refs resolve.`
);
