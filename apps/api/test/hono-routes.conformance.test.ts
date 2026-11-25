/**
 * Hono route-conformance test — Hono migration Phase 0/1 gate (plan §4).
 *
 * Proves the Hono app covers the ENTIRE OpenAPI surface, and nothing more:
 *   1. every path+method in `docs/openapi.json` exists on the Hono app
 *      (Hono `:param` vs OpenAPI `{param}` spelling is normalized before
 *      comparing; same method required);
 *   2. the Hono app has NO extra route outside OpenAPI — except the one
 *      allowed additive route, `POST /api/v1/graphql` (GraphQL, plan §3.2);
 *   3. no duplicate (method, path) on the Hono app;
 *   4. the OpenAPI baseline itself is intact (103 paths / 145 operations
 *      at feat e382d65 — plan §1/§4: Phase 1 must preserve them).
 *
 * The test is DB-free: the Hono app is created with
 * `createHonoApp({ env: resolveRuntimeConfig(), storeFactory })` where
 * the factory returns one shared in-memory `StackMateDataStore`.
 * Route registration touches no DB. No DATABASE_URL, no network,
 * no DB writes.
 *
 * `apps/api/src/hono-app.ts` is built by Worker 1. Until it lands, this
 * file FAILS with an explicit message naming that dependency (the gate
 * stays RED — Phase 1 cannot be called complete without this test).
 * The import is dynamic through a variable specifier so `tsc` does not
 * resolve a module that does not exist yet (TS2307), and so the failure
 * surfaces as a readable test error instead of a collection error.
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { resolveRuntimeConfig } from "../src/env.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");
const OPENAPI_PATH = join(REPO_ROOT, "docs/openapi.json");
const HONO_APP_PATH = join(TEST_DIR, "..", "src", "hono-app.ts");
/** Variable specifier on purpose — see the header comment (no TS2307). */
const HONO_APP_SPECIFIER = "../src/hono-app.ts";

/**
 * Migration baseline (plan §1) — CORRECTED 2026-11-25 (integration).
 * The pre-migration OpenAPI (103 paths / 145 operations) was INCOMPLETE:
 * its regex generator missed 86 real routes in app.ts (mostly
 * parameterized/detail routes) and recorded 7 wrong methods
 * (e.g. PATCH roles/:roleId as GET, POST leads/:leadId as POST —
 * app.ts has GET+PATCH). The Hono-sourced regeneration is the accurate
 * inventory: 181 paths / 231 operations, verified against app.ts
 * (see the integration note in the migration plan §4). Any future
 * change to these numbers must be a deliberate, reviewed API change.
 */
const BASELINE_PATHS = 181;
const BASELINE_OPERATIONS = 231;

/**
 * The ONE allowed extra Hono route: the additive GraphQL endpoint
 * (plan §3.2 — queries only, admin reads; REST stays). It is NOT in
 * OpenAPI (OpenAPI documents REST only), so it is allow-listed here
 * instead of counted as drift.
 */
const ALLOWED_EXTRA_ROUTES = new Set(["POST /api/v1/graphql"]);

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/** Hono `:param` -> OpenAPI `{param}` (same conversion as the generator). */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function normalizeRoute(method: string, path: string): string {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return `${method.toUpperCase()} ${toOpenApiPath(clean)}`;
}

interface HonoRouteEntry {
  method: string;
  path: string;
}

interface HonoLikeApp {
  routes: HonoRouteEntry[];
}

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

/**
 * Load the Hono app (Worker 1: `apps/api/src/hono-app.ts`).
 *
 * Factory shapes tried in order (first success wins):
 *   1. `createHonoApp({ env, storeFactory })` — the real Worker-1
 *      signature: resolved env via `resolveRuntimeConfig()` (local
 *      defaults, no secrets needed) + a factory returning one shared
 *      in-memory store. Route registration touches no DB.
 *   2. `createHonoApp()` (no-arg) and 3. `createHonoApp(store)` — kept
 *      so the test also works if the factory shape changes.
 * Also accepts a module that exports the app itself (`default` / `app`).
 */
async function loadHonoApp(): Promise<HonoLikeApp> {
  if (!existsSync(HONO_APP_PATH)) {
    throw new Error(
      "Hono app not yet available: apps/api/src/hono-app.ts does not exist " +
        "yet — it is built by Worker 1 (Hono app + middleware). This " +
        "conformance test cannot run until that file lands; the migration " +
        "gate stays RED until then."
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ HONO_APP_SPECIFIER)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new Error(
      `Failed to import apps/api/src/hono-app.ts: ${(err as Error).message}`,
      { cause: err }
    );
  }
  const factory = mod.createHonoApp ?? mod.default ?? mod.app;
  let app: unknown = null;
  if (typeof factory === "function") {
    const store = new StackMateDataStore();
    const attempts: Array<{ label: string; error: unknown }> = [];
    const candidates: Array<{
      label: string;
      call: () => unknown;
    }> = [
      {
        label: "createHonoApp({ env, storeFactory })",
        call: () =>
          (factory as (deps: unknown) => unknown)({
            env: resolveRuntimeConfig(),
            storeFactory: async () => store,
          }),
      },
      { label: "createHonoApp()", call: () => (factory as () => unknown)() },
      {
        label: "createHonoApp(store)",
        call: () => (factory as (s: StackMateDataStore) => unknown)(store),
      },
    ];
    for (const candidate of candidates) {
      try {
        app = await candidate.call();
      } catch (err) {
        attempts.push({ label: candidate.label, error: err });
        continue;
      }
      if (app !== null && app !== undefined) break;
    }
    if (app === null || app === undefined) {
      throw new Error(
        "createHonoApp() failed in every tried shape:\n" +
          attempts
            .map(
              (a) =>
                `  - ${a.label}: ${(a.error as Error)?.message ?? a.error}`
            )
            .join("\n"),
        { cause: attempts[attempts.length - 1]?.error }
      );
    }
  } else if (factory && typeof factory === "object") {
    app = factory;
  }
  const routes = (app as { routes?: unknown; app?: { routes?: unknown } } | null)
    ?.routes ??
    (app as { app?: { routes?: unknown } } | null)?.app?.routes;
  if (!Array.isArray(routes)) {
    throw new Error(
      "apps/api/src/hono-app.ts did not expose a Hono app with a " +
        "`routes` array (expected `createHonoApp()` returning a Hono app, " +
        `or a default/app export with .routes). Exports found: ${Object.keys(mod).join(", ") || "(none)"}.`
    );
  }
  return { routes: routes as HonoRouteEntry[] };
}

