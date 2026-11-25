/**
 * Hono app composition smoke test (Hono migration Phase 0, Worker 1).
 *
 * Runs WITHOUT a database: env comes from `resolveRuntimeConfig`
 * (APP_ENV=test, dev defaults apply) and the store factory returns the
 * in-memory `StackMateDataStore`, same as the existing api tests.
 *
 * NOTE: this test can only run once Workers 2/2b (route modules),
 * Worker 3 (middleware) and Worker 4 (GraphQL register) have landed —
 * `createHonoApp` imports all of them. Until then the file fails to
 * load (missing modules), which is expected; the conformance test
 * (Worker 5) builds on these same assertions.
 */
import { describe, expect, it } from "vitest";
import { createHonoApp } from "./hono-app.ts";
import { resolveRuntimeConfig } from "./env.ts";
import { StackMateDataStore } from "./platform/db/store.ts";

function buildTestApp() {
  const env = resolveRuntimeConfig({ APP_ENV: "test" });
  const store = new StackMateDataStore();
  const app = createHonoApp({
    env,
    storeFactory: async () => store,
  });
  return { app, env, store };
}

describe("createHonoApp (composition smoke)", () => {
  it("exposes a Worker-compatible fetch handler", () => {
    const { app } = buildTestApp();
    expect(typeof app.fetch).toBe("function");
  });

  it("registers routes visible via app.routes (conformance hook)", () => {
    const { app } = buildTestApp();
    // 103 OpenAPI paths / 145 operations once all route modules land.
    expect(app.routes.length).toBeGreaterThan(0);
    const methods = new Set(app.routes.map((r) => r.method));
    expect(methods.has("GET")).toBe(true);
  });

  it("accepts the conformance test's no-arg shape: createHonoApp()", () => {
    const app = createHonoApp();
    expect(typeof app.fetch).toBe("function");
    expect(app.routes.length).toBeGreaterThan(0);
  });

  it("accepts the conformance test's store shape: createHonoApp(store)", () => {
    const app = createHonoApp(new StackMateDataStore());
    expect(typeof app.fetch).toBe("function");
    expect(app.routes.length).toBeGreaterThan(0);
  });

  it("answers an unknown route with the 404 NOT_FOUND envelope", async () => {
    const { app } = buildTestApp();
    const res = await app.fetch(
      new Request("http://localhost/api/v1/definitely-not-a-route")
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("not found");
    expect(typeof body.error.request_id).toBe("string");
  });
});
