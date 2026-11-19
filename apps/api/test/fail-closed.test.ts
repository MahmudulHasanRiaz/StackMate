/**
 * Fail-closed tests: in staging/production the API must NEVER silently serve
 * requests from an in-memory store when Hyperdrive is missing.
 *
 * resolveRuntimeConfig throws "HYPERDRIVE_NO_CACHE binding is required in
 * staging/production." — the Worker entrypoint (apps/api/src/index.ts) lets
 * that throw propagate before any store is created, and
 * createStackMateApp's fetch path resolves env before resolving a store.
 * A store-creation failure AFTER env resolution (e.g. the factory cannot
 * connect) answers with the standard JSON 500 envelope
 * (STORE_UNAVAILABLE) instead of escaping as a bare Worker exception —
 * still fail-closed: nothing is served and there is no in-memory
 * fallback (2026-11-15, staging 1101 fix).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createStackMateApp } from "../src/app.ts";
import type { StackMateBindings } from "../src/env.ts";

const PRODUCTION_SECRETS = {
  BETTER_AUTH_SECRET: "production-better-auth-secret-at-least-32-chars",
  ENCRYPTION_KEY_V1: "production-aes-256-gcm-master-key-32-bytes!!",
  LICENSE_VERIFIER_SECRET: "production-license-verifier-secret",
  CHECKOUT_TOKEN_SECRET: "production-checkout-token-secret",
} as const;

/** Production env with every required secret EXCEPT any Hyperdrive binding. */
function productionEnvWithoutHyperdrive(): Partial<StackMateBindings> {
  return {
    APP_ENV: "production",
    ...PRODUCTION_SECRETS,
  };
}

describe("fail-closed without Hyperdrive (production)", () => {
  it("index default export fetch rejects with a HYPERDRIVE error, never serves", async () => {
    const req = new Request("http://localhost:8787/api/v1/health");
    await assert.rejects(
      () => worker.fetch(req, productionEnvWithoutHyperdrive(), { waitUntil: () => {} }),
      /HYPERDRIVE/
    );
  });

  it("index default export scheduled rejects with a HYPERDRIVE error", async () => {
    await assert.rejects(
      () => worker.scheduled({}, productionEnvWithoutHyperdrive(), { waitUntil: () => {} }),
      /HYPERDRIVE/
    );
  });

  it("createStackMateApp with a Hyperdrive-requiring factory answers JSON 500 STORE_UNAVAILABLE instead of falling back to memory", async () => {
    const app = createStackMateApp({
      storeFactory: async () => {
        // Simulates a factory that cannot build its store (e.g. its
        // Hyperdrive-backed DrizzleStore construction failed).
        throw new Error("HYPERDRIVE_NO_CACHE connection could not be established.");
      },
    });
    const req = new Request("http://localhost:8787/api/v1/health");
    // 2026-11-15: a store-creation failure no longer escapes as a bare
    // Worker exception (Cloudflare 1101, opaque to clients). fetchHandler
    // answers with the standard JSON error envelope instead — still
    // fail-closed (nothing is served, no in-memory fallback), only the
    // failure's shape changed from a throw to a retryable 500.
    const res = await app.fetch(req, {
      APP_ENV: "production",
      ...PRODUCTION_SECRETS,
      HYPERDRIVE_NO_CACHE: {
        connectionString: "postgresql://postgres:postgres@localhost:5432/stackmate",
      },
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    assert.equal(body.error?.code, "STORE_UNAVAILABLE");
    assert.match(body.error?.message ?? "", /temporarily unavailable/);
  });

  it("staging fails closed the same way as production", async () => {
    const req = new Request("http://localhost:8787/api/v1/health");
    await assert.rejects(
      () =>
        worker.fetch(
          req,
          { APP_ENV: "staging", ...PRODUCTION_SECRETS },
          { waitUntil: () => {} }
        ),
      /HYPERDRIVE/
    );
  });
});
