import { Client } from "pg";
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
 * The license signing private JWK is forwarded when configured; the
 * signing keys themselves are durable (signing_keys table, migration
 * 0004) and the envelope-encryption secret is forwarded below, so a
 * Worker boot decrypts the stored keys instead of generating a
 * per-process key. Without ENCRYPTION_KEY_V1 the store fails closed
 * at boot (see DrizzleStore.resolveEncryptionSecret).
 *
 * Perf (2026-11-15) — ONE pg Client per isolate: the client is a
 * module-level lazy singleton keyed by connection string, shared by
 * every request's DrizzleStore in this isolate (the store itself stays
 * per-request: fresh in-memory state, fresh signing-key handles). A
 * fresh connect + ~55 queries per request measured 13–35s per request
 * on staging (Hyperdrive→Neon round-trips); sharing the client cuts
 * that to ~10 round-trips per request (one combined load + the
 * signing-key section in create(), one load + persist in the handler
 * transaction). The client is evicted on 'error'/'end' and on
 * connect failure, and createRequestStore retries ONCE after eviction
 * when the failure looks like a dead connection (a frozen isolate can
 * hold a stale TCP socket — the exact scenario ADR-0005 warned about).
 * This deliberately contradicts hyperdrive.ts §2.1 ("Never holds a
 * module-scoped TCP connection across Worker requests") — that ADR
 * must be updated to bless the singleton, or this must be reverted.
 * Workers isolates cannot share a client, so there is no cross-isolate
 * pool: each isolate holds its own single connection.
 */
const sharedClients = new Map<string, Promise<Client>>();

function evictSharedClient(connectionString: string, entry: Promise<Client>): void {
  if (sharedClients.get(connectionString) === entry) {
    sharedClients.delete(connectionString);
  }
}

function getSharedClient(connectionString: string): Promise<Client> {
  const hit = sharedClients.get(connectionString);
  if (hit !== undefined) return hit;
  const entry = (async () => {
    const client = new Client({ connectionString });
    client.on("error", () => evictSharedClient(connectionString, entry));
    client.on("end", () => evictSharedClient(connectionString, entry));
    await client.connect();
    return client;
  })();
  entry.catch(() => evictSharedClient(connectionString, entry));
  sharedClients.set(connectionString, entry);
  return entry;
}

/** True when the failure looks like a dead/broken TCP connection. */
function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /connection (terminated|closed|reset|refused|timed out)|client has encountered a connection error|connection error/i.test(
    message
  );
}

async function createRequestStore(env: StackMateBindings): Promise<StackMateDataStore> {
  const connectionString = env.HYPERDRIVE_NO_CACHE.connectionString;
  const opts = {
    connectionString,
    r2Bucket: env.R2_BUCKET ?? null,
    signingKeyId: env.LICENSE_SIGNING_KEY_ID,
    signingPrivateJwk: env.LICENSE_SIGNING_PRIVATE_JWK,
    signingPublicJwk: env.LICENSE_SIGNING_PUBLIC_JWK,
    encryptionSecret: env.ENCRYPTION_KEY_V1,
    appEnv: env.APP_ENV,
  };
  try {
    const existingClient = await getSharedClient(connectionString);
    return await DrizzleStore.create({ ...opts, existingClient });
  } catch (error) {
    // One retry on a connection-like failure, after evicting the
    // possibly stale client. Any other failure (missing tables,
    // undecryptable keys, bad config) propagates unchanged — retrying
    // a deterministic boot failure would only fail twice.
    if (!isConnectionError(error)) throw error;
    const current = sharedClients.get(connectionString);
    if (current !== undefined) {
      // Evict whatever is cached (it may be the stale client, or a
      // fresh entry created while this request was failing) so the
      // retry connects anew; getSharedClient recreates on demand.
      sharedClients.delete(connectionString);
      await current.catch(() => {});
    }
    const existingClient = await getSharedClient(connectionString);
    return DrizzleStore.create({ ...opts, existingClient });
  }
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
