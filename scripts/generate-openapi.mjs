#!/usr/bin/env node
/**
 * OpenAPI generator — E-23 (PRD §21; TAD §18.1 + §18.4; API spec §24.1).
 *
 * Generates `docs/openapi.json` (OpenAPI 3.1) from the REAL route table
 * in `apps/api/src/app.ts` — the single request dispatcher. The API has
 * no framework router to introspect (routes are `method === ... &&
 * pathname === ...` / `matchPath(...)` conditionals), so this script
 * extracts them with anchored regexes:
 *
 *   1. `method === "GET" && pathname === "/api/..."` (exact routes).
 *   2. `method === "GET" && mVar` where `const mVar = matchPath("...", ...)`
 *      (parameterized routes, incl. multi-line conditions).
 *   3. Fallback: any `pathname === "/api/..."` literal, paired with the
 *      nearest preceding `method === "..."` within 300 chars.
 *   4. Orphans: a `matchPath` variable whose methods were not caught by
 *      (2) — its declaration span is scanned for `method === "..."`
 *      occurrences that mention the variable (nested `if (mVar)` blocks).
 *
 * Every extracted operation gets a stable operationId, its path
 * parameters, a security requirement derived from the path prefix, and
 * the standard success + error responses (the error envelope is
 * `components.schemas.Error`). Request/response bodies are NOT invented
 * per operation: the field-level contracts live in
 * `packages/contracts/` (valibot schemas) and the prose API spec in
 * `docs/plan/API & Integration Specification.md`; operations reference
 * the generic `SuccessEnvelope` / `PaginatedCollection` components and
 * point at the contracts package in their description. A generated
 * document that invents a body schema would be worse than one that
 * says where the contract lives.
 *
 * Run: `node scripts/generate-openapi.mjs` (writes docs/openapi.json).
 * Gate: `node scripts/check-openapi.mjs` regenerates in memory and
 * fails on any drift, so CI can verify contracts can be generated and
 * validated (TAD §18.4). Routes wired later (e.g. the Batch E admin
 * routes Worker A2 adds) appear automatically on the next run.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const APP_TS = join(REPO_ROOT, "apps/api/src/app.ts");
const OUT_PATH = join(REPO_ROOT, "docs/openapi.json");

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

function toOpenApiPath(pattern) {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParams(pattern) {
  return [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function operationId(method, pattern) {
  const slug = pattern
    .replace(/^\/api\//, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${method.toLowerCase()}_${slug || "root"}`;
}

function securityFor(path) {
  if (path.startsWith("/api/v1/admin")) return [{ StaffSession: [] }];
  if (path.startsWith("/api/v1/integrations")) return [{ SiteHmac: [] }];
  if (path.startsWith("/api/v1/public")) return [{ SiteKey: [] }];
  if (path.startsWith("/api/v1/licenses")) return [{ LicenseKey: [] }];
  return [];
}

function tagFor(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "auth") return ["Auth"];
  if (parts[1] === "v1" && parts[2] === "admin") return [`Admin · ${parts[3] ?? "general"}`];
  if (parts[1] === "v1" && parts[2] === "integrations") return ["Integrations (S2S)"];
  if (parts[1] === "v1" && parts[2] === "public") return ["Public (site)"];
  if (parts[1] === "v1" && parts[2] === "licenses") return ["Licenses (client)"];
  return ["General"];
}

/** Extract the (method, pattern) route table from app.ts. */
export function extractRoutes(source) {
  const routes = new Map(); // "METHOD path" -> { method, pattern, how }
  const add = (method, pattern, how) => {
    if (!METHODS.includes(method) || !pattern.startsWith("/api/")) return;
    const key = `${method} ${pattern}`;
    if (!routes.has(key)) routes.set(key, { method, pattern, how });
  };

  // matchPath variable -> pattern.
  const matchVars = new Map();
  for (const m of source.matchAll(/const\s+(m\w+)\s*=\s*matchPath\("([^"]+)",\s*pathname\)/g)) {
    matchVars.set(m[1], m[2]);
  }

  // (1)+(2): method === "X" && (pathname === "..." | mVar), newlines allowed.
  const condRe =
    /method === "(GET|POST|PATCH|PUT|DELETE)"\s*&&\s*(?:pathname === "([^"]+)"|(m\w+))/g;
  for (const m of source.matchAll(condRe)) {
    const pattern = m[2] ?? matchVars.get(m[3]);
    if (pattern) add(m[1], pattern, "condition");
  }

  // (3): fallback — every pathname literal, nearest preceding method.
  for (const m of source.matchAll(/pathname === "(\/api[^"]+)"/g)) {
    const before = source.slice(Math.max(0, m.index - 300), m.index);
    const methodMatch = [...before.matchAll(/method === "(GET|POST|PATCH|PUT|DELETE)"/g)].pop();
    if (methodMatch) add(methodMatch[1], m[1], "fallback");
  }

  // (4): orphan matchPath vars — scan the span after the declaration.
  const declarations = [...source.matchAll(/const\s+(m\w+)\s*=\s*matchPath\("([^"]+)",\s*pathname\)/g)];
  for (let i = 0; i < declarations.length; i += 1) {
    const decl = declarations[i];
    const varName = decl[1];
    const pattern = decl[2];
    const spanStart = decl.index + decl[0].length;
    const spanEnd =
      i + 1 < declarations.length ? declarations[i + 1].index : spanStart + 8000;
    const span = source.slice(spanStart, spanEnd);
    for (const m of span.matchAll(/method === "(GET|POST|PATCH|PUT|DELETE)"/g)) {
      const before = span.slice(Math.max(0, m.index - 300), m.index);
      if (before.includes(varName)) add(m[1], pattern, "orphan-span");
    }
  }

  return [...routes.values()].sort((a, b) =>
    a.pattern === b.pattern
      ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method)
      : a.pattern.localeCompare(b.pattern),
  );
}

