#!/usr/bin/env node
/**
 * OpenAPI generator — E-23 (PRD §21; TAD §18.1 + §18.4; API spec §24.1).
 *
 * Generates `docs/openapi.json` (OpenAPI 3.1) from the REAL route table.
 * Route source, in order (Hono migration, plan §4):
 *
 *   1. HONO (preferred): the Hono app's `app.routes` — `createHonoApp()`
 *      from `apps/api/src/hono-app.ts`, loaded with Node's native
 *      type-stripping import. No regex, no guessing: the routes the app
 *      actually registers are the routes documented. The app is built
 *      with `resolveRuntimeConfig()` + an in-memory store factory, so
 *      generation touches no DB.
 *   2. LEGACY fallback: regex extraction from `apps/api/src/app.ts`
 *      (the hand-rolled dispatcher) — used ONLY while the Hono app
 *      cannot be loaded yet (Worker 1/2/2b/3/4 still landing). A loud
 *      warning names the failure. The conformance test
 *      (`apps/api/test/hono-routes.conformance.test.ts`) has NO such
 *      fallback — it fails until the Hono app loads — so a stuck
 *      fallback cannot hide silently. Once the Hono app is complete,
 *      remove the legacy path (`extractRoutes` + the fallback in
 *      `loadRoutes`) and the `source` option.
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
 * validated (TAD §18.4).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const APP_TS = join(REPO_ROOT, "apps/api/src/app.ts");
const HONO_APP_URL = pathToFileURL(
  join(REPO_ROOT, "apps/api/src/hono-app.ts")
).href;
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

function sortRoutes(routes) {
  return [...routes].sort((a, b) =>
    a.pattern === b.pattern
      ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method)
      : a.pattern.localeCompare(b.pattern),
  );
}

/**
 * Extract the (method, pattern) route table from a Hono app's
 * `app.routes` — the preferred source (Hono migration, plan §4).
 * Hono registers `app.use()` middleware as ALL-method routes; those
 * are pipeline, not routes, so they are skipped. `POST /api/v1/graphql`
 * (the additive GraphQL endpoint, plan §3.2) IS a real route and is
 * kept here — `buildOpenApi` documents REST only, so callers that
 * need a pure-REST table filter it out (see `loadRoutes`).
 */
export function extractRoutesFromHono(app) {
  const routes = new Map(); // "METHOD path" -> { method, pattern, how }
  for (const entry of app.routes ?? []) {
    if (!entry || typeof entry.method !== "string" || typeof entry.path !== "string") {
      continue;
    }
    const method = entry.method.toUpperCase();
    if (!METHODS.includes(method) || !entry.path.startsWith("/api/")) continue;
    const key = `${method} ${entry.path}`;
    if (!routes.has(key)) {
      routes.set(key, { method, pattern: entry.path, how: "hono" });
    }
  }
  return sortRoutes([...routes.values()]);
}

/**
 * Build the Hono app and extract its routes. The app is constructed
 * with resolved local env + an in-memory store factory — route
 * registration touches no DB. Throws on any failure; `loadRoutes`
 * decides whether to fall back to the legacy source.
 */
export async function loadHonoRoutes() {
  const mod = await import(HONO_APP_URL);
  const factory = mod.createHonoApp ?? mod.default ?? mod.app;
  if (typeof factory !== "function") {
    if (factory && Array.isArray(factory.routes)) {
      return extractRoutesFromHono(factory);
    }
    throw new Error(
      `apps/api/src/hono-app.ts exports no createHonoApp() factory ` +
        `(exports: ${Object.keys(mod).join(", ") || "(none)"}).`
    );
  }
  const { resolveRuntimeConfig } = await import(
    pathToFileURL(join(REPO_ROOT, "apps/api/src/env.ts")).href
  );
  const { StackMateDataStore } = await import(
    pathToFileURL(join(REPO_ROOT, "apps/api/src/platform/db/store.ts")).href
  );
  const store = new StackMateDataStore();
  const app = await factory({
    env: resolveRuntimeConfig(),
    storeFactory: async () => store,
  });
  if (!app || !Array.isArray(app.routes)) {
    throw new Error("createHonoApp() did not return a Hono app with a `routes` array.");
  }
  return extractRoutesFromHono(app);
}

/**
 * Resolve the route table for generation.
 * Returns `{ routes, source }` where `source` is `"hono"` (preferred)
 * or `"legacy-app.ts"` (regex fallback while the Hono app cannot be
 * loaded yet — loud warning, see the header comment). The GraphQL
 * endpoint is REST-external, so it is excluded from the OpenAPI table
 * either way (it is allow-listed, not documented, in the conformance
 * test).
 */
export async function loadRoutes() {
  try {
    const routes = await loadHonoRoutes();
    return {
      routes: routes.filter(
        (r) => !(r.method === "POST" && r.pattern === "/api/v1/graphql")
      ),
      source: "hono",
    };
  } catch (err) {
    console.warn(
      "WARNING: Hono route source unavailable — falling back to legacy " +
        `regex extraction from apps/api/src/app.ts (${err.message}). ` +
        "The route-conformance test has no such fallback and stays RED " +
        "until the Hono app loads."
    );
    const source = await readFile(APP_TS, "utf8");
    return { routes: extractRoutes(source), source: "legacy-app.ts" };
  }
}

export function buildOpenApi(routesOrSource, options = {}) {
  const routes = Array.isArray(routesOrSource)
    ? sortRoutes(routesOrSource)
    : extractRoutes(routesOrSource);
  const source = options.source ?? (Array.isArray(routesOrSource) ? "hono" : "legacy-app.ts");
  const routeSourceNote =
    source === "hono"
      ? "generated from the Hono route table in " +
        "apps/api/src/hono-app.ts (`app.routes`; run " +
        "`node scripts/generate-openapi.mjs` to regenerate; " +
        "`node scripts/check-openapi.mjs` is the CI gate). "
      : "generated from the route table in " +
        "apps/api/src/app.ts (run `node scripts/generate-openapi.mjs` to " +
        "regenerate; `node scripts/check-openapi.mjs` is the CI gate). ";
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
        "StackMate v1 API — " +
        routeSourceNote +
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
  const { routes, source } = await loadRoutes();
  const doc = buildOpenApi(routes, { source });
  const operationCount = Object.values(doc.paths).reduce(
    (n, ops) => n + Object.keys(ops).length,
    0
  );
  await writeFile(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(
    `OpenAPI written to docs/openapi.json: ${Object.keys(doc.paths).length} paths, ${operationCount} operations (source: ${source}).`
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
