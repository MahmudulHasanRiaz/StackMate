/**
 * B-01 foundation (Audit #2 Critical B-01): the store-factory switch.
 *
 * Covers ONLY the foundation — the allowlist mechanism, the factory
 * path plumbing, and the middleware running on a targeted store:
 *  - `isTargetedOnlyRoute` matching (exact / prefix / loadSigningKey /
 *    trailing-slash) against the (empty) allowlist + temp entries.
 *  - `ensureRequestStore` passes `c.req.path` to the factory.
 *  - `createRequestStore` (index.ts) returns a `createTargeted` store
 *    for an allowlisted path and a full-load store otherwise, with
 *    no behaviour change for non-allowlisted routes.
 *  - `authContext`'s principal resolution (`resolveStaffPrincipal` →
 *    `findStaffPrincipalFast`) works on a `createTargeted` store with
 *    NO combined full-state load — including the missing/suspended-user
 *    fallback, which must NOT trigger `loadState()` (see
 *    `DrizzleStore.isStateFresh` override).
 *  - `rateLimit` (`store.checkRateLimit`, pg-direct) works on a
 *    targeted store; `twoFactorGate` needs no store at all.
 *  - End to end through the real middleware chain: an allowlisted
 *    path gets a targeted store, any other path a full-load store.
 *
 * Postgres tests use their own fresh database
 * (`stackmate_test_b01_foundation`) via `setupTestDb` — the same
 * pattern as `audit-batch-b.test.ts` — and skip cleanly without
 * DATABASE_URL. The pure-unit describes (allowlist matching,
 * `ensureRequestStore` path forwarding, `twoFactorGate`) need no DB
 * and always run.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Client } from "pg";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import {
  TARGETED_ONLY_ROUTES,
  isTargetedOnlyRoute,
  type TargetedRouteEntry,
} from "../src/platform/db/targeted-routes.ts";
import { createRequestStore } from "../src/index.ts";
import type { StackMateBindings } from "../src/env.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { ensureRequestStore } from "../src/middleware/shared.ts";
import { middlewareChain } from "../src/middleware/index.ts";
import { twoFactorGate } from "../src/middleware/two-factor-gate.ts";
import {
  resolveStaffPrincipal,
  type BetterAuthInstance,
  type StaffPrincipal,
} from "../src/modules/identity/service.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import type { StackMateStoreFactory } from "../src/app.ts";
import type { AppEnv } from "../src/types/context.ts";
import type { Context } from "hono";

const TEMP_PATH = "/api/v1/public/b01-test";
const TEMP_PREFIX = "/api/v1/public/b01-prefix";
const OTHER_PATH = "/api/v1/public/b01-other";

/** Count pg queries while patched; returns json_agg (full-load) hits. */
function countJsonAggQueries() {
  let total = 0;
  let jsonAgg = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    total += 1;
    const sql = String(
      (args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? ""
    );
    if (sql.toLowerCase().includes("json_agg")) jsonAgg += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    counts: () => ({ total, jsonAgg }),
    restore: () => {
      Client.prototype.query = orig as never;
    },
  };
}

/** Push temp allowlist entries; returns a remover (always call it). */
function pushTempEntries(entries: TargetedRouteEntry[]): () => void {
  TARGETED_ONLY_ROUTES.push(...entries);
  return () => {
    for (const entry of entries) {
      const idx = TARGETED_ONLY_ROUTES.indexOf(entry);
      if (idx >= 0) TARGETED_ONLY_ROUTES.splice(idx, 1);
    }
  };
}

function stubAuth(email: string): BetterAuthInstance {
  return {
    api: {
      getSession: async () => ({
        session: { id: "s-b01" },
        user: { email },
      }),
    },
  } as unknown as BetterAuthInstance;
}

// ---------------------------------------------------------------------------
// Pure-unit: allowlist matching (no DB) and ensureRequestStore plumbing.
// ---------------------------------------------------------------------------

