import { createStackMateApp } from "./app.ts";
import {
  resolveRuntimeConfig,
  type StackMateBindings,
  type WorkerExecutionContext,
} from "./env.ts";
import { DrizzleStore } from "./platform/db/drizzle-store.ts";
import type { StackMateDataStore } from "./platform/db/store.ts";

/**
 * Worker entrypoint: everything is built per request from the env bindings.
 * There is deliberately NO module-level app and NO in-memory store here.
 *
 * Fail-closed order: env is resolved FIRST. In staging/production
 * resolveRuntimeConfig throws without HYPERDRIVE_NO_CACHE (or without the
 * required secrets) and that throw propagates — the request is never served
 * from a silent in-memory fallback.
 *
 * The per-request store is a DrizzleStore backed by the Hyperdrive
 * uncached connection string (see apps/api/src/platform/db/drizzle-store.ts).
 * The license signing private JWK is forwarded when configured; without it
 * the store falls back to a per-process generated key (documented open TODO
 * in drizzle-store.ts — durable key persistence needs a signing_keys table
 * or KMS).
 */
async function createRequestStore(env: StackMateBindings): Promise<StackMateDataStore> {
  return DrizzleStore.create({
    connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
    r2Bucket: env.R2_BUCKET ?? null,
    signingKeyId: env.LICENSE_SIGNING_KEY_ID,
    signingPrivateJwk: env.LICENSE_SIGNING_PRIVATE_JWK,
    signingPublicJwk: env.LICENSE_SIGNING_PUBLIC_JWK,
  });
}

function createRequestApp() {
  return createStackMateApp({
    storeFactory: async (factoryEnv) => createRequestStore(factoryEnv),
  });
}

export default {
  async fetch(
    request: Request,
    env: Partial<StackMateBindings>,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    const resolvedEnv = resolveRuntimeConfig(env);
    const app = createRequestApp();
    return app.fetch(request, resolvedEnv, ctx);
  },
  async scheduled(
    event: { cron?: string; scheduledTime?: number },
    env: Partial<StackMateBindings>,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    const resolvedEnv = resolveRuntimeConfig(env);
    const app = createRequestApp();
    await app.scheduled(event, resolvedEnv, ctx);
  },
};

export { createStackMateApp };
