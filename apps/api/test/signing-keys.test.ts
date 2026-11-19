/**
 * Durable license signing keys (migration 0004) — DrizzleStore tests.
 *
 * Requires a reachable Postgres database named for testing, supplied via
 * DATABASE_URL, e.g.:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test
 *
 * When DATABASE_URL is unset the whole suite SKIPS cleanly (it does not
 * fake-pass and does not fail). The suite never touches a database whose
 * name does not contain "test" — it refuses to apply migrations otherwise.
 *
 * The suite TRUNCATES signing_keys + signing_key_metadata in beforeAll
 * (and again before the env-JWK import test) so each scenario starts from
 * a known key state on the shared test database. It uses the SAME master
 * secret as every other suite — the local/test dev fallback from env.ts
 * (no explicit encryptionSecret): envelope encryption is per-database,
 * so two boots with different ENCRYPTION_KEY_V1 values against one DB
 * cannot both decrypt, and a boot with the wrong secret must fail closed
 * (test (f) proves that). Run this file on its own for deterministic
 * results:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test \
 *     pnpm exec vitest run apps/api/test/signing-keys.test.ts
 * (In a full parallel `vitest run`, another file's DrizzleStore boot can
 * legitimately converge on the same single bootstrap row — the bootstrap
 * is race-safe by design — but the env-JWK import test needs an empty
 * signing_keys table at the moment it boots, so run it standalone.)
 *
 * Restart-persistence check for the coordinator: test (b) issues an
 * entitlement JWS with one DrizzleStore instance, constructs a brand-new
 * DrizzleStore on the same database, and verifies the token with it:
 *   pnpm exec vitest run apps/api/test/signing-keys.test.ts -t "restart"
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import {
  signEntitlementJws,
  type Ed25519KeyMaterial,
} from "../src/platform/crypto/index.ts";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import type { StackMateDataStore } from "../src/platform/db/store.ts";
import type { EntitlementTokenClaims } from "../../../packages/contracts/src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[signing-keys] DATABASE_URL is not set — skipping the durable signing " +
      "keys suite. Set DATABASE_URL to a test database (e.g. " +
      "postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test) to run it."
  );
}

/** The DrizzleStore surface this suite exercises (structural, not the class). */
interface TestStore {
  getActiveSigningKey(): Ed25519KeyMaterial;
  verifyEntitlementJws(token: string): {
    header: { alg: string; typ: string; kid: string };
    claims: EntitlementTokenClaims;
  };
  listPublicSigningKeys(): Array<Record<string, unknown>>;
  rotateSigningKey(
    newKeyId?: string,
    options?: { reason?: string }
  ): Promise<Ed25519KeyMaterial>;
  revokeSigningKey(keyId: string): Promise<void>;
  signingKeys: Map<string, Ed25519KeyMaterial>;
  close(): Promise<void>;
}

function makeClaims(overrides: Partial<EntitlementTokenClaims> = {}): EntitlementTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "http://localhost:8787",
    aud: "stackmate-product:TEST",
    sub: "LIC-TEST-1",
    iat: now,
    nbf: now,
    exp: now + 3600,
    jti: `ent_${randomUUID()}`,
    entitlement_version: 1,
    product_code: "TEST",
    license_status: "active",
    grace_until: null,
    activation_usage: { active_count: 0, activation_limit: 1 },
    entitlements: {},
    ...overrides,
  };
}

function jwsKid(token: string): string {
  const header = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")
  ) as { kid: string };
  return header.kid;
}

