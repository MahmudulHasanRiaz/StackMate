#!/usr/bin/env node
/**
 * StackMate API smoke check.
 *
 * Boots the real API app in memory (Node 24 type-strips the .ts source
 * directly — no build cache, no transpiled copy) and verifies
 * `/api/v1/health` and `/api/v1/licenses/signing-keys` respond with the
 * expected envelopes.
 *
 * HONEST SCOPE: this runs with APP_ENV=test and the in-memory test
 * adapter, so it verifies routing, envelopes, and the signing-key
 * endpoint — NOT production persistence, Hyperdrive, or Better Auth.
 * Those are covered by `pnpm test` (vitest) and the deployment
 * workflow's post-deploy checks. It deliberately does NOT assert that
 * Hyperdrive bindings are "configured": in test env the config falls
 * back to a local DATABASE_URL, which is not a real Hyperdrive binding.
 */
import assert from "node:assert/strict";
import { createStackMateApp } from "../apps/api/src/app.ts";
import { StackMateDataStore } from "../apps/api/src/platform/db/store.ts";
import { resolveRuntimeConfig } from "../apps/api/src/env.ts";

const env = resolveRuntimeConfig({ APP_ENV: "test" });
const app = createStackMateApp(new StackMateDataStore());

const healthRes = await app.fetch(new Request("http://localhost:8787/api/v1/health"), env);
assert.equal(healthRes.status, 200);
const healthBody = await healthRes.json();
assert.equal(healthBody.data.status, "ok");
assert.equal(healthBody.data.service, "stackmate-api");

const keysRes = await app.fetch(
  new Request("http://localhost:8787/api/v1/licenses/signing-keys"),
  env
);
assert.equal(keysRes.status, 200);
const keysBody = await keysRes.json();
assert.ok(Array.isArray(keysBody.data.keys));
assert.ok(keysBody.data.keys.length >= 1);
assert.equal(keysBody.data.keys[0].alg, "EdDSA");

console.log(
  "API smoke check passed: /api/v1/health and /api/v1/licenses/signing-keys verified (test env, in-memory test adapter)."
);
