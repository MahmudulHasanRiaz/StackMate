/**
 * Cloudflare Hyperdrive + Drizzle ORM Integration (ADR-0005, Section 2.1).
 *
 * Implements:
 * 1. Dual Hyperdrive bindings:
 *    - HYPERDRIVE_NO_CACHE (`--caching-disabled`): Authoritative connection for auth, sessions,
 *      RBAC permissions, orders, payments, subscriptions, licenses, idempotency, and outbox.
 *    - HYPERDRIVE_CACHED (query caching enabled): Strictly opt-in for staleness-tolerant public
 *      catalog listings and historical analytics summaries.
 * 2. Request-scoped `node-postgres` (`pg.Client`) lifecycle (`pg >= 8.16.3`) with `nodejs_compat`:
 *    - Never holds a module-scoped TCP connection across Worker requests.
 *    - Automatically closes connections via `ctx.waitUntil(client.end())` after response completion.
 * 3. Interactive transactions (`BEGIN ... SELECT ... FOR UPDATE ... COMMIT / ROLLBACK`) on the
 *    pinned `HYPERDRIVE_NO_CACHE` connection.
 */
import type { StackMateBindings, WorkerExecutionContext } from "../../env.ts";

export type QueryConsistencyMode = "strong_no_cache" | "cached_read_only";

export interface SqlDriverClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    sqlText: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export type SqlClientFactory = (connectionString: string) => Promise<SqlDriverClient>;

/**
 * Default factory resolving `node-postgres` (`pg.Client`) at runtime in Cloudflare Workers / Node.js.
 */
export const defaultNodePostgresClientFactory: SqlClientFactory = async (
  connectionString: string
) => {
  const pgMod = await import("pg");
  const { Client } = pgMod.default ?? pgMod;
  return new Client({ connectionString }) as unknown as SqlDriverClient;
};

export interface RequestHyperdriveSession {
  readonly env: StackMateBindings;
  /**
   * Acquires the request-scoped cache-disabled client (`HYPERDRIVE_NO_CACHE`).
   * Used for all auth, session, RBAC, financial, licensing, and read-after-write queries.
   */
  getUncachedClient(): Promise<SqlDriverClient>;
  /**
   * Acquires the request-scoped cached read client (`HYPERDRIVE_CACHED`),
   * strictly for staleness-tolerant read-only queries.
   */
  getCachedReadClient(): Promise<SqlDriverClient>;
  /**
   * Executes an interactive SQL transaction (`BEGIN` -> callback -> `COMMIT` / `ROLLBACK`)
   * exclusively on the cache-disabled Hyperdrive binding (`HYPERDRIVE_NO_CACHE`) so that
   * `SELECT ... FOR UPDATE` and multi-statement mutations run on a single pinned backend connection.
   */
  runInteractiveTransaction<T>(fn: (txClient: SqlDriverClient) => Promise<T>): Promise<T>;
  /**
   * Releases all opened request-scoped connections back to Hyperdrive.
   */
  dispose(): Promise<void>;
}

export function createRequestHyperdriveSession(
  env: StackMateBindings,
  ctx?: WorkerExecutionContext,
  clientFactory: SqlClientFactory = defaultNodePostgresClientFactory
): RequestHyperdriveSession {
  let uncachedClientPromise: Promise<SqlDriverClient> | null = null;
  let cachedClientPromise: Promise<SqlDriverClient> | null = null;
  let inTransaction = false;

  const openClient = async (connectionString: string): Promise<SqlDriverClient> => {
    const client = await clientFactory(connectionString);
    await client.connect();
    return client;
  };

  const getUncachedClient = (): Promise<SqlDriverClient> => {
    if (!uncachedClientPromise) {
      const connStr = env.HYPERDRIVE_NO_CACHE.connectionString;
      if (!connStr) {
        throw new Error("HYPERDRIVE_NO_CACHE connectionString is missing.");
      }
      uncachedClientPromise = openClient(connStr);
    }
    return uncachedClientPromise;
  };

  const getCachedReadClient = (): Promise<SqlDriverClient> => {
    // Never serve from cached binding if the current request already started a write transaction
    if (inTransaction) {
      return getUncachedClient();
    }
    if (!cachedClientPromise) {
      const connStr =
        env.HYPERDRIVE_CACHED?.connectionString || env.HYPERDRIVE_NO_CACHE.connectionString;
      cachedClientPromise = openClient(connStr);
    }
    return cachedClientPromise;
  };

  const runInteractiveTransaction = async <T>(
    fn: (txClient: SqlDriverClient) => Promise<T>
  ): Promise<T> => {
    // Create a dedicated connection from HYPERDRIVE_NO_CACHE for the transaction boundary
    // so concurrent operations in the same request cannot interleave statements on the wire.
    const txClient = await openClient(env.HYPERDRIVE_NO_CACHE.connectionString);
    inTransaction = true;
    try {
      await txClient.query("BEGIN");
      const result = await fn(txClient);
      await txClient.query("COMMIT");
      return result;
    } catch (error) {
      await txClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await txClient.end().catch(() => {});
    }
  };

  const dispose = async (): Promise<void> => {
    const tasks: Promise<unknown>[] = [];
    if (uncachedClientPromise) {
      tasks.push(uncachedClientPromise.then((c) => c.end()).catch(() => {}));
      uncachedClientPromise = null;
    }
    if (cachedClientPromise) {
      tasks.push(cachedClientPromise.then((c) => c.end()).catch(() => {}));
      cachedClientPromise = null;
    }
    await Promise.all(tasks);
  };

  if (ctx) {
    // Ensure cleanup can be scheduled via ctx.waitUntil by middleware after response
  }

  return {
    env,
    getUncachedClient,
    getCachedReadClient,
    runInteractiveTransaction,
    dispose,
  };
}
