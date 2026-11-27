/**
 * B-01 Track A — parallelize independent per-request queries (LV-03 follow-up).
 *
 * Premise check (proven by the pg_sleep test below, not assumed): a
 * single pg Client executes queries strictly in call order, so a
 * Promise.all fan-out over ONE store's client saves ZERO round trips
 * (603ms vs 608ms sequential for 2x pg_sleep(0.3); two clients take
 * 302ms). The RTT win on one leased connection therefore comes only
 * from SINGLE-STATEMENT merging, never from Promise.all:
 *
 *  1. findLicenseForValidation takes BOTH candidate hashes (v2 then
 *     v1) in ONE statement (`= ANY($1)` + `array_position` preference)
 *     instead of a sequential v2-then-v1 loop: invalid-key and legacy
 *     v1 validations drop from 2 lookup RTTs to 1.
 *  2. The signing-key fingerprint rides INSIDE that same lookup
 *     statement (a CTE column), and createTargeted(loadSigningKey)
 *     DEFERS key resolution until the service calls
 *     ensureSigningKeys(fingerprint) just before signing — so the
 *     warm validate path pays no separate fingerprint RTT at store
 *     creation. Cache validation still happens before any signing
 *     (same M-16 invariant); a mismatch/cold cache still runs the
 *     full advisory-locked reload, at signing time.
 *  3. NOT merged (with evidence): the heartbeat UPDATE cannot join
 *     the lookup statement — installation_id_hash is
 *     sha256(license_id || ':' || installation_id), the license id
 *     is only known from the lookup, and Postgres has no sha256
 *     without pgcrypto (not installed: `digest()` errors locally).
 *     It stays one awaited UPDATE. The rate-limit upsert cannot
 *     merge either: it lives in middleware/rate-limit.ts, outside
 *     this track's files, and merging it into the handler statement
 *     without a middleware opt-out would double-count every bucket.
 *
 * Warm per-request query counts through the real Hono entrypoint
 * (per-request createTargeted store + rate-limit middleware):
 *   v2 validate: 4 -> 3 (fingerprint now rides the lookup)
 *   v1 validate: 5 -> 3 (dual-hash lookup + deferred fingerprint)
 *   invalid key: 4 -> 2 (no heartbeat, no key load at all)
 *   catalog list: 3 -> 3 (unchanged: rate 1 + site 1 + catalog 1;
 *     merging site+catalog belongs to the loadPublicCatalog track)
 *
 * Local wall times are logged (median of 5 warm runs) but NOT
 * asserted: local RTT is ~0.5ms, so the local delta is ~1-3ms and
 * flaky. The staging value is RTTs saved x ~250ms/RTT.
 *
 * Runs on its own fresh database (stackmate_test_b01par) via
 * setupTestDb; the shared stackmate_test database is never touched.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import {
  DATABASE_URL,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedLicense,
  seedSite,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { createHonoApp } from "../src/hono-app.ts";
import { createRequestStore } from "../src/index.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { validateLicenseInstallationTargeted } from "../src/modules/licensing/service.ts";
import {
  computeInstallationIdHash,
  computeLicenseKeyVerifier,
  computeLicenseKeyVerifierV2,
  generateFormattedLicenseKey,
} from "../src/platform/crypto/index.ts";
import type { AppEnv } from "../src/types/context.ts";

const INSTALLATION_ID = "b01par-installation-1";
const SEED_LAST_SEEN = new Date(Date.now() - 3_600_000).toISOString();

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Count pg statements while patched, classified by SQL shape. */
function countQueries() {
  let total = 0;
  let fingerprint = 0;
  let rateLimit = 0;
  let licenseLookup = 0;
  let heartbeat = 0;
  let other = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    total += 1;
    const sql = String(
      (args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? ""
    );
    // The standalone fingerprint SELECT starts with this text; the
    // lookup statement merely CONTAINS the same fragment inside its
    // fingerprint CTE, so match the statement start, not the fragment.
    if (sql.trimStart().startsWith("SELECT key_id, status, md5"))
      fingerprint += 1;
    else if (sql.includes("INTO rate_limit_buckets")) rateLimit += 1;
    else if (sql.includes("FROM licenses l")) licenseLookup += 1;
    else if (/^\s*UPDATE license_activations/i.test(sql)) heartbeat += 1;
    else other += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    counts: () => ({ total, fingerprint, rateLimit, licenseLookup, heartbeat, other }),
    restore: () => {
      Client.prototype.query = orig as never;
    },
  };
}

