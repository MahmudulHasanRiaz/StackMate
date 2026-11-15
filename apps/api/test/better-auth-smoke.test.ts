/**
 * Better Auth smoke tests (in-memory test adapter, no live database).
 *
 * GET /api/auth/ok must return the REAL Better Auth response
 * ({ ok: true }, status 200 — verified against better-auth 1.7.23
 * dist/api/routes/ok.mjs, which returns `ctx.json({ ok: true })`).
 * Building the auth instance for the in-memory store lazily creates a `pg`
 * Client + drizzle() but opens no connection, so this needs no live DB.
 *
 * GET /api/auth/session without credentials must still return 401 from
 * the unified staff-session route (Better Auth backed when the store has
 * a database; test-adapter sessions otherwise).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

describe("Better Auth smoke (in-memory test adapter)", () => {
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;

  beforeEach(() => {
    env = resolveRuntimeConfig({ APP_ENV: "test" });
    app = createStackMateApp(new StackMateDataStore());
  });

  it("GET /api/auth/ok returns a real Better Auth { ok: true } response", async () => {
    const res = await app.fetch(new Request("http://localhost:8787/api/auth/ok"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.deepEqual(body, { ok: true });
  });

  it("GET /api/auth/session without credentials still returns 401 from the custom route", async () => {
    const res = await app.fetch(
      new Request("http://localhost:8787/api/auth/session"),
      env
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "UNAUTHORIZED");
  });
});