describe("B-01 foundation: allowlist matching (no DB)", () => {
  it("the shipped allowlist holds exactly the B-01 batch-1 routes (27)", () => {
    // Batch 1 (2026-11-26 integration): license validate (signing key),
    // 4 public catalog routes, 22 admin list routes. Checkout, tracking,
    // detail GETs, /admin/search, and mutations are deliberately absent.
    assert.equal(TARGETED_ONLY_ROUTES.length, 27);
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/licenses/validate"),
      { loadSigningKey: true },
    );
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/public/sites/abc123/products"),
      { loadSigningKey: false },
    );
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/public/sites/abc123/products/widget/packages"),
      { loadSigningKey: false },
    );
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/admin/products"),
      { loadSigningKey: false },
    );
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/admin/customers/cust-1/orders"),
      { loadSigningKey: false },
    );
    assert.deepEqual(
      isTargetedOnlyRoute("/api/v1/admin/licenses/lic-1/activations"),
      { loadSigningKey: false },
    );
    // Not allowlisted: checkout + tracking (unwired), detail GETs,
    // /admin/search, mutations, and paths that do not exist.
    assert.equal(isTargetedOnlyRoute("/api/v1/public/catalog"), null);
    assert.equal(
      isTargetedOnlyRoute("/api/v1/public/sites/abc123/checkout/orders"),
      null,
    );
    assert.equal(
      isTargetedOnlyRoute("/api/v1/public/sites/abc123/tracking/events"),
      null,
    );
    assert.equal(isTargetedOnlyRoute("/api/v1/admin/me"), null);
    assert.equal(isTargetedOnlyRoute("/api/v1/admin/products/prod-1"), null);
    assert.equal(isTargetedOnlyRoute("/api/v1/admin/search"), null);
    assert.equal(isTargetedOnlyRoute("/"), null);
  });

  it("exact entries match exactly (trailing slash tolerated)", () => {
    const remove = pushTempEntries([
      { path: TEMP_PATH },
      { path: "/api/v1/licenses/validate", loadSigningKey: true },
    ]);
    try {
      assert.deepEqual(isTargetedOnlyRoute(TEMP_PATH), { loadSigningKey: false });
      assert.deepEqual(isTargetedOnlyRoute(`${TEMP_PATH}/`), {
        loadSigningKey: false,
      });
      assert.deepEqual(isTargetedOnlyRoute("/api/v1/licenses/validate"), {
        loadSigningKey: true,
      });
      assert.equal(isTargetedOnlyRoute(`${TEMP_PATH}/extra`), null);
      assert.equal(isTargetedOnlyRoute("/api/v1/public/b01-tes"), null);
      assert.equal(isTargetedOnlyRoute(OTHER_PATH), null);
    } finally {
      remove();
    }
  });

  it("prefix entries match the path and paths beneath it, segment-aware", () => {
    const remove = pushTempEntries([{ path: TEMP_PREFIX, prefix: true }]);
    try {
      assert.deepEqual(isTargetedOnlyRoute(TEMP_PREFIX), { loadSigningKey: false });
      assert.deepEqual(isTargetedOnlyRoute(`${TEMP_PREFIX}/catalog`), {
        loadSigningKey: false,
      });
      assert.deepEqual(isTargetedOnlyRoute(`${TEMP_PREFIX}/catalog/items`), {
        loadSigningKey: false,
      });
      // Segment-boundary aware: a longer name sharing the prefix is NOT a match.
      assert.equal(isTargetedOnlyRoute(`${TEMP_PREFIX}-other`), null);
      assert.equal(isTargetedOnlyRoute("/api/v1/public/b01-prefi"), null);
    } finally {
      remove();
    }
  });

  it("an exact entry wins over a prefix entry for the same path", () => {
    const remove = pushTempEntries([
      { path: TEMP_PATH, loadSigningKey: true },
      { path: "/api/v1/public", prefix: true },
    ]);
    try {
      // Exact entry (signing key on) beats the broader prefix (off).
      assert.deepEqual(isTargetedOnlyRoute(TEMP_PATH), { loadSigningKey: true });
      assert.deepEqual(isTargetedOnlyRoute(OTHER_PATH), { loadSigningKey: false });
    } finally {
      remove();
    }
  });

  it(":param segments match any single segment, same length only", () => {
    const remove = pushTempEntries([
      { path: "/api/v1/admin/customers/:customerId/orders" },
      { path: "/api/v1/public/sites/:siteKey/products/:productSlug" },
    ]);
    try {
      assert.deepEqual(
        isTargetedOnlyRoute("/api/v1/admin/customers/cust-9/orders"),
        { loadSigningKey: false },
      );
      assert.deepEqual(
        isTargetedOnlyRoute("/api/v1/public/sites/site-1/products/widget"),
        { loadSigningKey: false },
      );
      // Shorter / longer paths do NOT match (same segment count required).
      assert.equal(
        isTargetedOnlyRoute("/api/v1/admin/customers/cust-9"),
        null,
      );
      assert.equal(
        isTargetedOnlyRoute("/api/v1/admin/customers/cust-9/orders/extra"),
        null,
      );
      assert.equal(
        isTargetedOnlyRoute("/api/v1/public/sites/site-1/packages"),
        null,
      );
    } finally {
      remove();
    }
  });
});