describe.skipIf(!DATABASE_URL)("B-01 Track A — parallelize (single-statement merges)", () => {
  let seedStore: DrizzleStore;
  let targeted: DrizzleStore;
  let adminClient: Client;
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  let app: ReturnType<typeof createHonoApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;

  let siteKey = "";
  let productCode = "";
  let rawKeyV2 = "";
  let rawKeyV1 = "";
  let rawKeyRevoked = "";
  let rawKeyExpired = "";
  let hashV2 = "";
  let hashV1 = "";
  let licenseNumberV2 = "";
  let activationIdV2 = "";
  let activationIdV1 = "";
  let activationIdRevoked = "";
  let activationIdExpired = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      env
    );
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  /**
   * POST validate with per-request query counts + wall time.
   * An uncounted warm-up request runs first (same body): the M-16
   * signing-key cache TTL is 60s from its last reload, so a reload
   * that falls due mid-file must land in the warm-up, not in the
   * counted request — otherwise the count assertion flakes at the
   * TTL boundary. The rotation test passes warmUp=false, because
   * there the reload IS the thing being measured.
   */
  async function countedValidate(body: unknown, warmUp = true) {
    if (warmUp) {
      await apiRequest("/api/v1/licenses/validate", {
        method: "POST",
        body,
      });
    }
    const counter = countQueries();
    const t0 = performance.now();
    let res: Awaited<ReturnType<typeof apiRequest>>;
    try {
      res = await apiRequest("/api/v1/licenses/validate", {
        method: "POST",
        body,
      });
    } finally {
      counter.restore();
    }
    return { res, ms: performance.now() - t0, ...counter.counts() };
  }

  async function lastSeen(activationId: string): Promise<number> {
    const row = await adminClient.query(
      `SELECT last_seen_at FROM license_activations WHERE id = $1`,
      [activationId]
    );
    return new Date(String(row.rows[0].last_seen_at)).getTime();
  }

  beforeAll(async () => {
    const setup = await setupTestDb("stackmate_test_b01par");
    seedStore = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = "/stackmate_test_b01par";
    dbUrl = url.toString();
    env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
    });

    await seedStore.withTransaction((state) => {
      const customer = seedCustomer(state, { email: "b01par@example.com" });
      const product = seedProduct(state, {
        code: "B01PAR",
        slug: "b01par-product",
        name: "B01PAR Product",
        status: "active",
      });
      productCode = product.code;
      const site = seedSite(state);
      site.product_ids = [product.id];
      siteKey = site.site_key;

      const mkLicense = (
        rawKey: string,
        hash: string,
        overrides: Record<string, unknown> = {}
      ) => {
        const lic = seedLicense(state, {
          product_id: product.id,
          customer_id: customer.id,
          license_key_hash: hash,
          ...overrides,
        });
        const activationId = randomUUID();
        lic.activations.push({
          id: activationId,
          license_id: lic.id,
          installation_id_hash: computeInstallationIdHash(lic.id, INSTALLATION_ID),
          domain_normalized: null,
          environment: "production",
          status: "active",
          activated_at: SEED_LAST_SEEN,
          last_seen_at: SEED_LAST_SEEN,
          deactivated_at: null,
          metadata: {},
          created_at: SEED_LAST_SEEN,
        });
        return { lic, activationId };
      };

      const v2 = generateFormattedLicenseKey(product.code);
      rawKeyV2 = v2.rawKey;
      hashV2 = computeLicenseKeyVerifierV2(rawKeyV2, env.LICENSE_VERIFIER_SECRET);
      const l2 = mkLicense(rawKeyV2, hashV2);
      licenseNumberV2 = l2.lic.license_number;
      activationIdV2 = l2.activationId;

      const v1 = generateFormattedLicenseKey(product.code);
      rawKeyV1 = v1.rawKey;
      hashV1 = computeLicenseKeyVerifier(rawKeyV1, env.LICENSE_VERIFIER_SECRET);
      const l1 = mkLicense(rawKeyV1, hashV1);
      activationIdV1 = l1.activationId;

      const revoked = generateFormattedLicenseKey(product.code);
      rawKeyRevoked = revoked.rawKey;
      const lr = mkLicense(
        revoked.rawKey,
        computeLicenseKeyVerifierV2(revoked.rawKey, env.LICENSE_VERIFIER_SECRET),
        { status: "revoked" }
      );
      activationIdRevoked = lr.activationId;

      const expired = generateFormattedLicenseKey(product.code);
      rawKeyExpired = expired.rawKey;
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const le = mkLicense(
        expired.rawKey,
        computeLicenseKeyVerifierV2(expired.rawKey, env.LICENSE_VERIFIER_SECRET),
        { expires_at: past, grace_until: past }
      );
      activationIdExpired = le.activationId;
    });

    // Store for direct store-level tests (signing keys loaded — the
    // deferred path resolves them on first ensureSigningKeys call).
    targeted = await DrizzleStore.createTargeted({
      connectionString: dbUrl,
      loadSigningKey: true,
    });

    // Full Hono app with the PRODUCTION store factory (per-request
    // createTargeted + rate-limit middleware), so the counts below
    // are the real per-request chain, not a shared-store shortcut.
    app = createHonoApp({
      env,
      storeFactory: async (factoryEnv, _ctx, factoryOpts) =>
        createRequestStore(factoryEnv, factoryOpts?.path),
    });

    // Warm-up: populate the capabilities/table/signing-key caches and
    // the connection lease, so measured requests are warm-isolate.
    await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: rawKeyV2,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      },
    });
    await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
      headers: { "X-StackMate-Site-Key": siteKey },
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await targeted.close();
    } catch {}
    await cleanup?.();
  });

  it("mechanism: Promise.all on ONE pg Client does NOT parallelize (pg_sleep proof)", async () => {
    const probe = new Client({ connectionString: dbUrl });
    await probe.connect();
    try {
      const timed = async (fn: () => Promise<unknown>) => {
        const t0 = performance.now();
        await fn();
        return performance.now() - t0;
      };
      const sequential = await timed(async () => {
        await probe.query("SELECT pg_sleep(0.25)");
        await probe.query("SELECT pg_sleep(0.25)");
      });
      const all = await timed(async () => {
        await Promise.all([
          probe.query("SELECT pg_sleep(0.25)"),
          probe.query("SELECT pg_sleep(0.25)"),
        ]);
      });
      const other = new Client({ connectionString: dbUrl });
      await other.connect();
      let twoClient: number;
      try {
        twoClient = await timed(async () => {
          await Promise.all([
            probe.query("SELECT pg_sleep(0.25)"),
            other.query("SELECT pg_sleep(0.25)"),
          ]);
        });
      } finally {
        await other.end();
      }
      console.log(
        `[b01-parallelize] pg_sleep(0.25)x2 — sequential ${sequential.toFixed(0)}ms, ` +
          `Promise.all 1 client ${all.toFixed(0)}ms, Promise.all 2 clients ${twoClient.toFixed(0)}ms`
      );
      // One client: Promise.all is ~sequential (no parallelism).
      assert.ok(all >= sequential * 0.8, `1-client Promise.all ${all}ms should be ~sequential ${sequential}ms`);
      // Two clients: Promise.all is ~half (real parallelism).
      assert.ok(twoClient <= sequential * 0.75, `2-client Promise.all ${twoClient}ms should be ~half of sequential ${sequential}ms`);
    } finally {
      await probe.end();
    }
  });

  it("findLicenseForValidation([v2, v1]): ONE statement, v2 preferred", async () => {
    const counter = countQueries();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      found = await targeted.findLicenseForValidation([hashV2, hashV1]);
    } finally {
      const n = counter.counts();
      counter.restore();
      assert.equal(n.total, 1, `dual-hash lookup took ${n.total} queries, want 1`);
      assert.equal(n.licenseLookup, 1);
    }
    assert.ok(found);
    assert.equal(found.license.license_number, licenseNumberV2);
    assert.equal(found.productCode, "B01PAR");
  });

  it("findLicenseForValidation: v1-only hash still resolves in ONE statement", async () => {
    const counter = countQueries();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      found = await targeted.findLicenseForValidation([hashV1]);
    } finally {
      const n = counter.counts();
      counter.restore();
      assert.equal(n.total, 1, `v1 lookup took ${n.total} queries, want 1`);
    }
    assert.ok(found);
    assert.notEqual(found.license.license_number, licenseNumberV2);
  });

  it("findLicenseForValidation: unknown hashes → null, ONE statement", async () => {
    const counter = countQueries();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      found = await targeted.findLicenseForValidation([
        "0".repeat(64),
        "1".repeat(64),
      ]);
    } finally {
      const n = counter.counts();
      counter.restore();
      assert.equal(n.total, 1, `unknown-hash lookup took ${n.total} queries, want 1`);
    }
    assert.equal(found, null);
  });

  it("findLicenseForValidation: single-string call stays ONE statement (back-compat)", async () => {
    const counter = countQueries();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      found = await targeted.findLicenseForValidation(hashV2);
    } finally {
      const n = counter.counts();
      counter.restore();
      assert.equal(n.total, 1, `single-hash lookup took ${n.total} queries, want 1`);
    }
    assert.ok(found);
    assert.equal(found.license.license_number, licenseNumberV2);
  });

  it("fingerprint rides the lookup: includeSigningKeyFingerprint returns the M-16 fingerprint, still ONE statement", async () => {
    const counter = countQueries();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      found = await targeted.findLicenseForValidation([hashV2], {
        includeSigningKeyFingerprint: true,
      });
    } finally {
      const n = counter.counts();
      counter.restore();
      assert.equal(n.total, 1, `lookup+fingerprint took ${n.total} queries, want 1`);
      assert.equal(n.fingerprint, 0, "fingerprint must ride the lookup, not run standalone");
    }
    assert.ok(found);
    const fp = (found as { signingKeyFingerprint?: string | null }).signingKeyFingerprint;
    assert.equal(typeof fp, "string");
    assert.ok((fp as string).length > 0, "fingerprint must be non-empty");
    // Independent check: the SQL-computed fingerprint must be
    // byte-identical to the M-16 format (key_id:status:md5(ct) joined
    // by '|', key_id order) computed here from the raw rows — a
    // mismatch would silently trust stale keys or reload every time.
    const keyRows = await adminClient.query(
      `SELECT key_id, status, encrypted_private_jwk FROM signing_keys WHERE status <> 'revoked' ORDER BY key_id ASC`
    );
    const expected = keyRows.rows
      .map(
        (r: any) =>
          `${String(r.key_id)}:${String(r.status)}:${createHash("md5")
            .update(String(r.encrypted_private_jwk ?? ""), "utf8")
            .digest("hex")}`
      )
      .join("|");
    assert.equal(fp, expected, "SQL fingerprint must equal the M-16 TS fingerprint");
  });

  it("HTTP v2 validate: 200, 3 queries (rate 1 + lookup 1 + heartbeat 1), heartbeat persisted", async () => {
    const before = await lastSeen(activationIdV2);
    const runs: number[] = [];
    let last: Awaited<ReturnType<typeof countedValidate>> | null = null;
    for (let i = 0; i < 5; i++) {
      last = await countedValidate({
        license_key: rawKeyV2,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      });
      runs.push(last.ms);
      assert.equal(last.res.status, 200, JSON.stringify(last.res.body));
      assert.equal(last.total, 3, `v2 validate took ${last.total} queries ${JSON.stringify(last)}`);
      assert.equal(last.fingerprint, 0, "no standalone fingerprint query on warm path");
      assert.equal(last.rateLimit, 1);
      assert.equal(last.licenseLookup, 1);
      assert.equal(last.heartbeat, 1);
    }
    console.log(`[b01-parallelize] HTTP v2 validate warm median ${median(runs).toFixed(1)}ms over 5 runs (local; staging value is RTTs saved)`);
    assert.equal(last!.res.body.data.valid, true);
    assert.equal(last!.res.body.data.license_number, licenseNumberV2);
    assert.ok((await lastSeen(activationIdV2)) > before, "heartbeat must move last_seen_at");
  });

  it("HTTP v1 validate: 200, 3 queries (dual-hash lookup, no second lookup RTT)", async () => {
    const before = await lastSeen(activationIdV1);
    const { res, total, fingerprint, rateLimit, licenseLookup, heartbeat } =
      await countedValidate({
        license_key: rawKeyV1,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.valid, true);
    assert.equal(total, 3, `v1 validate took ${total} queries`);
    assert.equal(fingerprint, 0);
    assert.equal(rateLimit, 1);
    assert.equal(licenseLookup, 1);
    assert.equal(heartbeat, 1);
    assert.ok((await lastSeen(activationIdV1)) > before, "heartbeat must move last_seen_at");
  });

  it("HTTP unknown key: 401 LICENSE_INVALID, 2 queries (rate 1 + lookup 1; no heartbeat, no key load)", async () => {
    const unknown = generateFormattedLicenseKey(productCode).rawKey;
    const { res, total, fingerprint, rateLimit, licenseLookup, heartbeat } =
      await countedValidate({
        license_key: unknown,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "LICENSE_INVALID");
    assert.equal(total, 2, `unknown-key validate took ${total} queries`);
    assert.equal(fingerprint, 0);
    assert.equal(rateLimit, 1);
    assert.equal(licenseLookup, 1);
    assert.equal(heartbeat, 0);
  });

  it("HTTP revoked / expired: same error codes as before, heartbeat must NOT move", async () => {
    const revokedBefore = await lastSeen(activationIdRevoked);
    const expiredBefore = await lastSeen(activationIdExpired);
    const revokedRes = await countedValidate({
      license_key: rawKeyRevoked,
      product_code: productCode,
      installation_id: INSTALLATION_ID,
    });
    assert.equal(revokedRes.res.status, 403, JSON.stringify(revokedRes.res.body));
    assert.equal(revokedRes.res.body.error.code, "LICENSE_REVOKED");
    assert.equal(revokedRes.heartbeat, 0, "revoked license must not heartbeat");

    const expiredRes = await countedValidate({
      license_key: rawKeyExpired,
      product_code: productCode,
      installation_id: INSTALLATION_ID,
    });
    assert.equal(expiredRes.res.status, 403, JSON.stringify(expiredRes.res.body));
    assert.equal(expiredRes.res.body.error.code, "LICENSE_EXPIRED");
    assert.equal(expiredRes.heartbeat, 0, "expired license must not heartbeat");
    assert.equal(await lastSeen(activationIdRevoked), revokedBefore);
    assert.equal(await lastSeen(activationIdExpired), expiredBefore);
  });

  it("HTTP wrong product / unknown installation: same 403 codes, heartbeat must NOT move", async () => {
    const before = await lastSeen(activationIdV2);
    const wrongProduct = await countedValidate({
      license_key: rawKeyV2,
      product_code: "NOPE",
      installation_id: INSTALLATION_ID,
    });
    assert.equal(wrongProduct.res.status, 403, JSON.stringify(wrongProduct.res.body));
    assert.equal(wrongProduct.res.body.error.code, "PRODUCT_MISMATCH");
    assert.equal(wrongProduct.heartbeat, 0, "wrong product must not heartbeat");

    const noInstall = await countedValidate({
      license_key: rawKeyV2,
      product_code: productCode,
      installation_id: "b01par-never-activated",
    });
    assert.equal(noInstall.res.status, 403, JSON.stringify(noInstall.res.body));
    assert.equal(noInstall.res.body.error.code, "INSTALLATION_NOT_ACTIVE");
    assert.equal(noInstall.heartbeat, 0, "unknown installation must not heartbeat");
    assert.equal(await lastSeen(activationIdV2), before, "last_seen_at must not move on failed validations");
  });

  it("HTTP catalog list: 3 queries (rate 1 + site 1 + catalog 1) — chain mapped, unchanged by this track", async () => {
    const counter = countQueries();
    let res: Awaited<ReturnType<typeof apiRequest>>;
    const t0 = performance.now();
    try {
      res = await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
        headers: { "X-StackMate-Site-Key": siteKey },
      });
    } finally {
      counter.restore();
    }
    const ms = performance.now() - t0;
    const n = counter.counts();
    console.log(`[b01-parallelize] HTTP catalog list ${n.total} queries, ${ms.toFixed(1)}ms (local)`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(n.total, 3, `catalog list took ${n.total} queries ${JSON.stringify(n)}`);
    assert.equal(n.rateLimit, 1);
  });

  it("in-memory store: targeted validate returns identical results (no Drizzle-only behaviour)", async () => {
    const mem = new StackMateDataStore();
    let memLicenseNumber = "";
    await mem.withTransaction((state) => {
      const customer = seedCustomer(state, { email: "b01par-mem@example.com" });
      const product = seedProduct(state, {
        code: "B01PAR",
        slug: "b01par-product",
        name: "B01PAR Product",
        status: "active",
      });
      const lic = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        license_key_hash: hashV2,
      });
      memLicenseNumber = lic.license_number;
      lic.activations.push({
        id: randomUUID(),
        license_id: lic.id,
        installation_id_hash: computeInstallationIdHash(lic.id, INSTALLATION_ID),
        domain_normalized: null,
        environment: "production",
        status: "active",
        activated_at: SEED_LAST_SEEN,
        last_seen_at: SEED_LAST_SEEN,
        deactivated_at: null,
        metadata: {},
        created_at: SEED_LAST_SEEN,
      });
    });
    const ok = await validateLicenseInstallationTargeted(mem, {
      license_key: rawKeyV2,
      product_code: productCode,
      installation_id: INSTALLATION_ID,
    }, { verifierSecret: env.LICENSE_VERIFIER_SECRET, issuerUrl: env.API_URL });
    assert.equal(ok.valid, true);
    assert.equal(ok.license_number, memLicenseNumber);
    await assert.rejects(
      validateLicenseInstallationTargeted(mem, {
        license_key: generateFormattedLicenseKey(productCode).rawKey,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      }, { verifierSecret: env.LICENSE_VERIFIER_SECRET, issuerUrl: env.API_URL }),
      (e: any) => e.code === "LICENSE_INVALID"
    );
  });

  it("deferred signing keys: key rotation between requests still validates (fingerprint mismatch → reload)", async () => {
    // Rotate by retiring the active key and minting a fresh one through
    // the store API (same path production rotation uses), then validate.
    const before = await countedValidate({
      license_key: rawKeyV2,
      product_code: productCode,
      installation_id: INSTALLATION_ID,
    });
    assert.equal(before.res.status, 200, JSON.stringify(before.res.body));
    // Rotate through a full store (rotateSigningKey requires the
    // durable key load, which a deferred targeted store has not run).
    // Rotation clears the module signing-key cache, so the next
    // validate must take the reload path (more queries) and still
    // return 200 with a token signed by the NEW key.
    const rotator = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      await rotator.rotateSigningKey();
    } finally {
      await rotator.close();
    }
    const after = await countedValidate(
      {
        license_key: rawKeyV2,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      },
      false
    );
    assert.equal(after.res.status, 200, JSON.stringify(after.res.body));
    assert.equal(after.res.body.data.valid, true);
    assert.ok(after.res.body.data.entitlement_token.length > 0);
    console.log(`[b01-parallelize] post-rotation validate took ${after.total} queries (reload path, expected > 3)`);
    assert.ok(after.total > 3, `post-rotation validate should pay the key reload, took ${after.total}`);
  });
});