describe.skipIf(!DATABASE_URL)("Durable signing keys (Postgres)", () => {
  let adminClient: Client;
  const extraStores: TestStore[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  async function openStore(extraOpts: Record<string, unknown> = {}): Promise<TestStore> {
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    const store = await DrizzleStore.create({
      connectionString: DATABASE_URL!,
      // No explicit encryptionSecret: this suite uses the shared local/test
      // dev fallback (see the header comment) — the same secret every
      // other suite's DrizzleStore boot resolves to.
      appEnv: "test",
      ...extraOpts,
    });
    const testStore = store as unknown as TestStore;
    extraStores.push(testStore);
    return testStore;
  }

  async function signingKeyRows(): Promise<
    Array<{ key_id: string; status: string; supersedes_key_id: string | null; rotation_reason: string | null }>
  > {
    const res = await adminClient.query(
      `SELECT key_id, status, supersedes_key_id, rotation_reason
         FROM signing_keys ORDER BY created_at ASC, key_id ASC`
    );
    return res.rows as Array<{
      key_id: string;
      status: string;
      supersedes_key_id: string | null;
      rotation_reason: string | null;
    }>;
  }

  async function truncateSigningKeys(): Promise<void> {
    await adminClient.query(`TRUNCATE signing_keys, signing_key_metadata`);
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const dbName = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    assert.ok(
      dbName.includes("test"),
      `Refusing to apply migrations: database name "${dbName}" does not contain "test". ` +
        `Use a dedicated test database such as stackmate_test.`
    );

    // No env JWK anywhere in this suite unless a single test sets it
    // explicitly via create() options — the bootstrap/generation paths
    // must be exercised without one.
    for (const key of [
      "LICENSE_SIGNING_PRIVATE_JWK",
      "LICENSE_SIGNING_PUBLIC_JWK",
      "ENCRYPTION_KEY_V1",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    adminClient = new Client({ connectionString: DATABASE_URL });
    await adminClient.connect();

    // Apply every migration in the journal, in order (0000-0004). All
    // migrations are idempotent, so re-running against the same test
    // database is safe.
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    assert.ok(
      journal.entries.some((e) => e.tag === "0004_signing_keys"),
      "journal must list 0004_signing_keys"
    );
    for (const entry of journal.entries) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        "utf8"
      );
      await adminClient.query(sql);
    }

    await truncateSigningKeys();
  }, 60_000);

  afterAll(async () => {
    for (const s of extraStores) {
      try {
        await s?.close();
      } catch {
        // Best-effort teardown; a close failure must not mask test results.
      }
    }
    try {
      await adminClient?.end();
    } catch {
      // Best-effort teardown.
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("(a) fresh DB, no env key: first store generates + persists exactly one active key", async () => {
    const store = await openStore();

    const rows = await signingKeyRows();
    assert.equal(rows.length, 1, `expected exactly 1 signing_keys row, got ${rows.length}`);
    assert.equal(rows[0]?.status, "active");
    assert.ok(
      /^sm-ed25519-\d{4}-\d{2}$/.test(rows[0]?.key_id ?? ""),
      `bootstrap key id should be sm-ed25519-YYYY-MM, got ${rows[0]?.key_id}`
    );

    const active = store.getActiveSigningKey();
    assert.equal(active.keyId, rows[0]?.key_id);
    assert.equal((active.publicKeyJwk as { kid: string }).kid, rows[0]?.key_id);

    // The public mirror stays in sync: one metadata row, same key id.
    const meta = await adminClient.query(
      `SELECT key_id, status FROM signing_key_metadata`
    );
    assert.equal(meta.rowCount, 1);
    assert.equal(meta.rows[0]?.key_id, rows[0]?.key_id);
    assert.equal(meta.rows[0]?.status, "active");
  });

  it("(b) restart persistence: a new store instance loads the SAME key and verifies its tokens", async () => {
    const first = await openStore();
    const firstActive = first.getActiveSigningKey();
    const token = signEntitlementJws(makeClaims(), firstActive);

    // Brand-new store = simulated restart: new pg client, new process state.
    const second = await openStore();
    const secondActive = second.getActiveSigningKey();
    assert.equal(secondActive.keyId, firstActive.keyId);
    assert.deepEqual(secondActive.publicKeyJwk, firstActive.publicKeyJwk);

    // Still exactly one active row — the second boot did NOT mint a key.
    const rows = await signingKeyRows();
    assert.equal(rows.filter((r) => r.status === "active").length, 1);
    assert.equal(rows.length, 1);

    const verified = second.verifyEntitlementJws(token);
    assert.equal(verified.header.kid, firstActive.keyId);
    assert.equal(verified.claims.sub, "LIC-TEST-1");
  });

  it("(c) rotate: new active key, old token still verifies, new tokens use the new kid", async () => {
    const store = await openStore();
    const oldActive = store.getActiveSigningKey();
    const oldToken = signEntitlementJws(makeClaims(), oldActive);

    const rotated = await store.rotateSigningKey(undefined, {
      reason: "scheduled rotation (signing-keys test)",
    });
    assert.notEqual(rotated.keyId, oldActive.keyId);
    assert.ok(
      /^sm-ed25519-\d{4}-\d{2}(-\d+)?$/.test(rotated.keyId),
      `rotated key id should be sm-ed25519-YYYY-MM[-n], got ${rotated.keyId}`
    );
    assert.equal(store.getActiveSigningKey().keyId, rotated.keyId);

    // Durable state: old retired (superseded by new), new active, one active.
    const rows = await signingKeyRows();
    assert.equal(rows.filter((r) => r.status === "active").length, 1);
    const oldRow = rows.find((r) => r.key_id === oldActive.keyId);
    const newRow = rows.find((r) => r.key_id === rotated.keyId);
    assert.equal(oldRow?.status, "retired");
    assert.equal(newRow?.status, "active");
    assert.equal(newRow?.supersedes_key_id, oldActive.keyId);
    assert.equal(newRow?.rotation_reason, "scheduled rotation (signing-keys test)");

    // Old token still verifies — on the same store and on a FRESH store
    // (retired keys load from the DB on boot).
    const fresh = await openStore();
    const verifiedOld = fresh.verifyEntitlementJws(oldToken);
    assert.equal(verifiedOld.header.kid, oldActive.keyId);

    // New tokens use the new kid and verify too.
    const newToken = signEntitlementJws(makeClaims(), fresh.getActiveSigningKey());
    assert.equal(jwsKid(newToken), rotated.keyId);
    const verifiedNew = fresh.verifyEntitlementJws(newToken);
    assert.equal(verifiedNew.header.kid, rotated.keyId);

    // GET /api/v1/licenses/signing-keys publishes active + retired keys.
    const app = createStackMateApp(fresh as unknown as StackMateDataStore);
    const res = await app.fetch(
      new Request("http://localhost:8787/api/v1/licenses/signing-keys"),
      resolveRuntimeConfig({ APP_ENV: "test" })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { keys: Array<{ kid: string }> };
    };
    const kids = body.data.keys.map((k) => k.kid).sort();
    assert.deepEqual(kids, [oldActive.keyId, rotated.keyId].sort());
  });

  it("(d) revoke old key: its tokens no longer verify, new tokens still do", async () => {
    const rowsBefore = await signingKeyRows();
    const retired = rowsBefore.find((r) => r.status === "retired");
    const active = rowsBefore.find((r) => r.status === "active");
    assert.ok(retired, "expected a retired key from the rotation test");
    assert.ok(active, "expected an active key from the rotation test");

    const store = await openStore();
    const retiredMaterial = store.signingKeys.get(retired.key_id);
    assert.ok(retiredMaterial, "retired key must be loaded for verification");
    const oldToken = signEntitlementJws(makeClaims(), retiredMaterial);
    assert.equal(jwsKid(oldToken), retired.key_id);
    // Sanity: the retired token verifies before revocation.
    store.verifyEntitlementJws(oldToken);

    await store.revokeSigningKey(retired.key_id);

    const rowsAfter = await signingKeyRows();
    assert.equal(
      rowsAfter.find((r) => r.key_id === retired.key_id)?.status,
      "revoked"
    );

    // A fresh store never loads the revoked key: its tokens fail, and its
    // public JWK leaves the JWKS endpoint.
    const fresh = await openStore();
    assert.throws(
      () => fresh.verifyEntitlementJws(oldToken),
      /unknown or revoked key/
    );
    assert.ok(
      !fresh
        .listPublicSigningKeys()
        .some((k) => (k as { kid: string }).kid === retired.key_id),
      "revoked key must not be published"
    );

    // The still-active key is unaffected.
    const newToken = signEntitlementJws(makeClaims(), fresh.getActiveSigningKey());
    assert.equal(jwsKid(newToken), active.key_id);
    fresh.verifyEntitlementJws(newToken);

    // The active key itself cannot be revoked — rotate first.
    await assert.rejects(
      fresh.revokeSigningKey(active.key_id),
      /Cannot revoke the active signing key/
    );
  });

  it("(e) env-JWK import: env private JWK is imported once and reused on second boot", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const importKeyId = "sm-ed25519-2026-11-import";

    // The import path needs an empty signing_keys table at boot. In a
    // full parallel run another suite's DrizzleStore boot can win the
    // empty table first (its generated key then becomes the active row
    // and the env JWK is correctly ignored) — retry the truncate+boot a
    // bounded number of times instead of flaking on that race.
    let first: TestStore | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await truncateSigningKeys();
      const candidate = await openStore({
        signingPrivateJwk: JSON.stringify(privateJwk),
        signingKeyId: importKeyId,
      });
      if (candidate.getActiveSigningKey().keyId === importKeyId) {
        first = candidate;
        break;
      }
      // A concurrent boot won the empty table; its store is tracked for
      // teardown in extraStores — drop our reference and retry.
      await candidate.close();
    }
    assert.ok(first, "env-JWK import did not win the empty table in 3 attempts");
    assert.equal(first.getActiveSigningKey().keyId, importKeyId);
    assert.equal(
      (first.getActiveSigningKey().publicKeyJwk as { x: string }).x,
      publicJwk["x"]
    );

    let rows = await signingKeyRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.key_id, importKeyId);
    assert.equal(rows[0]?.status, "active");

    // Second boot with the SAME env JWK reuses the row — no duplicate.
    const second = await openStore({
      signingPrivateJwk: JSON.stringify(privateJwk),
      signingKeyId: importKeyId,
    });
    assert.equal(second.getActiveSigningKey().keyId, importKeyId);
    assert.deepEqual(
      second.getActiveSigningKey().publicKeyJwk,
      first.getActiveSigningKey().publicKeyJwk
    );
    rows = await signingKeyRows();
    assert.equal(rows.length, 1, "second boot must not insert a duplicate row");

    // Tokens cross-verify between the two instances.
    const token = signEntitlementJws(makeClaims(), first.getActiveSigningKey());
    second.verifyEntitlementJws(token);
  });

  it("(f) undecryptable stored key fails closed at boot", async () => {
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");

    // A boot with a DIFFERENT master secret than the one that encrypted
    // the stored key fails closed — it must never silently mint a
    // replacement key (that would invalidate every token ever signed).
    await assert.rejects(
      DrizzleStore.create({
        connectionString: DATABASE_URL!,
        encryptionSecret: "a-different-master-secret-32-chars-min!!",
        appEnv: "test",
      }),
      /could not decrypt signing key/
    );

    // Corrupt the active row's ciphertext in place (same shape, bad bytes).
    await adminClient.query(
      `UPDATE signing_keys SET encrypted_private_jwk = 'v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA' WHERE status = 'active'`
    );
    await assert.rejects(
      DrizzleStore.create({
        connectionString: DATABASE_URL!,
        appEnv: "test",
      }),
      /could not decrypt signing key/
    );

    // Leave the test database usable: fresh bootstrap from empty tables.
    await truncateSigningKeys();
    const store = await openStore();
    assert.ok(store.getActiveSigningKey().keyId.startsWith("sm-ed25519-"));
    const rows = await signingKeyRows();
    assert.equal(rows.filter((r) => r.status === "active").length, 1);
  });
});
