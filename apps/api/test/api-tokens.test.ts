/**
 * OD-13 scoped API tokens — Worker A (token core + storage).
 *
 * Own fresh databases via `setupTestDb` (journal migrations 0000–0028
 * applied, dropped afterwards); skips cleanly without DATABASE_URL.
 * The migration test runs the real runner (`scripts/migrate.mjs`)
 * against a second scratch DB and asserts the table + permission +
 * grants land there.
 *
 * No real secrets anywhere: PEPPER is a test-only fixture value.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { AppError } from "../src/shared/errors.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { drainConnectionCache } from "../src/platform/db/connection-cache.ts";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
} from "./customer-order-helpers.ts";
import {
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES_EXCLUDED,
  buildApiTokenPrincipal,
  createApiToken,
  generateApiTokenValue,
  isApiTokenValue,
  listApiTokens,
  revokeApiToken,
  validateApiTokenScopes,
  verifyApiToken,
} from "../src/modules/api-tokens/service.ts";

const PEPPER = "od13-test-pepper-2026-11-28";
const CREATED_BY = SUPER_ACTOR.user.id;
const PG_DB_NAME = "stackmate_test_api_tokens";
const MIG_DB_NAME = "stackmate_test_api_tokens_mig";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

function dbUrlFor(dbName: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!DATABASE_URL)("OD-13 scoped API tokens", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];

  beforeAll(async () => {
    const setup = await setupTestDb(PG_DB_NAME);
    cleanup = setup.cleanup;
    store = setup.store;
  }, 180_000);

  afterAll(async () => {
    drainConnectionCache();
    await cleanup?.();
  }, 120_000);

  it("generateApiTokenValue: stk_ + 32 random bytes, base64url, no padding", () => {
    const a = generateApiTokenValue();
    const b = generateApiTokenValue();
    assert.ok(a.startsWith(API_TOKEN_PREFIX));
    assert.equal(a.length, API_TOKEN_PREFIX.length + 43);
    assert.ok(!a.includes("="), "no base64 padding");
    assert.match(a.slice(API_TOKEN_PREFIX.length), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b, "two generated values differ");
    assert.equal(isApiTokenValue(a), true);
    assert.equal(isApiTokenValue("sk_live_abc"), false);
    assert.equal(isApiTokenValue("stk"), false);
    assert.equal(isApiTokenValue(""), false);
  });

  it("create: hash-only storage, value shown once, value verifies", async () => {
    const { record, value } = await createApiToken(store, {
      name: "External client A",
      scopes: ["products.read", "orders.read"],
      expiresAt: null,
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    assert.ok(isApiTokenValue(value));
    assert.equal(record.token_prefix, value.slice(0, 12));
    assert.notEqual(record.token_hash, value, "raw value is never stored");
    assert.ok(
      record.token_hash.startsWith("peppered:"),
      "peppered HMAC-SHA256 storage"
    );
    assert.deepEqual(record.scopes, ["products.read", "orders.read"]);
    assert.equal(record.created_by, CREATED_BY);
    assert.equal(record.expires_at, null);
    assert.equal(record.revoked_at, null);
    assert.ok(record.created_at);

    const found = await verifyApiToken(store, { rawToken: value, pepper: PEPPER });
    assert.ok(found);
    assert.equal(found!.id, record.id);

    // Verify touches last_used_at (visible through list).
    const listed = await listApiTokens(store);
    const listedRow = listed.find((r) => r.id === record.id);
    assert.ok(listedRow);
    assert.notEqual(listedRow!.last_used_at, null);
  });

  it("create: rejects empty / over-long names", async () => {
    await assert.rejects(
      () =>
        createApiToken(store, {
          name: "   ",
          scopes: ["products.read"],
          expiresAt: null,
          createdBy: CREATED_BY,
          pepper: PEPPER,
        }),
      (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
    );
    await assert.rejects(
      () =>
        createApiToken(store, {
          name: "x".repeat(101),
          scopes: ["products.read"],
          expiresAt: null,
          createdBy: CREATED_BY,
          pepper: PEPPER,
        }),
      (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
    );
  });

  it("create + validate: reject excluded and unknown scopes", async () => {
    for (const excluded of API_TOKEN_SCOPES_EXCLUDED) {
      assert.deepEqual(API_TOKEN_SCOPES_EXCLUDED, ["users.manage", "api_tokens.manage"]);
      await assert.rejects(
        () =>
          createApiToken(store, {
            name: "bad scope",
            scopes: [excluded],
            expiresAt: null,
            createdBy: CREATED_BY,
            pepper: PEPPER,
          }),
        (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
      );
      assert.throws(
        () => validateApiTokenScopes([excluded], ["products.read"], ["super_admin"]),
        (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
      );
    }
    await assert.rejects(
      () =>
        createApiToken(store, {
          name: "bad scope",
          scopes: ["nope.not_a_scope"],
          expiresAt: null,
          createdBy: CREATED_BY,
          pepper: PEPPER,
        }),
      (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
    );
    assert.throws(
      () => validateApiTokenScopes(["nope.not_a_scope"], ["products.read"]),
      (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
    );
    assert.throws(
      () => validateApiTokenScopes([], ["products.read"]),
      (e: unknown) => e instanceof AppError && e.code === "VALIDATION_ERROR"
    );
  });

  it("validateApiTokenScopes: held check + super_admin bypass", () => {
    // Creator holds products.read only: granting orders.read is forbidden.
    assert.throws(
      () => validateApiTokenScopes(["orders.read"], ["products.read"], ["admin"]),
      (e: unknown) =>
        e instanceof AppError && e.code === "FORBIDDEN" && e.statusCode === 403
    );
    // Held scope passes.
    validateApiTokenScopes(["products.read"], ["products.read"], ["admin"]);
    // super_admin bypasses the held-check (holds everything by definition).
    validateApiTokenScopes(["orders.read", "licenses.manage"], [], ["super_admin"]);
  });

  it("verify: invalid / wrong-prefix / wrong-pepper return null", async () => {
    const { value } = await createApiToken(store, {
      name: "verify-negatives",
      scopes: ["products.read"],
      expiresAt: null,
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    assert.equal(
      await verifyApiToken(store, {
        rawToken: `${API_TOKEN_PREFIX}${"A".repeat(43)}`,
        pepper: PEPPER,
      }),
      null,
      "well-formed but unissued value must not verify"
    );
    assert.equal(
      await verifyApiToken(store, { rawToken: "sk_live_abcdef", pepper: PEPPER }),
      null,
      "wrong prefix must not verify"
    );
    assert.equal(
      await verifyApiToken(store, { rawToken: value, pepper: "wrong-pepper" }),
      null,
      "wrong pepper must not verify"
    );
    assert.equal(
      await verifyApiToken(store, { rawToken: value.slice(0, -2) + "zz", pepper: PEPPER }),
      null,
      "tampered value must not verify"
    );
  });

  it("verify: expired token returns null (nowMs-controlled)", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { value } = await createApiToken(store, {
      name: "expiry-check",
      scopes: ["products.read"],
      expiresAt: future,
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    const before = await verifyApiToken(store, {
      rawToken: value,
      pepper: PEPPER,
      nowMs: Date.now(),
    });
    assert.ok(before, "valid before expiry");
    const after = await verifyApiToken(store, {
      rawToken: value,
      pepper: PEPPER,
      nowMs: Date.now() + 120_000,
    });
    assert.equal(after, null, "expired at nowMs past expires_at");

    // A token created already-expired never verifies.
    const { value: stale } = await createApiToken(store, {
      name: "already-expired",
      scopes: ["products.read"],
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    assert.equal(
      await verifyApiToken(store, { rawToken: stale, pepper: PEPPER }),
      null
    );
  });

  it("list: no hash, no value; revoke: idempotent, then verify returns null", async () => {
    const { record, value } = await createApiToken(store, {
      name: "revoke-check",
      scopes: ["orders.read"],
      expiresAt: null,
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    const before = await listApiTokens(store);
    const row = before.find((r) => r.id === record.id);
    assert.ok(row);
    assert.equal("token_hash" in row!, false, "list must never expose the hash");
    assert.equal("value" in row!, false, "list must never expose the raw value");

    const revoked = await revokeApiToken(store, { id: record.id });
    assert.ok(revoked.revoked_at);
    assert.equal("token_hash" in revoked, false);
    const revokedAgain = await revokeApiToken(store, { id: record.id });
    assert.equal(
      revokedAgain.revoked_at,
      revoked.revoked_at,
      "second revoke is idempotent (original revoked_at kept)"
    );
    assert.equal(
      await verifyApiToken(store, { rawToken: value, pepper: PEPPER }),
      null,
      "revoked token must not verify"
    );
    await assert.rejects(
      () => revokeApiToken(store, { id: "00000000-0000-4000-8000-000000000000" }),
      (e: unknown) =>
        e instanceof AppError && e.code === "NOT_FOUND" && e.statusCode === 404
    );
  });

  it("buildApiTokenPrincipal: empty roles, exact scopes, api-token identity", async () => {
    const { record } = await createApiToken(store, {
      name: "principal-check",
      scopes: ["products.read", "licenses.read"],
      expiresAt: null,
      createdBy: CREATED_BY,
      pepper: PEPPER,
    });
    const principal = buildApiTokenPrincipal(record);
    assert.deepEqual(principal.roles, [], "never super_admin, never any role");
    assert.deepEqual(principal.permissions, ["products.read", "licenses.read"]);
    assert.equal(principal.session_id, `api-token:${record.id}`);
    assert.equal(principal.user.id, `api-token:${record.id}`);
    assert.equal(principal.user.name, "principal-check");
    assert.equal(principal.user.email, "");
    assert.equal(principal.user.status, "active");
    assert.equal(principal.user.avatar_url, null);
    assert.equal(principal.user.email_verified, true);
    assert.equal(principal.two_factor_enabled, false);
    assert.equal(principal.two_factor_setup_required, false);
  });

  it("create with null pepper: falls back to the store-resolved pepper and verifies", async () => {
    // resolveTokenPepper(store, null) resolves the store's encryption
    // secret (under vitest DrizzleStore carries its dev fallback), so a
    // null caller pepper still yields a peppered hash — never a bare
    // one while any pepper resolves. The same fallback resolves on the
    // verify side, so the token verifies with pepper null too.
    const { record, value } = await createApiToken(store, {
      name: "null-pepper",
      scopes: ["products.read"],
      expiresAt: null,
      createdBy: CREATED_BY,
      pepper: null,
    });
    assert.notEqual(record.token_hash, value);
    assert.ok(
      record.token_hash.startsWith("peppered:"),
      "store-resolved pepper → peppered HMAC-SHA256 storage"
    );
    const found = await verifyApiToken(store, { rawToken: value, pepper: null });
    assert.ok(found);
    assert.equal(found!.id, record.id);
  });

  it("no drizzleDb: create/list/revoke fail honestly, verify returns null", async () => {
    const memoryStore = new StackMateDataStore();
    await assert.rejects(
      () =>
        createApiToken(memoryStore, {
          name: "memory",
          scopes: ["products.read"],
          expiresAt: null,
          createdBy: CREATED_BY,
          pepper: PEPPER,
        }),
      (e: unknown) =>
        e instanceof AppError &&
        e.code === "STORE_UNAVAILABLE" &&
        e.statusCode === 503
    );
    await assert.rejects(
      () => listApiTokens(memoryStore),
      (e: unknown) => e instanceof AppError && e.code === "STORE_UNAVAILABLE"
    );
    await assert.rejects(
      () => revokeApiToken(memoryStore, { id: "00000000-0000-4000-8000-000000000000" }),
      (e: unknown) => e instanceof AppError && e.code === "STORE_UNAVAILABLE"
    );
    assert.equal(
      await verifyApiToken(memoryStore, {
        rawToken: generateApiTokenValue(),
        pepper: PEPPER,
      }),
      null,
      "verify without drizzleDb returns null, never a faked success"
    );
  });
});

describe.skipIf(!DATABASE_URL)("OD-13 migration 0028 via scripts/migrate.mjs", () => {
  it("applies cleanly on a fresh DB: table + permission + super_admin/admin grants", async () => {
    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS "${MIG_DB_NAME}"`);
      await maintenance.query(`CREATE DATABASE "${MIG_DB_NAME}"`);
    } finally {
      await maintenance.end();
    }

    const scratchUrl = dbUrlFor(MIG_DB_NAME);
    let migrateOutput = "";
    try {
      migrateOutput = execFileSync("node", ["scripts/migrate.mjs"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: scratchUrl,
          DATABASE_URL: scratchUrl,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
    } catch (error) {
      const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
      assert.fail(
        `scripts/migrate.mjs failed on fresh DB: ${err.message}\nstdout: ${String(err.stdout ?? "")}\nstderr: ${String(err.stderr ?? "")}`
      );
    }
    assert.match(migrateOutput, /0028_api_tokens/, "runner applied 0028");

    const client = new Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      const table = await client.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'api_tokens'`
      );
      assert.equal(table.rows[0]?.n, 1, "api_tokens table exists");
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'api_tokens'`
      );
      const colNames = new Set(cols.rows.map((r) => r.column_name as string));
      for (const expected of [
        "id",
        "name",
        "token_prefix",
        "token_hash",
        "scopes",
        "created_by",
        "expires_at",
        "revoked_at",
        "last_used_at",
        "created_at",
      ]) {
        assert.ok(colNames.has(expected), `column ${expected} exists`);
      }
      const perm = await client.query(
        `SELECT "id", "key" FROM "permissions" WHERE "key" = 'api_tokens.manage'`
      );
      assert.equal(perm.rows.length, 1, "api_tokens.manage permission exists");
      assert.equal(
        perm.rows[0]?.id,
        "00000000-0000-4000-8000-000000000137",
        "permission id is ...137"
      );
      const grants = await client.query(
        `SELECT r."key" AS role FROM "role_permissions" rp
            JOIN "roles" r ON r."id" = rp."role_id"
            JOIN "permissions" p ON p."id" = rp."permission_id"
           WHERE p."key" = 'api_tokens.manage'
           ORDER BY r."key"`
      );
      assert.deepEqual(
        grants.rows.map((r) => r.role),
        ["admin", "super_admin"],
        "granted to super_admin + admin only"
      );
    } finally {
      await client.end();
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      try {
        await mc.query(`DROP DATABASE IF EXISTS "${MIG_DB_NAME}"`);
      } finally {
        await mc.end();
      }
    }
  }, 300_000);
});