describe("B-01 foundation: ensureRequestStore forwards the path (no DB)", () => {
  it("the factory receives the request pathname as its third arg", async () => {
    const seen: Array<{ path: string | undefined }> = [];
    const factory: StackMateStoreFactory = async (_env, _ctx, opts) => {
      seen.push({ path: opts?.path });
      return new StackMateDataStore();
    };
    const vars: Record<string, unknown> = {};
    const fakeCtx = {
      var: vars,
      req: { path: TEMP_PATH },
      set: (key: string, value: unknown) => {
        vars[key] = value;
      },
    } as unknown as Context<AppEnv>;
    const env = resolveRuntimeConfig({ APP_ENV: "test" });
    const store = await ensureRequestStore(fakeCtx, factory, env);
    assert.ok(store instanceof StackMateDataStore);
    assert.deepEqual(seen, [{ path: TEMP_PATH }]);
    assert.equal(vars.store, store);
  });

  it("twoFactorGate needs no store: it gates on the principal alone", async () => {
    const gate = twoFactorGate();
    const restricted: StaffPrincipal = {
      ...SUPER_ACTOR,
      two_factor_setup_required: true,
    };
    const calls: string[] = [];
    const fakeCtx = (path: string, method: string, principal: StaffPrincipal | null) =>
      ({
        var: { principal },
        req: { path, method },
      }) as unknown as Context<AppEnv>;
    // Restricted principal + non-/me admin path → 403, next() never runs.
    await assert.rejects(
      gate(fakeCtx("/api/v1/admin/users", "GET", restricted), async () => {
        calls.push("next");
      }),
      (e: unknown) =>
        (e as { code?: string }).code === "TWO_FACTOR_SETUP_REQUIRED" &&
        (e as { statusCode?: number }).statusCode === 403
    );
    assert.equal(calls.length, 0);
    // The /me escape hatch still passes through.
    await gate(fakeCtx("/api/v1/admin/me", "GET", restricted), async () => {
      calls.push("next");
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "next");
    // No principal → no gate, whatever the path.
    await gate(fakeCtx("/api/v1/admin/users", "GET", null), async () => {
      calls.push("next");
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1], "next");
  });
});

// ---------------------------------------------------------------------------
// Postgres: factory decision, targeted-store state, middleware on targeted.
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)("B-01 foundation: postgres", () => {
  const PG_DB_NAME = "stackmate_test_b01_foundation";
  let store: DrizzleStore;
  let adminClient: Client;
  let cleanup: () => Promise<void>;
  let dbUrl: string;

  beforeAll(async () => {
    const setup = await setupTestDb(PG_DB_NAME);
    store = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${PG_DB_NAME}`;
    dbUrl = url.toString();
    // SUPER_ACTOR needs its super_admin role for the principal lookup
    // to carry roles/permissions (setupTestDb seeds only the user row).
    await store.withTransaction((state) => {
      const role = state.roles.find((r) => r.key === "super_admin")!;
      state.user_roles.push({
        user_id: SUPER_ACTOR.user.id,
        role_id: role.id,
        assigned_at: new Date().toISOString(),
      });
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  function testEnv(): StackMateBindings {
    return {
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
      APP_ENV: "test",
    } as unknown as StackMateBindings;
  }

  it("factory decision: allowlisted path → targeted store, other path → full store", async () => {
    const remove = pushTempEntries([{ path: TEMP_PATH }]);
    const opened: DrizzleStore[] = [];
    try {
      const counter = countJsonAggQueries();
      let targeted: StackMateDataStore;
      try {
        targeted = await createRequestStore(testEnv(), TEMP_PATH);
      } finally {
        const { jsonAgg } = counter.counts();
        counter.restore();
        assert.equal(jsonAgg, 0, "creating a targeted store ran the full-state load");
      }
      opened.push(targeted as DrizzleStore);
      assert.equal(
        (targeted as DrizzleStore).targetedOnly,
        true,
        "allowlisted path must get a targeted store"
      );
      // Seed-only state: the DB holds the super-admin user, but the
      // targeted store never loaded it.
      assert.equal(targeted.state.users.length, 0);
      assert.ok(targeted.state.roles.length > 0, "seed roles are present");
      assert.ok(
        targeted.state.roles.every((r) => r.is_system),
        "targeted state holds seed roles only"
      );

      const full = await createRequestStore(testEnv(), "/api/v1/admin/me");
      opened.push(full as DrizzleStore);
      assert.equal(
        (full as DrizzleStore).targetedOnly,
        false,
        "non-allowlisted path must get a full-load store"
      );
      assert.ok(
        full.state.users.some((u) => u.email === SUPER_ACTOR.user.email),
        "full-load store holds the DB user rows"
      );
    } finally {
      remove();
      for (const s of opened) await s.close().catch(() => {});
    }
  });

  it("authContext principal resolves on a targeted store with no full load", async () => {
    const targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });
    try {
      const counter = countJsonAggQueries();
      let principal: StaffPrincipal | null;
      try {
        principal = await resolveStaffPrincipal(targeted, {
          auth: stubAuth(SUPER_ACTOR.user.email),
          cookieHeader: "better-auth.session_token=<redacted>",
        });
      } finally {
        const { total, jsonAgg } = counter.counts();
        counter.restore();
        assert.equal(jsonAgg, 0, "principal resolution ran the full-state load");
        assert.ok(total > 0, "resolution should have run targeted queries");
      }
      assert.ok(principal, "valid session must resolve a principal");
      assert.equal(principal.user.email, SUPER_ACTOR.user.email);
      assert.ok(principal.roles.includes("super_admin"));
      assert.ok(principal.permissions.length > 0);
      assert.equal(principal.two_factor_setup_required, false);
      // State stayed seed-only — nothing was loaded behind our back.
      assert.equal(targeted.state.users.length, 0);
    } finally {
      await targeted.close();
    }
  });

  it("missing/suspended-user fallback does NOT full-load a targeted store", async () => {
    const targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });
    try {
      // A valid session for a user that does not exist: the targeted
      // fast path returns null, and the old fallback would have called
      // loadState() (full ~65-table load) to double-check. On a
      // targeted store that reload is suppressed (isStateFresh
      // override) — the answer stays null, with no full load.
      const counter = countJsonAggQueries();
      let principal: StaffPrincipal | null;
      try {
        principal = await resolveStaffPrincipal(targeted, {
          auth: stubAuth("ghost@stackmate.local"),
          cookieHeader: "better-auth.session_token=<redacted>",
        });
      } finally {
        const { jsonAgg } = counter.counts();
        counter.restore();
        assert.equal(
          jsonAgg,
          0,
          "missing-user fallback ran the full-state load on a targeted store"
        );
      }
      assert.equal(principal, null);
      assert.equal(targeted.state.users.length, 0);
      assert.equal(targeted.isStateFresh(), true);
    } finally {
      await targeted.close();
    }
  });

  it("rateLimit checkRateLimit works on a targeted store (pg-direct)", async () => {
    const targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });
    const bucket = `b01:test:${Date.now()}`;
    try {
      await targeted.checkRateLimit(bucket, 2);
      await targeted.checkRateLimit(bucket, 2);
      await assert.rejects(
        targeted.checkRateLimit(bucket, 2),
        (e: unknown) =>
          (e as { code?: string }).code === "RATE_LIMIT_EXCEEDED" &&
          (e as { statusCode?: number }).statusCode === 429
      );
      const res = await adminClient.query(
        `SELECT "count" FROM rate_limit_buckets WHERE "key" = $1`,
        [bucket]
      );
      assert.equal(Number(res.rows[0]?.count), 3, "bucket rows are DB-backed, not in-memory");
      assert.equal(targeted.state.users.length, 0, "no full load happened");
    } finally {
      await targeted.resetRateLimit(bucket).catch(() => {});
      await targeted.close();
    }
  });

  it("middleware chain end to end: allowlisted path is targeted, other path is full", async () => {
    const remove = pushTempEntries([{ path: TEMP_PATH }]);
    try {
      const env = {
        ...resolveRuntimeConfig({ APP_ENV: "test" }),
        HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
      } as StackMateBindings;
      const seen: Array<{ path: string | undefined; targeted: boolean }> = [];
      const factory: StackMateStoreFactory = async (factoryEnv, _ctx, opts) => {
        const created = await createRequestStore(factoryEnv, opts?.path);
        seen.push({
          path: opts?.path,
          targeted: (created as DrizzleStore).targetedOnly,
        });
        return created;
      };
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("env", env);
        await next();
      });
      app.use(...middlewareChain(env, factory));
      const probe = (c: Context<AppEnv>) =>
        c.json({
          ok: true,
          targeted: (c.var.store as DrizzleStore).targetedOnly,
        });
      app.get(TEMP_PATH, probe);
      app.get(OTHER_PATH, probe);

      const targetedRes = await app.request(
        new Request(`http://localhost:8787${TEMP_PATH}`)
      );
      if (targetedRes.status !== 200) assert.fail(await targetedRes.text());
      const targetedBody = (await targetedRes.json()) as { targeted: boolean };
      assert.equal(targetedBody.targeted, true);

      const fullRes = await app.request(
        new Request(`http://localhost:8787${OTHER_PATH}`)
      );
      if (fullRes.status !== 200) assert.fail(await fullRes.text());
      const fullBody = (await fullRes.json()) as { targeted: boolean };
      assert.equal(fullBody.targeted, false);

      assert.deepEqual(
        seen.map((s) => ({ path: s.path, targeted: s.targeted })),
        [
          { path: TEMP_PATH, targeted: true },
          { path: OTHER_PATH, targeted: false },
        ],
        "the factory saw each request path exactly once, in order"
      );
    } finally {
      remove();
    }
  });
});
