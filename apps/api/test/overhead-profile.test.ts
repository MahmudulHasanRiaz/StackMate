/**
 * LV-03 / B-01 residual — no-DB per-request overhead decomposition.
 *
 * ADR-0013 follow-up: staging GET /health median 0.567s (2026-11-26) with
 * NO DB work at all. This file decomposes that overhead LOCALLY with
 * numbers, through the real Worker entrypoint, and pins the warm
 * per-request cost so a future regression is caught:
 *
 *   - cold module evaluation (first dynamic import of src/index.ts)
 *     + first health fetch — the cold-isolate proxy;
 *   - resolveRuntimeConfig warm cost (called TWICE per request:
 *     index.ts fetch + app.ts fetchHandler);
 *   - createHonoApp warm cost, split into `new Hono()` /
 *     middlewareChain / registerAllRoutes, first call vs warm;
 *   - health via the full entrypoint (no Hono app built on this path —
 *     app.ts answers early), first vs warm;
 *   - license validate (unknown key → 401) via the full entrypoint,
 *     first vs warm, AND on a pre-built Hono app (dispatch isolated
 *     from construction).
 *
 * All `src` imports are dynamic on purpose: the first test must see a
 * cold module graph. The DB-backed test uses its own scratch database
 * (stackmate_test_overhead), never the shared stackmate_test.
 *
 * Bounds are generous on purpose (shared-CPU vitest worker): this is a
 * decomposition + regression tripwire, not a tight perf gate. Local
 * numbers are NOT staging numbers — staging adds Worker cold-isolate
 * spin-up, TLS, and Hyperdrive RTTs that no local probe can reproduce.
 * What the local numbers CAN prove: whether per-request Hono app
 * construction is a material chunk of the warm per-request cost.
 *
 * FINDINGS (2026-11-27, 4 runs): it is NOT. Warm health is 0.07–0.16ms
 * (no Hono app is built on that path at all); createHonoApp warm is
 * 0.14–0.26ms; the whole per-request fresh-app cost (build + first-
 * dispatch premium: ~1ms lazy router-matcher build + ~0.7–1.3ms
 * first-run middleware init) is ~2–3.5ms on license validate. The
 * staging ~0.6s is a COLD phenomenon: the 5.26MB bundle takes
 * 250–308ms just to evaluate in a fresh Node process, before any
 * request work — plus workerd isolate boot, TLS, and network, which
 * no local probe can measure. Caching one Hono app across requests
 * would save ~2–3ms warm and 0ms on health, and is unsafe-by-default
 * here (env + adoptedStore are closed over at construction; per-
 * request isolation would need identity keying). So NO production
 * change was made on this track — the residual staging gap is the
 * sequential Hyperdrive RTTs (ADR-0013 follow-up), not app construction.
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import type { AppEnv } from "../src/types/context.ts";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test";
const CTX = { waitUntil: () => {} } as never;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function stats(label: string, values: number[]): { median: number; min: number; max: number } {
  const s = { median: median(values), min: Math.min(...values), max: Math.max(...values) };
  console.log(
    `[overhead-profile] ${label}: median ${s.median.toFixed(2)}ms ` +
      `(min ${s.min.toFixed(2)}, max ${s.max.toFixed(2)}, n=${values.length})`
  );
  return s;
}

function healthRequest(): Request {
  return new Request("http://localhost:8787/api/v1/health", { method: "GET" });
}

function validateRequest(): Request {
  return new Request("http://localhost:8787/api/v1/licenses/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: "SM-OVERHEAD-PROBE-0000-0000-0000-000000000000",
      product_code: "OVERHEAD",
      installation_id: "overhead-probe",
    }),
  });
}

describe("LV-03 overhead profile (local decomposition)", () => {
  let cleanupDb: (() => Promise<void>) | null = null;

  afterAll(async () => {
    const { drainConnectionCache } = await import(
      "../src/platform/db/connection-cache.ts"
    );
    drainConnectionCache();
    await cleanupDb?.();
  }, 120_000);

  it("cold: first dynamic import of the Worker entrypoint + first health fetch", async () => {
    const t0 = performance.now();
    const worker = await import("../src/index.ts");
    const importMs = performance.now() - t0;
    console.log(`[overhead-profile] cold dynamic import src/index.ts: ${importMs.toFixed(2)}ms`);

    const rawEnv = {
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: DB_URL },
    } as never;
    const t1 = performance.now();
    const res = await worker.default.fetch(healthRequest(), rawEnv, CTX);
    const firstHealthMs = performance.now() - t1;
    console.log(`[overhead-profile] first health fetch (cold): ${firstHealthMs.toFixed(2)}ms`);
    const firstText = await res.text();
    assert.equal(res.status, 200, firstText);
    const body = JSON.parse(firstText);
    assert.equal(body.data.status, "ok");
    // Cold import includes vite transform on first load, so the bound
    // is loose — it only trips if module evaluation itself explodes.
    assert.ok(importMs < 30_000, `cold import took ${importMs.toFixed(0)}ms`);
  }, 60_000);

  it("resolveRuntimeConfig warm cost (called twice per request)", async () => {
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const rawEnv = {
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: DB_URL },
    } as never;
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      resolveRuntimeConfig(rawEnv);
      times.push(performance.now() - t0);
    }
    const s = stats("resolveRuntimeConfig warm", times);
    // Two calls per request (index.ts + app.ts fetchHandler).
    console.log(
      `[overhead-profile] resolveRuntimeConfig x2 per request: ${(s.median * 2).toFixed(3)}ms`
    );
    assert.ok(s.median < 5, `resolveRuntimeConfig median ${s.median.toFixed(2)}ms`);
  });

  it("createHonoApp: first vs warm, split by construction stage", async () => {
    const { createHonoApp } = await import("../src/hono-app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const { middlewareChain } = await import("../src/middleware/index.ts");
    const { registerAllRoutes } = await import("../src/routes/index.ts");
    const { Hono } = await import("hono");
    const env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: DB_URL },
    } as never);
    const factory = (async () => {
      const { StackMateDataStore } = await import("../src/platform/db/store.ts");
      return new StackMateDataStore();
    }) as never;

    const tFirst = performance.now();
    const firstApp = createHonoApp({ env, storeFactory: factory });
    const firstMs = performance.now() - tFirst;
    console.log(`[overhead-profile] createHonoApp first call: ${firstMs.toFixed(2)}ms`);
    console.log(`[overhead-profile] registered routes: ${firstApp.routes.length}`);

    const warm: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      createHonoApp({ env, storeFactory: factory });
      warm.push(performance.now() - t0);
    }
    const warmStats = stats("createHonoApp warm", warm);

    const newHono: number[] = [];
    const chain: number[] = [];
    const register: number[] = [];
    for (let i = 0; i < 20; i++) {
      let t0 = performance.now();
      const app = new Hono<AppEnv>();
      newHono.push(performance.now() - t0);
      t0 = performance.now();
      const mw = middlewareChain(env, factory);
      chain.push(performance.now() - t0);
      t0 = performance.now();
      app.use(...mw);
      registerAllRoutes(app);
      register.push(performance.now() - t0);
    }
    stats("new Hono() only", newHono);
    stats("middlewareChain() only (builds array, does not run it)", chain);
    stats("app.use(middleware) + registerAllRoutes()", register);

    assert.ok(firstApp.routes.length > 100, `only ${firstApp.routes.length} routes registered`);
    assert.ok(
      warmStats.median < 100,
      `createHonoApp warm median ${warmStats.median.toFixed(2)}ms`
    );
  });

  it("health via the full entrypoint: warm per-request cost (no Hono app on this path)", async () => {
    const worker = await import("../src/index.ts");
    const rawEnv = {
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: DB_URL },
    } as never;
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = await worker.default.fetch(healthRequest(), rawEnv, CTX);
      times.push(performance.now() - t0);
      assert.equal(res.status, 200);
      await res.text();
    }
    const s = stats("entrypoint GET /api/v1/health warm", times);
    assert.ok(s.median < 50, `health warm median ${s.median.toFixed(2)}ms`);
  });

  it("JSON serialization micro-cost (health envelope)", () => {
    const envelope = {
      success: true,
      data: {
        status: "ok",
        service: "stackmate-api",
        environment: "test",
        default_currency: "BDT",
        default_timezone: "Asia/Dhaka",
        hyperdrive: { uncached_binding_configured: true, cached_binding_configured: true },
        timestamp: new Date().toISOString(),
      },
      meta: { request_id: "req_0123456789abcdef" },
    };
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      JSON.stringify(envelope);
      times.push(performance.now() - t0);
    }
    stats("JSON.stringify(health envelope)", times);
  });

  it("fresh-app first dispatch vs second dispatch (lazy router-matcher check)", async () => {
    // The interleaved license test shows a ~2–3.6ms gap between the
    // full entrypoint (fresh Hono app per request) and a pre-built app,
    // while createHonoApp itself measures only ~0.2ms warm. If Hono
    // builds its route matcher lazily on first dispatch, every fresh
    // app pays that build on its one and only request. This test
    // isolates it: a 404 path needs no store, so dispatch cost here
    // is pure Hono matching + the middleware chain's cheap prefix.
    const { createHonoApp } = await import("../src/hono-app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: DB_URL },
    } as never);
    const factory = (async () => {
      const { StackMateDataStore } = await import("../src/platform/db/store.ts");
      return new StackMateDataStore();
    }) as never;

    const firstFetch: number[] = [];
    const secondFetch: number[] = [];
    const buildOnly: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const app = createHonoApp({ env, storeFactory: factory });
      buildOnly.push(performance.now() - t0);
      const t1 = performance.now();
      const r1 = await app.fetch(new Request("http://localhost:8787/api/v1/no-such-route"), env);
      firstFetch.push(performance.now() - t1);
      assert.equal(r1.status, 404);
      await r1.text();
      const t2 = performance.now();
      const r2 = await app.fetch(new Request("http://localhost:8787/api/v1/no-such-route"), env);
      secondFetch.push(performance.now() - t2);
      assert.equal(r2.status, 404);
      await r2.text();
    }
    stats("createHonoApp (build only)", buildOnly);
    const f = stats("fresh app FIRST dispatch (404)", firstFetch);
    const s = stats("same app SECOND dispatch (404)", secondFetch);
    console.log(
      `[overhead-profile] first-dispatch premium: ${(f.median - s.median).toFixed(2)}ms`
    );

    // Split the premium: bare Hono + routes only, no middleware. If
    // the premium survives here it is the router's lazy matcher
    // build; if it vanishes it is first-run middleware init.
    const { Hono } = await import("hono");
    const { registerAllRoutes: registerRoutes } = await import("../src/routes/index.ts");
    const bareFirst: number[] = [];
    const bareSecond: number[] = [];
    for (let i = 0; i < 20; i++) {
      const bare = new Hono<AppEnv>();
      registerRoutes(bare);
      const t1 = performance.now();
      const r1 = await bare.fetch(new Request("http://localhost:8787/api/v1/no-such-route"), env);
      bareFirst.push(performance.now() - t1);
      assert.equal(r1.status, 404);
      await r1.text();
      const t2 = performance.now();
      const r2 = await bare.fetch(new Request("http://localhost:8787/api/v1/no-such-route"), env);
      bareSecond.push(performance.now() - t2);
      assert.equal(r2.status, 404);
      await r2.text();
    }
    const bf = stats("bare Hono+routes FIRST dispatch (404)", bareFirst);
    const bs = stats("bare Hono+routes SECOND dispatch (404)", bareSecond);
    console.log(
      `[overhead-profile] bare-router first-dispatch premium: ${(bf.median - bs.median).toFixed(2)}ms`
    );
  }, 60_000);

  it("license validate (unknown key → 401) via entrypoint: cold vs warm, construction vs dispatch", async () => {
    const { setupTestDb } = await import("./customer-order-helpers.ts");
    const setup = await setupTestDb("stackmate_test_overhead");
    cleanupDb = setup.cleanup;
    await setup.store.close();
    const url = new URL(DB_URL);
    url.pathname = "/stackmate_test_overhead";
    const dbUrl = url.toString();

    const worker = await import("../src/index.ts");
    const rawEnv = {
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
    } as never;

    // Cold: first license-validate through the entrypoint on this DB
    // (includes first targeted-store creation + signing-key bootstrap).
    const tCold = performance.now();
    const coldRes = await worker.default.fetch(validateRequest(), rawEnv, CTX);
    const coldMs = performance.now() - tCold;
    console.log(`[overhead-profile] license validate cold (entrypoint): ${coldMs.toFixed(2)}ms`);
    assert.equal(coldRes.status, 401, await coldRes.text());

    // Warm via the full entrypoint (per-request Hono app construction
    // + dispatch + targeted store + leased connection + queries).
    // INTERLEAVED with the pre-built app below (ABAB) so CPU drift /
    // GC pauses hit both arms equally — the gap between the two
    // medians IS the per-request app-construction cost
    // (createStackMateApp + buildHonoApp + the second env resolution).
    const { createHonoApp } = await import("../src/hono-app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
    } as never);
    const { createRequestStore } = await import("../src/index.ts");
    const honoApp = createHonoApp({
      env,
      storeFactory: (async (factoryEnv: never, _ctx: never, opts: never) =>
        createRequestStore(factoryEnv as never, (opts as { path?: string } | undefined)?.path)) as never,
    });
    const entryTimes: number[] = [];
    const dispatchTimes: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Alternate which arm runs first each iteration so a
      // first-in-pair warmup/GC effect cancels instead of biasing
      // the gap toward whichever arm always runs first.
      const entryFirst = i % 2 === 0;
      const runEntry = async () => {
        const t0 = performance.now();
        const res = await worker.default.fetch(validateRequest(), rawEnv, CTX);
        entryTimes.push(performance.now() - t0);
        assert.equal(res.status, 401);
        await res.text();
      };
      const runDispatch = async () => {
        const t1 = performance.now();
        const res2 = await honoApp.fetch(validateRequest(), env);
        dispatchTimes.push(performance.now() - t1);
        assert.equal(res2.status, 401);
        await res2.text();
      };
      if (entryFirst) {
        await runEntry();
        await runDispatch();
      } else {
        await runDispatch();
        await runEntry();
      }
    }
    const entryStats = stats("license validate warm (full entrypoint, interleaved)", entryTimes);
    const dispatchStats = stats("license validate warm (pre-built Hono app, interleaved)", dispatchTimes);
    const constructionGap = entryStats.median - dispatchStats.median;
    console.log(
      `[overhead-profile] implied per-request app-construction cost: ${constructionGap.toFixed(2)}ms ` +
        `(entrypoint median ${entryStats.median.toFixed(2)} - prebuilt median ${dispatchStats.median.toFixed(2)})`
    );
    assert.ok(entryStats.median < 500, `entrypoint validate median ${entryStats.median.toFixed(2)}ms`);
    // NOTE: generous timeout — setupTestDb creates a DB + applies 27
    // migrations, which takes >5s when the VM is loaded (parallel
    // tracks run full suites concurrently; a 5s default timed this
    // test out in a contended full-suite run).
  }, 120_000);
});