async function loadOpenApi(): Promise<OpenApiDoc> {
  const raw = await readFile(OPENAPI_PATH, "utf8");
  return JSON.parse(raw) as OpenApiDoc;
}

let openApi: OpenApiDoc;
let honoApp: HonoLikeApp;

/** OpenAPI (method, path) set — the contract the Hono app must cover. */
function openApiRoutes(doc: OpenApiDoc): Set<string> {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of Object.keys(ops)) {
      out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

/**
 * Hono (method, path) set. Hono registers `app.use()` middleware as
 * ALL-method routes — those are pipeline, not routes, so they are
 * skipped (and counted separately for the report line below).
 */
function honoRoutes(app: HonoLikeApp): { routes: Set<string>; middleware: number } {
  const routes = new Set<string>();
  let middleware = 0;
  for (const entry of app.routes) {
    if (!entry || typeof entry.method !== "string" || typeof entry.path !== "string") {
      continue;
    }
    if (!HTTP_METHODS.includes(entry.method.toUpperCase())) {
      middleware += 1;
      continue;
    }
    routes.add(normalizeRoute(entry.method, entry.path));
  }
  return { routes, middleware };
}

beforeAll(async () => {
  openApi = await loadOpenApi();
  honoApp = await loadHonoApp();
});

describe("Hono route conformance (OpenAPI gate, migration plan §4)", () => {
  it("OpenAPI baseline is intact: 181 paths / 231 operations", () => {
    const paths = Object.keys(openApi.paths).length;
    const operations = Object.values(openApi.paths).reduce(
      (n, ops) => n + Object.keys(ops).length,
      0
    );
    assert.equal(
      paths,
      BASELINE_PATHS,
      `docs/openapi.json has ${paths} paths, expected baseline ${BASELINE_PATHS}. ` +
        "If the API surface intentionally changed, update the baseline in this test deliberately."
    );
    assert.equal(
      operations,
      BASELINE_OPERATIONS,
      `docs/openapi.json has ${operations} operations, expected baseline ${BASELINE_OPERATIONS}. ` +
        "If the API surface intentionally changed, update the baseline in this test deliberately."
    );
  });

  it("every OpenAPI operation exists on the Hono app (same path + method)", () => {
    const expected = openApiRoutes(openApi);
    const { routes } = honoRoutes(honoApp);
    const missing = [...expected].filter((route) => !routes.has(route)).sort();
    assert.deepEqual(
      missing,
      [],
      `OpenAPI operations missing from the Hono app (${missing.length}):\n` +
        missing.map((route) => `  - ${route}`).join("\n")
    );
  });

  it("Hono app has no extra routes beyond OpenAPI (except POST /api/v1/graphql)", () => {
    const expected = openApiRoutes(openApi);
    const { routes } = honoRoutes(honoApp);
    const extra = [...routes]
      .filter((route) => !expected.has(route) && !ALLOWED_EXTRA_ROUTES.has(route))
      .sort();
    assert.deepEqual(
      extra,
      [],
      `Extra routes on the Hono app, not in OpenAPI (${extra.length}):\n` +
        extra.map((route) => `  - ${route}`).join("\n") +
        "\nEither register them in OpenAPI (via the generator) or remove them."
    );
  });

  it("no duplicate (method, path) on the Hono app", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of honoApp.routes) {
      if (!entry || !HTTP_METHODS.includes((entry.method ?? "").toUpperCase())) continue;
      const key = normalizeRoute(entry.method, entry.path);
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    assert.deepEqual(
      [...new Set(duplicates)].sort(),
      [],
      `Duplicate Hono routes:\n${[...new Set(duplicates)].sort().map((route) => `  - ${route}`).join("\n")}`
    );
  });

  it("Hono route count matches OpenAPI operation count (+ allowed extras only)", () => {
    const expected = openApiRoutes(openApi);
    const { routes, middleware } = honoRoutes(honoApp);
    const allowedPresent = [...routes].filter((route) =>
      ALLOWED_EXTRA_ROUTES.has(route)
    ).length;
    assert.equal(
      routes.size - allowedPresent,
      expected.size,
      `Hono has ${routes.size} routes (${allowedPresent} allowed extra, ${middleware} middleware entries skipped) ` +
        `vs ${expected.size} OpenAPI operations.`
    );
  });

  it("no Hono route path ends with a trailing slash (OpenAPI paths do not)", () => {
    const slashed = honoApp.routes
      .filter(
        (entry) =>
          entry &&
          HTTP_METHODS.includes((entry.method ?? "").toUpperCase()) &&
          typeof entry.path === "string" &&
          entry.path.length > 1 &&
          entry.path.endsWith("/")
      )
      .map((entry) => normalizeRoute(entry.method, entry.path))
      .sort();
    assert.deepEqual(
      slashed,
      [],
      `Hono routes with a trailing slash:\n${slashed.map((route) => `  - ${route}`).join("\n")}`
    );
  });
});