export function buildOpenApi(source) {
  const routes = extractRoutes(source);
  const paths = {};
  const seenOperationIds = new Set();
  for (const { method, pattern } of routes) {
    const openApiPath = toOpenApiPath(pattern);
    const opId = operationId(method, pattern);
    if (seenOperationIds.has(opId)) {
      throw new Error(`Duplicate operationId '${opId}' for ${method} ${pattern}.`);
    }
    seenOperationIds.add(opId);
    const parameters = pathParams(pattern).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      description: `Path parameter \`${name}\`.`,
    }));
    const security = securityFor(pattern);
    const operation = {
      operationId: opId,
      summary: `${method} ${openApiPath}`,
      description:
        "Contract: see `packages/contracts/` (valibot schemas) and " +
        "`docs/plan/API & Integration Specification.md`. " +
        "List endpoints accept `?q=`, `?limit=` (1–100, default 25) and " +
        "`?page=`; responses use the standard success/error envelopes.",
      tags: tagFor(pattern),
      parameters,
      responses: {
        200: {
          description: "Success (envelope).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessEnvelope" },
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        401: { $ref: "#/components/responses/Unauthorized" },
        403: { $ref: "#/components/responses/Forbidden" },
        404: { $ref: "#/components/responses/NotFound" },
        422: { $ref: "#/components/responses/ValidationError" },
        500: { $ref: "#/components/responses/InternalError" },
      },
    };
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RequestBody" },
          },
        },
      };
    }
    if (security.length > 0) operation.security = security;
    paths[openApiPath] ??= {};
    paths[openApiPath][method.toLowerCase()] = operation;
  }

  const errorResponse = (description) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "StackMate API",
      version: "v1",
      description:
        "StackMate v1 API — generated from the route table in " +
        "apps/api/src/app.ts (run `node scripts/generate-openapi.mjs` to " +
        "regenerate; `node scripts/check-openapi.mjs` is the CI gate). " +
        "Endpoints under /api/auth/* that are not listed here are served " +
        "by the Better Auth handler (sign-up, social sign-in, two-factor " +
        "enable/disable) — see apps/api/src/modules/identity/better-auth.ts. " +
        "Money is integer minor units (BDT initial currency); timestamps " +
        "are UTC ISO-8601; display dates are DD/MM/YYYY. Field-level " +
        "request/response contracts live in packages/contracts/.",
    },
    servers: [
      { url: "https://stackmate-api-staging.ad-dawah.workers.dev", description: "Staging" },
    ],
    tags: [
      { name: "Auth", description: "Better Auth + StackMate auth flows." },
      { name: "Admin · general", description: "Admin endpoints." },
      { name: "Integrations (S2S)", description: "Signed server-to-server API (HMAC, scopes)." },
      { name: "Public (site)", description: "Public site-key API (catalog, checkout, tracking)." },
      { name: "Licenses (client)", description: "License activation / validation (license key)." },
      { name: "General", description: "Health, config, and other public endpoints." },
    ],
    paths,
    components: {
      securitySchemes: {
        StaffSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-better-auth.session_token",
          description: "Staff session cookie (Better Auth). Admin routes are permission-gated server-side.",
        },
        SiteHmac: {
          type: "http",
          scheme: "bearer",
          description:
            "Signed server request: X-StackMate-Key-Id / X-StackMate-Timestamp / " +
            "X-StackMate-Nonce / X-StackMate-Content-SHA256 / X-StackMate-Signature (HMAC, per-scope).",
        },
        SiteKey: {
          type: "apiKey",
          in: "header",
          name: "X-StackMate-Site-Key",
          description: "Public site key for the public catalog/checkout/tracking API.",
        },
        LicenseKey: {
          type: "http",
          scheme: "bearer",
          description: "License key (request body field `license_key`) for activation/validation.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: { type: "boolean", const: false },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", description: "Machine-readable error code (e.g. VALIDATION_ERROR, NOT_FOUND)." },
                message: { type: "string" },
                details: { type: "object", additionalProperties: true },
              },
            },
            request_id: { type: "string" },
          },
        },
        SuccessEnvelope: {
          type: "object",
          required: ["success", "data"],
          properties: {
            success: { type: "boolean", const: true },
            data: { type: "object", additionalProperties: true, description: "Endpoint payload — see packages/contracts/ for the field contract." },
            request_id: { type: "string" },
          },
        },
        PaginatedCollection: {
          type: "object",
          required: ["success", "data", "total"],
          properties: {
            success: { type: "boolean", const: true },
            data: { type: "array", items: { type: "object", additionalProperties: true } },
            total: { type: "integer", description: "Total matching rows (server-side filter applied)." },
            request_id: { type: "string" },
          },
        },
        RequestBody: {
          type: "object",
          additionalProperties: true,
          description: "Request JSON — the field contract is the matching schema in packages/contracts/ (unknown fields are rejected).",
        },
      },
      responses: {
        BadRequest: errorResponse("Bad request (e.g. SSRF_BLOCKED)."),
        Unauthorized: errorResponse("Authentication required."),
        Forbidden: errorResponse("Missing required permission or forbidden action."),
        NotFound: errorResponse("Route or resource not found."),
        ValidationError: errorResponse("Validation failed (HTTP 422)."),
        InternalError: errorResponse("Internal error."),
      },
    },
  };
}

export async function main() {
  const source = await readFile(APP_TS, "utf8");
  const doc = buildOpenApi(source);
  const operationCount = Object.values(doc.paths).reduce(
    (n, ops) => n + Object.keys(ops).length,
    0
  );
  await writeFile(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(
    `OpenAPI written to docs/openapi.json: ${Object.keys(doc.paths).length} paths, ${operationCount} operations.`
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
