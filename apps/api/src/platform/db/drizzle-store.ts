/**
 * DrizzleStore — PostgreSQL-backed StackMateDataStore.
 *
 * Same public surface as the in-memory StackMateDataStore (see
 * ./store.ts) so no service changes: services keep mutating
 * `store.state` inside `withTransaction(fn)`, and this class persists the
 * diff back to PostgreSQL in the SAME transaction (BEGIN → reload →
 * fn(state) → diff-persist → COMMIT, ROLLBACK + in-memory restore on any
 * error). Idempotency + outbox writes flow through the same fn(state) path,
 * so they are covered by the same transaction.
 *
 * READ THIS FIRST — the five things that will surprise you:
 *
 * 1. ONE pg Client per store, REQUEST-SCOPED — one fresh client per
 *    create(), owned by that store and ended by close(). The store
 *    holds a single `pg` Client (per the Hyperdrive design: one pinned
 *    connection). The Worker entrypoint creates one store per request
 *    and closes it when the request finishes (see
 *    apps/api/src/app.ts closeRequestStore), so a client never outlives
 *    its request and nothing is shared across requests.
 *    REVERT 2026-11-15 (evening): the Batch 0 perf fix shared ONE
 *    client per Worker isolate (module-level singleton) and serialized
 *    all statements through a per-client promise queue
 *    (`clientQueues`). That poisoned warm isolates: a queue promise
 *    created in request A and awaited in request B throws under
 *    Cloudflare's handle_cross_request_promise_resolution flag ("This
 *    promise was created by a request that has since ended…"), and
 *    staging went from ~10% failures to 12/12 store-dependent calls
 *    failing with it (live Worker logs, 2026-11-15 22:11–22:15 +06).
 *    The singleton + queue are deleted; this is the ADR-0005
 *    pre-recorded revert path. The combined single-statement load and
 *    the caps/tables cache are KEPT (the cache now holds resolved
 *    plain values keyed by connection string — never a promise — see
 *    below). Cost: ~2 extra RTTs/request vs the singleton (caps +
 *    tables re-checked only on a cold cache); predicted ~1.75s/request
 *    on staging at ~250ms RTT.
 *    B-01 REUSE (2026-11-27): the revert above is kept — but the
 *    TCP connection itself is now reused across requests through
 *    `platform/db/connection-cache.ts`: ONE idle client per
 *    connection string, claimed by a synchronous boolean lease
 *    (busy → fresh client, exactly as before). The cache holds NO
 *    promise at module scope — only the Client object + booleans —
 *    so the cross-request-promise failure cannot recur: every query
 *    promise is created and awaited inside the one request holding
 *    the lease. The store itself stays per-request; only the
 *    connection is shared. See connection-cache.ts for the full
 *    safety argument (lease, dead detection, one leased retry).
 *    `SELECT pg_advisory_xact_lock(727271)` serializes writers across
 *    SEPARATE store instances / processes hitting the same database
 *    (mirrors the in-memory mutex semantics). Within ONE store
 *    instance, concurrent operations are serialized by an
 *    instance-level lock (`acquireStoreLock`) — the advisory lock
 *    cannot do that job, because two transactions on the SAME client
 *    share one session and the lock never blocks itself (a payment
 *    verification race run on one shared store would let both sides
 *    see pre-race state and both fail). The lock chain lives on the
 *    instance, NOT at module scope: in the Worker path the instance
 *    is created and closed within ONE request, so the chain can never
 *    span requests and the Cloudflare cross-request promise flag
 *    cannot fire on it — unlike the deleted module-level
 *    `clientQueues`. Nested withTransaction calls deadlock exactly
 *    like the base class — don't.
 *    `drizzleDb` shares this store's client, so Better Auth queries
 *    run on the request's own client: no cross-request contamination
 *    is possible, and within a request BA queries execute sequentially
 *    with store operations (a BA query landing inside this request's
 *    open transaction sees that transaction's snapshot, and a BA
 *    session insert rolled back by a concurrent rollback is lost and
 *    the user signs in again; no business data can corrupt this way
 *    because BA never writes business tables and never runs inside a
 *    store transaction).
 *
 * 2. Full-state load + diff-persist, raw SQL. Every withTransaction
 *    reloads ALL mapped tables into `this.state` and then diffs the
 *    before/after snapshots (insert new rows, update changed rows by id,
 *    delete removed rows, including child rows). The diff is written with
 *    parameterized raw SQL on the transaction's client — NOT the Drizzle
 *    query builder — because the state model is a hand-rolled aggregate
 *    diff and raw SQL gives exact column control (the store model has
 *    columns the Drizzle schema does not, and vice versa). `drizzleDb`
 *    is still built (from the same client + the full Drizzle schema) and
 *    exposed for Better Auth wiring; it is not used for state persistence.
 *
 * 3. Migration 0002 is REQUIRED for full fidelity, OPTIONAL for boot.
 *    The store detects which migration-0002 objects exist
 *    (sequence_counters table + added columns) and degrades gracefully
 *    when they are absent, so the store boots on a database with only
 *    migrations 0000/0001 applied: 0002-only fields load as documented
 *    defaults and are skipped on persist, and counters are derived from
 *    the highest existing numbers in the data (kept in memory only).
 *    That is a compatibility shim, not a supported configuration:
 *    without 0002, staff passwords don't survive a restart, license
 *    issuance fails closed (see below), and idempotency replay of bodies
 *    larger than 160 chars throws a clear "apply migration 0002" error.
 *    Apply db/migrations/0002_sequence_counters.sql in production.
 *
 * 4. Signing keys ARE durably persisted (Fix 1, migration 0004). The
 *    signing_keys table is the source of truth: one row per key version,
 *    private JWK encrypted with AES-256-GCM under ENCRYPTION_KEY_V1 and
 *    bound to AAD "signing_key:<key_id>" (see signingKeyAadContext),
 *    public JWK stored in clear. Exactly one row is 'active' (partial
 *    unique index); retired keys stay verifiable, revoked keys are never
 *    loaded and their tokens stop verifying. Boot: load the active row
 *    (+ every retired row) from the DB; if no active row exists, import
 *    the LICENSE_SIGNING_PRIVATE_JWK env/option JWK once (bootstrap-only)
 *    or generate ONE key and persist it immediately — inside one
 *    advisory-locked transaction, so concurrent boots converge on a
 *    single active row. The constructor's per-process key is discarded
 *    here, and getActiveSigningKey() refuses to serve until the durable
 *    load succeeds. signing_key_metadata (migration 0000) is kept as a
 *    public metadata mirror, synced in the same transaction on
 *    bootstrap / rotation / revocation; it never holds private material.
 *    ENCRYPTION_KEY_V1 comes from the `encryptionSecret` create() option
 *    (preferred) or process.env (local dev only — Workers do not populate
 *    process.env); with no secret the store fails closed unless the
 *    runtime is positively local/test (APP_ENV local|test, NODE_ENV test,
 *    or vitest), where the env.ts dev fallback applies. If a stored key
 *    cannot be decrypted (wrong or lost master secret), boot fails
 *    closed: rotation to a fresh key is the only recovery and old tokens
 *    become unverifiable — see
 *    docs/operations/KEY-ROTATION-AND-SECURITY-RUNBOOK.md.
 *    apps/api/src/index.ts forwards encryptionSecret (env.ENCRYPTION_KEY_V1)
 *    and appEnv (env.APP_ENV) from the resolved Worker env, so a deployed
 *    Worker decrypts with the real secret; the local/test dev fallback
 *    applies only when no secret is supplied at all (see resolveEncryptionSecret).
 *
 * 5. R2 bucket is fail-visible, not fail-closed, at this layer. If
 *    create() is called without `r2Bucket`, the inherited in-memory
 *    bucket stays in place and `usesInMemoryBucket` is set to true.
 *    Production wiring MUST pass env.R2_BUCKET and MUST check
 *    `usesInMemoryBucket` (or call `requireRealBucket()`, which throws)
 *    before serving uploads — this class cannot fail the upload path
 *    closed by itself because uploadPrivatePaymentEvidence reads
 *    `store.r2Bucket` directly. Evidence uploaded to the in-memory
 *    bucket is lost on restart and invisible to every other instance.
 *
 * Other mapping notes (full per-collection decisions in the report):
 * - Roles carry permission_keys via the role_permissions + permissions
 *   join; payment providers / currencies / permissions come from the
 *   migration-0001 seed rows (never auto-seeded here). Empty roles,
 *   payment_providers or currencies tables throw on load (0001 missing).
 * - Users.status lives in staff_profiles (upserted on persist);
 *   users.password_hash is a migration-0002 column (Better Auth keeps its
 *   own password in `accounts`; the two stores are NOT reconciled).
 * - licenses.integration_profile_id is nullable since migration 0002
 *   (the service model never supplies one); on a 0000-only database a
 *   license insert throws a clear "apply migration 0002" error instead
 *   of a cryptic NOT NULL violation.
 * - Immutable tables (order/license entitlement snapshots + their items,
 *   payment_verification_logs, audit_logs) have BEFORE UPDATE/DELETE
 *   triggers in migration 0000: the differ only ever INSERTs into them
 *   and throws a clear error if a service ever mutates/removes a row.
 * - Timestamps are ISO strings in state; timestamptz columns arrive from
 *   node-postgres as Date and are converted with toISOString() (UTC).
 *   payment_date is a date-only YYYY-MM-DD string, never a timestamp.
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@stackmate/db/schema";
import type { R2BucketBinding } from "../../env.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  exportPrivateJwkJson,
  generateEd25519KeyMaterial,
  type Ed25519KeyMaterial,
} from "../crypto/index.ts";
import { AppError } from "../../shared/errors.ts";
import {
  discardCachedClient,
  isConnectionError,
  parkCachedClient,
  releaseCachedClient,
  tryAcquireCachedClient,
} from "./connection-cache.ts";
import {
  StackMateDataStore,
  type AuditLogRecord,
  type CustomerAddressRecord,
  type CustomerContactRecord,
  type CustomerRecord,
  type CustomerReportRecord,
  type DatabaseState,
  type ExpenseCategoryRecord,
  type ExpenseRecord,
  type IdempotencyRecord,
  type IntegratedSiteRecord,
  type InvoiceRecord,
  type LeadRecord,
  type LicenseActivationRecord,
  type LicenseEntitlementSnapshotRecord,
  type LicenseEventRecord,
  type LicenseRecord,
  type MediaAssetRecord,
  type OrderInstallmentRecord,
  type OrderItemRecord,
  type OrderItemSnapshotRecord,
  type OrderRecord,
  type OutboxEventRecord,
  type PackagePriceRecord,
  type PackageVersionFeatureGrant,
  type PackageVersionRecord,
  type PaymentMethodRecord,
  type PaymentProviderRecord,
  type PaymentSubmissionRecord,
  type PaymentRefundRecord,
  type PaymentTransactionRecord,
  type PaymentVerificationLogRecord,
  type ProductFeatureRecord,
  type ProductPackageRecord,
  type ProductRecord,
  type ReminderSettingsRecord,
  type RoleRecord,
  type SentReminderRecord,
  type SessionRecord,
  type SiteCredentialRecord,
  type StaffInvitationRecord,
  type SubscriptionPeriodRecord,
  type SubscriptionRecord,
  type SupportTicketRecord,
  type TicketCommentRecord,
  type TrackingConfigRecord,
  type TrackingEventRecord,
  type TwoFactorPolicyRecord,
  type UploadedAssetRecord,
  type UserRecord,
  type WebhookEndpointRecord,
  type LoadPublicCatalogOptions,
} from "./store.ts";

export const DEFAULT_SIGNING_KEY_ID = "sm-ed25519-2026-11";

/**
 * AAD context for a signing key's encrypted private JWK. The context is a
 * FIXED string per key id — `signing_key:<key_id>` — so a ciphertext
 * copied to a different key row (or a different purpose) cannot decrypt:
 * encryptSecretAtRest/decryptSecretAtRest build the real GCM AAD as
 * `v1:<aadContext>`, i.e. `v1:signing_key:<key_id>` here. The key id is
 * part of the AAD rather than the plaintext, so re-keying a row under a
 * new id requires re-encryption, not a silent copy.
 */
export function signingKeyAadContext(keyId: string): string {
  return `signing_key:${keyId}`;
}

/**
 * Dev-only fallback master secret for envelope encryption, byte-identical
 * to the local-dev default in env.ts (resolveRuntimeConfig). It is NOT a
 * real secret: DrizzleStore uses it only when the runtime is positively
 * local/test and no ENCRYPTION_KEY_V1 was supplied (see
 * resolveEncryptionSecret). Any other runtime without a secret fails
 * closed instead of silently encrypting production keys with a public
 * default.
 */
const DEV_FALLBACK_ENCRYPTION_SECRET =
  "local-dev-aes-256-gcm-master-key-32-bytes-seed!!";

/** Fresh bootstrap/rotation key id for the current month, e.g. sm-ed25519-2026-11. */
function deriveMonthlySigningKeyId(now = new Date()): string {
  return `sm-ed25519-${now.toISOString().slice(0, 7)}`;
}

/** Advisory lock key serializing writers across store instances/processes. */
const WRITER_ADVISORY_LOCK_KEY = 727271;

/** In-memory base values for sequence counters (must match store.ts). */
const COUNTER_BASE_VALUES: DatabaseState["sequence_counters"] = {
  customer: 1000,
  order: 10000,
  invoice: 20000,
  subscription: 30000,
  license: 40000,
  ticket: 50000,
  lead: 60000,
};

export interface DrizzleStoreCreateOptions {
  connectionString: string;
  r2Bucket?: R2BucketBinding | null | undefined;
  signingKeyId?: string | undefined;
  /**
   * Ed25519 private key as a JWK JSON string. Prefer passing this from the
   * wiring layer (env.LICENSE_SIGNING_PRIVATE_JWK); if omitted, create()
   * falls back to process.env.LICENSE_SIGNING_PRIVATE_JWK (local dev only
   * — Workers do not populate process.env with bindings).
   */
  signingPrivateJwk?: string | undefined;
  signingPublicJwk?: string | undefined;
  /**
   * Master secret for AES-256-GCM envelope encryption of private signing
   * keys (ENCRYPTION_KEY_V1). Prefer passing this from the wiring layer
   * (env.ENCRYPTION_KEY_V1); if omitted, create() falls back to
   * process.env.ENCRYPTION_KEY_V1 (local dev only — Workers do not
   * populate process.env with bindings) and then, only on a positively
   * local/test runtime, to the dev fallback (see resolveEncryptionSecret).
   * apps/api/src/index.ts forwards encryptionSecret + appEnv from the
   * resolved Worker env, so a deployed Worker never relies on the fallback.
   */
  encryptionSecret?: string | undefined;
  /**
   * Runtime environment name. Used ONLY to decide whether a missing
   * encryption secret may fall back to the dev default; defaults to
   * process.env.APP_ENV when omitted.
   */
  appEnv?: "local" | "test" | "staging" | "production" | undefined;
}

/**
 * Import an Ed25519 private JWK into the Ed25519KeyMaterial shape the
 * licensing service signs with. crypto/index.ts has no JWK import helper,
 * so this lives here. Throws a clear error on malformed input — never
 * silently falls back to a generated key.
 */
export function importEd25519KeyMaterialFromPrivateJwk(
  privateJwkJson: string,
  keyId: string,
  publicJwkJson?: string
): Ed25519KeyMaterial {
  let privateJwk: Record<string, unknown>;
  try {
    privateJwk = JSON.parse(privateJwkJson) as Record<string, unknown>;
  } catch {
    throw new Error(
      "DrizzleStore: LICENSE_SIGNING_PRIVATE_JWK is not valid JSON."
    );
  }
  if (
    privateJwk["kty"] !== "OKP" ||
    privateJwk["crv"] !== "Ed25519" ||
    typeof privateJwk["d"] !== "string"
  ) {
    throw new Error(
      "DrizzleStore: LICENSE_SIGNING_PRIVATE_JWK must be an Ed25519 private JWK (kty OKP, crv Ed25519, with a 'd' member)."
    );
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: privateJwk as unknown as import("node:crypto").JsonWebKey,
      format: "jwk",
    });
  } catch (error) {
    throw new Error(
      `DrizzleStore: LICENSE_SIGNING_PRIVATE_JWK could not be imported as an Ed25519 key: ${(error as Error).message}`
    );
  }
  const publicKey = createPublicKey(privateKey);
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<
    string,
    unknown
  >;
  if (publicJwkJson !== undefined && publicJwkJson.trim().length > 0) {
    let provided: Record<string, unknown>;
    try {
      provided = JSON.parse(publicJwkJson) as Record<string, unknown>;
    } catch {
      throw new Error(
        "DrizzleStore: LICENSE_SIGNING_PUBLIC_JWK is not valid JSON."
      );
    }
    if (provided["x"] !== undefined && provided["x"] !== publicJwk["x"]) {
      throw new Error(
        "DrizzleStore: LICENSE_SIGNING_PUBLIC_JWK does not match LICENSE_SIGNING_PRIVATE_JWK (different 'x' coordinate)."
      );
    }
  }
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    publicKeyJwk: { ...publicJwk, kid: keyId, alg: "EdDSA", use: "sig" },
  };
}

// ---------------------------------------------------------------------------
// Row-mapping helpers (the ONLY place `as` casts are used in this file:
// at the node-postgres row boundary, where every value is `unknown`).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

async function queryRows(
  client: Client,
  text: string,
  values: unknown[] = []
): Promise<Row[]> {
  const result = await client.query(text, values);
  return result.rows as unknown as Row[];
}

async function execSql(
  client: Client,
  text: string,
  values: unknown[] = []
): Promise<void> {
  await client.query(text, values);
}

/**
 * OD-04: true when two Postgres connection strings name the same
 * database (URL pathname). The public route passes
 * env.HYPERDRIVE_CACHED, but the store may have been built against
 * a different database — tests build scratch databases while env
 * still points at the shared test database — and a cached read must
 * never cross databases. Both Hyperdrive bindings target the same
 * underlying database in a real deployment, so equal database names
 * is the right guard; anything unparseable (or an empty name) is
 * treated as "not the same database" and falls back to the
 * authoritative connection.
 */
function sameDatabaseName(a: string, b: string): boolean {
  try {
    const dbA = new URL(a).pathname.replace(/^\//, "");
    const dbB = new URL(b).pathname.replace(/^\//, "");
    return dbA.length > 0 && dbA === dbB;
  } catch {
    return false;
  }
}

function str(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" ? v : null;
}

function reqStr(row: Row, key: string, table: string): string {
  const v = str(row, key);
  if (v === null) {
    throw new Error(
      `DrizzleStore: ${table}.${key} is NULL but the store model requires a value (row id ${String(row["id"] ?? "?")}).`
    );
  }
  return v;
}

function num(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function reqNum(row: Row, key: string, table: string): number {
  const v = num(row, key);
  if (v === null) {
    throw new Error(
      `DrizzleStore: ${table}.${key} is NULL but the store model requires a value (row id ${String(row["id"] ?? "?")}).`
    );
  }
  return v;
}

function bool(row: Row, key: string): boolean {
  return row[key] === true;
}

function iso(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    // JSON-loaded rows carry timestamptz as an ISO string (microsecond
    // precision, +00:00 offset). Normalize to the Date→toISOString()
    // form the direct pg path produced (millisecond precision, Z) so
    // API timestamps are byte-identical after the combined load.
    // Unparseable strings pass through untouched.
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return v;
  }
  return null;
}

function reqIso(row: Row, key: string, table: string): string {
  const v = iso(row, key);
  if (v === null) {
    throw new Error(
      `DrizzleStore: ${table}.${key} is NULL but the store model requires a value (row id ${String(row["id"] ?? "?")}).`
    );
  }
  return v;
}

/** date column (node-postgres returns a Date) → YYYY-MM-DD. */
function dateOnly(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.slice(0, 10);
  return null;
}

function asJson<T>(row: Row, key: string): T | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function asJsonObject(row: Row, key: string): Record<string, unknown> {
  const v = asJson<Record<string, unknown>>(row, key);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function asJsonArray<T>(row: Row, key: string): T[] {
  const v = asJson<T[]>(row, key);
  return Array.isArray(v) ? v : [];
}

/** Coerce a DB text value into a string-union enum, falling back safely. */
function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function asEnumOrNull<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return null;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration-0002 capability detection
// ---------------------------------------------------------------------------

interface StoreCapabilities {
  sequenceCounters: boolean;
  usersPasswordHash: boolean;
  usersTwoFactorEnabled: boolean;
  usersAvatarUrl: boolean;
  authEmailTables: boolean;
  productsDefaults: boolean;
  packagesCurrentVersion: boolean;
  packageVersionFeaturesUnit: boolean;
  packagePricesUsedInOrders: boolean;
  paymentSubmissionsDuplicateWarning: boolean;
  subscriptionsUnitAmount: boolean;
  trackingEventsDelivery: boolean;
  idempotencyResponseBody: boolean;
  licensesIntegrationProfileNullable: boolean;
  signingKeys: boolean;
}

const NO_MIGRATION_0002: StoreCapabilities = {
  sequenceCounters: false,
  usersPasswordHash: false,
  usersTwoFactorEnabled: false,
  usersAvatarUrl: false,
  authEmailTables: false,
  productsDefaults: false,
  packagesCurrentVersion: false,
  packageVersionFeaturesUnit: false,
  packagePricesUsedInOrders: false,
  paymentSubmissionsDuplicateWarning: false,
  subscriptionsUnitAmount: false,
  trackingEventsDelivery: false,
  idempotencyResponseBody: false,
  licensesIntegrationProfileNullable: false,
  signingKeys: false,
};

/**
 * Tables that MUST exist (migrations 0000/0001; staff_invitations is
 * migration 0005). sequence_counters is deliberately excluded — it is
 * migration 0002 and handled as a capability.
 */
const REQUIRED_TABLES: readonly string[] = [
  "users",
  "sessions",
  "roles",
  "permissions",
  "user_roles",
  "staff_invitations",
  "role_permissions",
  "staff_profiles",
  "customers",
  "uploaded_assets",
  "media_assets",
  "currencies",
  "products",
  "product_distribution_channels",
  "product_features",
  "product_packages",
  "package_versions",
  "package_version_features",
  "package_prices",
  "integrated_sites",
  "site_domains",
  "site_products",
  "site_credentials",
  "request_nonces",
  "orders",
  "order_items",
  "order_item_entitlement_snapshots",
  "order_item_entitlement_snapshot_items",
  "order_attributions",
  "subscriptions",
  "subscription_periods",
  "invoices",
  "invoice_items",
  "payment_providers",
  "payment_methods",
  "payment_method_transfer_rails",
  "payment_refunds",
  "payment_submissions",
  "payment_transactions",
  "payment_verification_logs",
  "signing_key_metadata",
  "licenses",
  "license_entitlement_snapshots",
  "license_entitlement_snapshot_items",
  "license_activations",
  "tracking_configurations",
  "tracking_events",
  "webhook_endpoints",
  "webhook_endpoint_secrets",
  "webhook_deliveries",
  "outbox_events",
  "idempotency_records",
  "audit_logs",
  // Migration 0007 (auth + email): the store fails closed at boot when
  // these are missing — migrations deploy before code, so a store
  // booting without them means the deploy did not apply 0007.
  "two_factor",
  "auth_oauth_providers",
  "auth_two_factor_policy",
  "smtp_settings",
  "password_reset_tokens",
];

/**
 * Perf (2026-11-15) — schema facts cached as RESOLVED PLAIN VALUES,
 * keyed by connection string.
 *
 * Schema facts never change at runtime, so detectCapabilities and
 * assertRequiredTables are memoized (migrations deploy with code, so a
 * per-isolate invariant is safe). The cache holds ONLY resolved plain
 * values — NEVER a promise, and nothing here is ever awaited from
 * module scope: a promise created in one Worker request and awaited in
 * another throws under Cloudflare's
 * handle_cross_request_promise_resolution flag, which is exactly what
 * killed the per-isolate shared client (see header note 1). If two
 * requests populate the same key concurrently they just re-detect and
 * the last write wins (same value). A failed detection is never cached,
 * so a transient failure retries on the next request.
 *
 * Keyed by connection string, not by client: every store now owns a
 * fresh client per request, and the string identifies the database
 * (tests use one string per database, so no cross-database leakage).
 */
const capabilitiesByConnectionString = new Map<string, StoreCapabilities>();
const requiredTablesVerified = new Set<string>();

/**
 * M-16: per-isolate signing-key cache. resolveSigningKey's
 * advisory-locked transaction costs 5 round-trips (BEGIN + lock +
 * 2 SELECTs + COMMIT) on EVERY store creation — i.e. every request.
 * The keys are durable rows, so the decrypted material is cached per
 * (connection string, encryption secret, signing key id, env-JWK
 * hash) for 60s. FIXED 2026-11-20: a bare TTL cache masked table
 * mutations — a boot after a TRUNCATE returned stale keys, and a
 * corrupt row never failed closed (it broke signing-keys (e)/(f)
 * and poisoned the shared test DB when (f) minted a key under the
 * wrong secret into the empty table). The cache is therefore
 * validated on every hit against a one-query fingerprint (key ids +
 * statuses + ciphertext hashes); any change falls through to the
 * full reload, which decrypts and fails closed. Rotation/revocation
 * clear the whole cache; a rotation by ANOTHER isolate/process is
 * caught by the fingerprint on the next create (worst case the old
 * key signs until the next create — retired keys still verify, so
 * tokens stay valid). Bootstrap (no active row) never populates the
 * cache. The key is a hash, so no secret material lands in the
 * cache key itself.
 */
const SIGNING_KEY_CACHE_TTL_MS = 60_000;
type CachedSigningKeys = {
  keys: Map<string, Ed25519KeyMaterial>;
  activeKeyId: string;
  cachedAtMs: number;
  fingerprint: string;
};
const signingKeyCache = new Map<string, CachedSigningKeys>();

function signingKeyCacheKey(
  connectionString: string,
  secret: string,
  signingKeyId = "",
  signingPrivateJwkHash = "",
): string {
  return createHash("sha256")
    .update(connectionString)
    .update("\0")
    .update(secret)
    .update("\0")
    .update(signingKeyId)
    .update("\0")
    .update(signingPrivateJwkHash)
    .digest("hex");
}

/**
 * Fingerprint of the non-revoked signing_keys rows (key id + status +
 * md5 of the ciphertext), in key-id order. The cache-hit path
 * recomputes the same string in SQL (md5() over the same bytes), so
 * the two must stay in sync: any row added/removed/changed — or any
 * ciphertext byte changed — produces a different fingerprint.
 */
function fingerprintSigningKeyRows(rows: Array<Record<string, unknown>>): string {
  const sorted = [...rows].sort((a, b) =>
    String(a.key_id ?? "").localeCompare(String(b.key_id ?? "")),
  );
  return sorted
    .map(
      (r) =>
        `${String(r.key_id ?? "")}:${String(r.status ?? "")}:${createHash("md5").update(String(r.encrypted_private_jwk ?? ""), "utf8").digest("hex")}`,
    )
    .join("|");
}

async function detectCapabilitiesCached(
  connectionString: string,
  client: Client
): Promise<StoreCapabilities> {
  const hit = capabilitiesByConnectionString.get(connectionString);
  if (hit !== undefined) return hit;
  const caps = await detectCapabilities(client);
  capabilitiesByConnectionString.set(connectionString, caps);
  return caps;
}

async function assertRequiredTablesCached(
  connectionString: string,
  client: Client
): Promise<void> {
  if (requiredTablesVerified.has(connectionString)) return;
  await assertRequiredTables(client);
  requiredTablesVerified.add(connectionString);
}

async function detectCapabilities(client: Client): Promise<StoreCapabilities> {
  const rows = await queryRows(
    client,
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'sequence_counters')
          OR (table_name = 'users' AND column_name = 'password_hash')
          OR (table_name = 'users' AND column_name = 'two_factor_enabled')
          OR (table_name = 'users' AND column_name = 'avatar_url')
          OR (table_name IN ('two_factor', 'auth_oauth_providers', 'auth_two_factor_policy', 'smtp_settings', 'password_reset_tokens'))
          OR (table_name = 'products' AND column_name IN ('default_activation_limit', 'offline_grace_hours'))
          OR (table_name = 'product_packages' AND column_name = 'current_version_id')
          OR (table_name = 'package_version_features' AND column_name = 'unit_snapshot')
          OR (table_name = 'package_prices' AND column_name = 'used_in_orders')
          OR (table_name = 'payment_submissions' AND column_name = 'duplicate_risk_warning')
          OR (table_name = 'subscriptions' AND column_name = 'unit_amount_minor')
          OR (table_name = 'tracking_events' AND column_name IN ('delivery_attempts', 'delivered_at'))
          OR (table_name = 'idempotency_records' AND column_name = 'response_body')
          OR (table_name = 'licenses' AND column_name = 'integration_profile_id')
          OR (table_name = 'signing_keys'))`
  );
  const present = new Set(
    rows.map((r) => `${String(r["table_name"])}.${String(r["column_name"])}`)
  );
  const licensesRow = rows.find(
    (r) => r["table_name"] === "licenses" && r["column_name"] === "integration_profile_id"
  );
  return {
    sequenceCounters: present.has("sequence_counters.counter_key"),
    usersPasswordHash: present.has("users.password_hash"),
    usersTwoFactorEnabled: present.has("users.two_factor_enabled"),
    // M-23: custom avatar (migration 0014). Until the column exists
    // the store behaves as if no user has a custom avatar (null).
    usersAvatarUrl: present.has("users.avatar_url"),
    // The auth-email tables are detected as a group: the combined load
    // only selects auth_two_factor_policy when ALL of them exist
    // (migration 0007 creates them together).
    authEmailTables:
      present.has("two_factor.id") &&
      present.has("auth_oauth_providers.id") &&
      present.has("auth_two_factor_policy.id") &&
      present.has("smtp_settings.id") &&
      present.has("password_reset_tokens.id"),
    productsDefaults:
      present.has("products.default_activation_limit") &&
      present.has("products.offline_grace_hours"),
    packagesCurrentVersion: present.has("product_packages.current_version_id"),
    packageVersionFeaturesUnit: present.has("package_version_features.unit_snapshot"),
    packagePricesUsedInOrders: present.has("package_prices.used_in_orders"),
    paymentSubmissionsDuplicateWarning: present.has(
      "payment_submissions.duplicate_risk_warning"
    ),
    subscriptionsUnitAmount: present.has("subscriptions.unit_amount_minor"),
    trackingEventsDelivery:
      present.has("tracking_events.delivery_attempts") &&
      present.has("tracking_events.delivered_at"),
    idempotencyResponseBody: present.has("idempotency_records.response_body"),
    licensesIntegrationProfileNullable: licensesRow?.["is_nullable"] === "YES",
    signingKeys: present.has("signing_keys.key_id"),
  };
}

async function assertRequiredTables(client: Client): Promise<void> {
  const rows = await queryRows(
    client,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [[...REQUIRED_TABLES]]
  );
  const found = new Set(rows.map((r) => String(r["table_name"])));
  const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) {
    throw new Error(
      `DrizzleStore: required table "${missing[0]}" is missing. Migrations 0000/0001 have not been applied to this database — apply db/migrations/0000_stackmate_initial_schema.sql and db/migrations/0001_seed_reference_catalog.sql before starting the API.`
    );
  }
}

// ---------------------------------------------------------------------------
// DrizzleStore
// ---------------------------------------------------------------------------

export class DrizzleStore extends StackMateDataStore {
  /** The single pinned pg Client. Also reachable as `drizzleDb.$client`. */
  public readonly pgClient: Client;
  /**
   * Drizzle ORM database built on the same client + the full Drizzle
   * schema — for Better Auth wiring (another agent). NOT used for state
   * persistence (see header note 2).
   */
  public readonly drizzleDb: NodePgDatabase<typeof schema>;
  /**
   * True when create() was called without a real R2 bucket binding, so
   * the inherited in-memory bucket is in use. Production wiring MUST pass
   * env.R2_BUCKET and MUST check this flag before serving uploads.
   */
  public usesInMemoryBucket = false;
  /**
   * B-01: true when this store was built by `createTargeted()` — its
   * `state` holds ONLY the in-memory seed rows (roles, payment
   * providers) and was never full-loaded. Handlers on such a store
   * MUST use the targeted methods (`findStaffPrincipalByEmail`,
   * `findLicenseForValidation`, …) and must never read `store.state`
   * for database rows. `false` for `create()` stores. See
   * `isStateFresh` below for why the flag changes reload behaviour,
   * and `platform/db/targeted-routes.ts` for the allowlist contract
   * that decides which requests get a targeted store.
   */
  public targetedOnly = false;
  /**
   * True: this store loads + persists staff_invitations (migration 0005
   * wiring). The identity service probes this flag
   * (storePersistsStaffInvitations) and fail-closes with 503 on a
   * DrizzleStore that predates the wiring, instead of returning 201 for
   * rows that would vanish on the next reload.
   */
  public readonly supportsStaffInvitations = true;

  private closed = false;
  /**
   * B-01 reuse: true when this store's client came from the
   * connection cache (`connection-cache.ts`) instead of a fresh
   * connect. `close()` releases the lease instead of ending the
   * client; `cacheConnectionString` is the cache key the client was
   * acquired/parked under. A fresh-client store parks its client on
   * close() instead of ending it when the slot is free.
   */
  private leasedConnection = false;
  private cacheConnectionString: string | null = null;
  /**
   * OD-04: lazily-acquired client for the HYPERDRIVE_CACHED binding,
   * used ONLY by loadPublicCatalog (the one staleness-tolerant read).
   * Acquired on the first cached catalog read — leased from the
   * connection cache for its connection string when one is parked,
   * else freshly connected — and released/parked by close() under
   * the same lease rules as the main client. Never used by auth,
   * finance, license, or any other targeted method.
   */
  private cachedPgClient: Client | null = null;
  private cachedLeasedConnection = false;
  private cachedConnectionString: string | null = null;
  /**
   * Instance-level serialization chain for THIS store's client (see
   * header note 1). Deliberately NOT module-level: a chain stored at
   * module scope (the deleted `clientQueues`) is what the Cloudflare
   * cross-request promise flag killed. This chain lives on the store
   * instance, which in the Worker path is created and closed within
   * ONE request — a promise created here can only ever settle in that
   * request. A store shared across requests (tests, scripts) still
   * gets correct serialization; that is the tested contract
   * (concurrent payment-verification / activation races in
   * business-workflows.integration.test.ts). Across DIFFERENT stores
   * sharing one leased client (B-01 reuse), serialization is the
   * connection-cache lease, not this chain: only one store holds the
   * client at a time, so two stores' chains can never interleave
   * queries on it.
   */
  private storeQueue: Promise<void> = Promise.resolve();
  private capabilities: StoreCapabilities = NO_MIGRATION_0002;
  /**
   * Master secret resolved at create() (see resolveEncryptionSecret).
   * Kept only so rotation can encrypt the new key; never logged.
   */
  private encryptionSecret: string | null = null;
  /**
   * True once the active key was loaded from signing_keys. The
   * getActiveSigningKey() override refuses to serve a key before this,
   * so a store can never sign with the constructor's per-process key.
   */
  private signingKeysDurable = false;
  /**
   * B-01 Track A: createTargeted(loadSigningKey) options kept for
   * deferred signing-key resolution (see ensureSigningKeys). Null
   * unless this store was created targeted with loadSigningKey —
   * create() resolves eagerly and never sets this.
   */
  private deferredSigningKeyOpts: DrizzleStoreCreateOptions | null = null;

  private constructor(
    pgClient: Client,
    drizzleDb: NodePgDatabase<typeof schema>
  ) {
    super(DEFAULT_SIGNING_KEY_ID);
    this.pgClient = pgClient;
    this.drizzleDb = drizzleDb;
  }

  /**
   * Connect a FRESH pg Client, retrying the handshake ONCE on ANY
   * error. A failed handshake is never a deterministic boot failure:
   * pool exhaustion (PostgreSQL 53300 "remaining connection slots…"),
   * Neon wake-up (57P03), or a Hyperdrive hiccup can all reject the
   * first attempt and succeed on the second — the second attempt
   * decides. The failed client is ended before retrying so it never
   * leaks a half-open socket. The final failure propagates as the raw
   * pg error (code preserved) so the caller's isConnectionError check
   * in apps/api/src/index.ts can still match it.
   */
  private static async connectWithRetry(
    connectionString: string
  ): Promise<Client> {
    const first = new Client({ connectionString });
    try {
      await first.connect();
      return first;
    } catch {
      await first.end().catch(() => {});
    }
    const retry = new Client({ connectionString });
    try {
      await retry.connect();
      return retry;
    } catch (error) {
      await retry.end().catch(() => {});
      throw error;
    }
  }

  public static async create(
    opts: DrizzleStoreCreateOptions
  ): Promise<DrizzleStore> {
    if (!opts.connectionString || opts.connectionString.trim().length === 0) {
      throw new Error(
        "DrizzleStore.create: connectionString is empty. Pass the PostgreSQL connection string (in production, HYPERDRIVE_NO_CACHE.connectionString)."
      );
    }
    // B-01 reuse: lease the idle cached client when one is free for
    // this connection string, else connect fresh exactly as before.
    // The lease (connection-cache.ts) guarantees no other request is
    // using the client; every query promise below is created and
    // awaited inside this request.
    const leasedClient = tryAcquireCachedClient(opts.connectionString);
    let pgClient: Client;
    if (leasedClient) {
      pgClient = leasedClient;
    } else {
      try {
        pgClient = await DrizzleStore.connectWithRetry(opts.connectionString);
      } catch (error) {
        const wrapped = new Error(
          `DrizzleStore.create: could not connect to PostgreSQL: ${(error as Error).message}`
        );
        // Preserve the pg error code so the entrypoint's isConnectionError
        // check (apps/api/src/index.ts) can still match it.
        (wrapped as { code?: unknown }).code = (
          error as { code?: unknown }
        )?.code;
        throw wrapped;
      }
    }
    const drizzleDb = drizzle(pgClient, { schema });
    const store = new DrizzleStore(pgClient, drizzleDb);
    store.leasedConnection = leasedClient !== null;
    store.cacheConnectionString = opts.connectionString;
    try {
      store.capabilities = await detectCapabilitiesCached(
        opts.connectionString,
        pgClient
      );
      // Throws a clear error naming the missing table when migrations
      // 0000/0001 have not been applied. Reference rows come from
      // migration 0001 — this store never auto-seeds them.
      await assertRequiredTablesCached(opts.connectionString, pgClient);
      await store.loadStateInternal(pgClient);
      await store.resolveSigningKey(opts);
      if (opts.r2Bucket !== undefined && opts.r2Bucket !== null) {
        store.r2Bucket = opts.r2Bucket;
        store.usesInMemoryBucket = false;
      } else {
        // Keep the inherited InMemoryR2Bucket and flag it (header note 5).
        store.usesInMemoryBucket = true;
      }
    } catch (error) {
      // B-01 reuse: a leased client that fails the creation phase with
      // a connection error was dead without an `error` event yet —
      // discard it and retry ONCE on a fresh client (the retry's
      // acquire finds the entry gone, so it cannot re-lease the same
      // client and cannot loop). Any other failure releases a healthy
      // leased client back to the cache instead of ending it.
      if (store.leasedConnection) {
        if (isConnectionError(error)) {
          discardCachedClient(pgClient);
          return DrizzleStore.create(opts);
        }
        releaseCachedClient(pgClient);
      } else {
        await pgClient.end().catch(() => {});
      }
      throw error;
    }
    return store;
  }

  /**
   * B-01 (phased fast path): connect WITHOUT the combined full-state
   * load. The returned store's `state` holds only the in-memory seed
   * rows — services must NOT read `store.state` from it. Use the
   * targeted lookup methods instead (`findStaffPrincipalByEmail`,
   * `findLicenseForValidation`, `findIntegratedSiteByKey`,
   * `loadPublicCatalog`, `claimOutboxEvents`); each runs 1–3 targeted
   * SQL queries and never touches the other ~60 tables. The FULL LOAD
   * REMAINS the fallback: plain `create()` and `withTransaction`
   * (which reloads inside the transaction) are unchanged, so any route
   * not yet migrated keeps working exactly as before.
   *
   * No store is shared across requests (OD-03): like `create()`,
   * this opens a fresh request-scoped client owned by the returned
   * store — `close()` releases the cached lease, or parks the fresh
   * client for the next request (see connection-cache.ts). Signing
   * keys are loaded only when `loadSigningKey` is set (license
   * validation needs them to sign entitlement tokens; a principal
   * lookup does not).
   */
  public static async createTargeted(
    opts: DrizzleStoreCreateOptions & { loadSigningKey?: boolean }
  ): Promise<DrizzleStore> {
    if (!opts.connectionString || opts.connectionString.trim().length === 0) {
      throw new Error(
        "DrizzleStore.createTargeted: connectionString is empty. Pass the PostgreSQL connection string (in production, HYPERDRIVE_NO_CACHE.connectionString)."
      );
    }
    // B-01 reuse: same lease-or-fresh-connect as create() (above).
    const leasedClient = tryAcquireCachedClient(opts.connectionString);
    let pgClient: Client;
    if (leasedClient) {
      pgClient = leasedClient;
    } else {
      try {
        pgClient = await DrizzleStore.connectWithRetry(opts.connectionString);
      } catch (error) {
        const wrapped = new Error(
          `DrizzleStore.createTargeted: could not connect to PostgreSQL: ${(error as Error).message}`
        );
        (wrapped as { code?: unknown }).code = (
          error as { code?: unknown }
        )?.code;
        throw wrapped;
      }
    }
    const drizzleDb = drizzle(pgClient, { schema });
    const store = new DrizzleStore(pgClient, drizzleDb);
    store.leasedConnection = leasedClient !== null;
    store.cacheConnectionString = opts.connectionString;
    try {
      store.targetedOnly = true;
      store.capabilities = await detectCapabilitiesCached(
        opts.connectionString,
        pgClient
      );
      await assertRequiredTablesCached(opts.connectionString, pgClient);
      if (opts.loadSigningKey) {
        // B-01 Track A: DEFER — do NOT resolve the signing keys here.
        // Eager resolution pays a fingerprint round trip on EVERY
        // request (warm cache) or a 5-round-trip reload (cold cache)
        // at store creation, before the handler even runs. The
        // fingerprint instead rides inside the validate lookup
        // statement (findLicenseForValidation,
        // includeSigningKeyFingerprint), and the service calls
        // ensureSigningKeys(fingerprint) just before signing — so a
        // warm validate pays no extra round trip at all, and an
        // invalid-key request pays no signing-key query at all (it
        // never signs). The M-16 invariant is unchanged: the cache
        // is still validated against a fingerprint before ANY key
        // material is trusted, and a mismatch/cold cache still runs
        // the full advisory-locked reload (at signing time instead
        // of creation time). Only the license-validate route passes
        // loadSigningKey (targeted-routes.ts), so no other route is
        // affected; create() still resolves eagerly.
        store.deferredSigningKeyOpts = opts;
      }
      if (opts.r2Bucket !== undefined && opts.r2Bucket !== null) {
        store.r2Bucket = opts.r2Bucket;
        store.usesInMemoryBucket = false;
      } else {
        store.usesInMemoryBucket = true;
      }
    } catch (error) {
      // B-01 reuse: same leased-client handling as create() — a dead
      // leased client retries once on a fresh client; a healthy one
      // is released back to the cache.
      if (store.leasedConnection) {
        if (isConnectionError(error)) {
          discardCachedClient(pgClient);
          return DrizzleStore.createTargeted(opts);
        }
        releaseCachedClient(pgClient);
      } else {
        await pgClient.end().catch(() => {});
      }
      throw error;
    }
    return store;
  }

  /**
   * B-01: a targeted store NEVER reloads full state implicitly.
   *
   * `reloadStateIfPossible` (identity service, used by
   * `resolveStaffPrincipal` in the `authContext` middleware path)
   * calls `loadState()` whenever `isStateFresh()` is false — and on
   * a targeted store the base implementation is ALWAYS false
   * (`loadedAtMs` is set only by `loadStateInternal`, which
   * `createTargeted` never runs). Without this override, the
   * principal fallback — a valid session whose user is missing or
   * suspended, so the targeted fast path (`findStaffPrincipalFast`)
   * returns null — would silently pay a full ~65-table load on an
   * allowlisted route, defeating B-01 for exactly the requests the
   * switch was built for.
   *
   * A targeted store reports fresh because its reads ARE fresh by
   * construction: every targeted method queries Postgres directly,
   * so there is nothing stale to reload. The post-reload
   * `store.state` reads in `resolveStaffPrincipal` then see the
   * (empty) seed state — but the fast path already ran the
   * authoritative targeted lookup and found nothing, so the outcome
   * is identical (null principal for a missing/suspended user).
   *
   * Consequence, by design: code that NEEDS populated state after
   * `reloadStateIfPossible` (sign-in, 2FA recovery — both read
   * `store.state.users` after it) can NEVER run on a targeted store.
   * That is the allowlist contract in
   * `platform/db/targeted-routes.ts`: such routes can never earn an
   * entry. A DIRECT `loadState()` call still performs a full load
   * (explicit escape hatch, untouched) — only the implicit reload
   * is suppressed.
   */
  public override isStateFresh(_maxAgeMs = 30_000): boolean {
    if (this.targetedOnly) return true;
    return super.isStateFresh(_maxAgeMs);
  }

  /**
   * Resolve the master secret for signing-key envelope encryption.
   * Priority: create() option `encryptionSecret` → process.env
   * ENCRYPTION_KEY_V1 (local dev only — Workers do not populate
   * process.env with bindings). With no secret at all, the store fails
   * closed UNLESS the runtime is positively local/test (APP_ENV
   * 'local'/'test', NODE_ENV 'test', or under vitest), where the env.ts
   * dev fallback applies. This is deliberately stricter than env.ts,
   * which defaults an unset APP_ENV to 'local': DrizzleStore cannot see
   * Worker bindings, so an unwired Worker (no appEnv, no test signal)
   * must fail closed rather than silently encrypt production keys with
   * a public default. Wiring must pass encryptionSecret + appEnv
   * (see the NOTE in the create() options).
   */
  private resolveEncryptionSecret(opts: DrizzleStoreCreateOptions): string {
    const supplied = opts.encryptionSecret?.trim() ?? "";
    const fromEnv = process.env.ENCRYPTION_KEY_V1?.trim() ?? "";
    const secret = supplied.length > 0 ? supplied : fromEnv;
    if (secret.length > 0) return secret;
    const appEnv = opts.appEnv ?? process.env.APP_ENV;
    const isProdLike = appEnv === "staging" || appEnv === "production";
    const isKnownNonProd =
      appEnv === "local" ||
      appEnv === "test" ||
      process.env.NODE_ENV === "test" ||
      process.env.VITEST === "true";
    if (isProdLike || !isKnownNonProd) {
      throw new Error(
        "DrizzleStore: ENCRYPTION_KEY_V1 is missing and no encryptionSecret was passed to DrizzleStore.create(). " +
          "License signing keys cannot be decrypted or persisted without it. " +
          "In staging/production set the ENCRYPTION_KEY_V1 secret (wiring: pass encryptionSecret: env.ENCRYPTION_KEY_V1 and appEnv: env.APP_ENV to DrizzleStore.create()). " +
          "The local/test dev fallback applies only when APP_ENV is 'local'/'test' (or under vitest / NODE_ENV=test)."
      );
    }
    return DEV_FALLBACK_ENCRYPTION_SECRET;
  }

  /**
   * One-query fingerprint of the non-revoked signing_keys rows — the
   * same string fingerprintSigningKeyRows computes in TS from loaded
   * rows. Used to validate a warm-cache hit: only an exact match may
   * trust the cached material.
   */
  private async signingKeysFingerprint(client: Client): Promise<string> {
    const rows = await queryRows(
      client,
      `SELECT key_id, status, md5(COALESCE(encrypted_private_jwk, '')) AS ct_hash
         FROM signing_keys WHERE status <> 'revoked'
        ORDER BY key_id ASC`,
    );
    return rows
      .map((r) => `${str(r, "key_id")}:${str(r, "status")}:${str(r, "ct_hash")}`)
      .join("|");
  }

  /**
   * Durably resolve the signing keys (header note 4).
   *
   * Source of truth is the signing_keys table, never process memory:
   *  1. If an 'active' row exists, load it — plus every 'retired' row,
   *     so old tokens keep verifying across restarts. Revoked rows are
   *     never loaded (their tokens must stop verifying).
   *  2. If no active row exists and an env/option private JWK was
   *     supplied, import it ONCE (bootstrap-only) under the configured
   *     key id and persist it encrypted.
   *  3. If no active row exists and no JWK was supplied, generate ONE
   *     key, encrypt it, and persist it immediately.
   * The whole bootstrap runs inside one advisory-locked transaction, so
   * two processes booting at once converge on a single active row
   * (unique key_id + ON CONFLICT DO NOTHING, then re-read). The
   * constructor's per-process key is discarded here — it is never used.
   * Throws a clear error when migration 0004 is missing, when
   * ENCRYPTION_KEY_V1 is missing/undecryptable, or when the stored
   * private material cannot be decrypted.
   */
  private async resolveSigningKey(
    opts: DrizzleStoreCreateOptions,
    /**
     * B-01 Track A: a fingerprint computed by the caller (the
     * validate lookup statement), so the warm-cache check costs no
     * extra query. `undefined` (default) queries it here, as before;
     * `null` skips the cache check and reloads directly.
     */
    precomputedFingerprint?: string | null
  ): Promise<void> {
    const secret = this.resolveEncryptionSecret(opts);
    this.encryptionSecret = secret;
    if (!this.capabilities.signingKeys) {
      throw new Error(
        "DrizzleStore: signing_keys table is missing. Apply migration 0004 (db/migrations/0004_signing_keys.sql) before starting the API — license signing keys are durable-only and a per-process key is no longer generated."
      );
    }
    const client = this.pgClient;
    // M-16: warm-cache fast path — skip the 5-round-trip transaction.
    // The cache key binds the signing opts (key id + env-JWK hash), so
    // a boot with different import opts never gets a stale hit.
    const cacheKey = signingKeyCacheKey(
      opts.connectionString,
      secret,
      opts.signingKeyId?.trim() ?? "",
      opts.signingPrivateJwk
        ? createHash("sha256").update(opts.signingPrivateJwk).digest("hex")
        : "",
    );
    const cached = signingKeyCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAtMs < SIGNING_KEY_CACHE_TTL_MS) {
      // FIXED 2026-11-20: a bare TTL cache masked table mutations —
      // a boot after a TRUNCATE returned the old keys (signing-keys
      // (e) could never win the empty table), and a corrupt row never
      // failed closed (signing-keys (f) part 2). Validate the entry
      // against a one-query fingerprint (key ids + statuses +
      // ciphertext hashes) before trusting it; any change falls
      // through to the full reload below, which decrypts and fails
      // closed on a corrupt/undecryptable row.
      const fingerprint =
        precomputedFingerprint === undefined
          ? await this.signingKeysFingerprint(client)
          : precomputedFingerprint;
      if (fingerprint !== null && this.applyCachedSigningKeys(cacheKey, fingerprint)) {
        return;
      }
    }
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITER_ADVISORY_LOCK_KEY]);
      const activeRows = await queryRows(
        client,
        `SELECT key_id FROM signing_keys WHERE status = 'active'`
      );
      if (activeRows.length > 1) {
        throw new Error(
          `DrizzleStore: signing_keys has ${activeRows.length} active keys (expected exactly one). The single-active partial unique index from migration 0004 should prevent this — inspect the table before restarting.`
        );
      }
      if (activeRows.length === 0) {
        await this.bootstrapSigningKey(client, opts, secret);
      }
      const rows = await queryRows(
        client,
        `SELECT key_id, public_jwk, encrypted_private_jwk, status
           FROM signing_keys WHERE status <> 'revoked'
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, key_id ASC`
      );
      // Decrypt inside the transaction: a corrupt/undecryptable row rolls
      // the bootstrap back and boot fails closed with a clear error.
      const loaded = new Map<string, Ed25519KeyMaterial>();
      let activeKeyId: string | null = null;
      for (const row of rows) {
        const material = this.decryptSigningKeyRow(row, secret);
        loaded.set(material.keyId, material);
        if (str(row, "status") === "active") activeKeyId = material.keyId;
      }
      if (activeKeyId === null) {
        throw new Error(
          "DrizzleStore: signing_keys has no active key after bootstrap. The bootstrap insert did not produce an active row (the configured key id may already exist as a retired/revoked row) — inspect signing_keys before restarting."
        );
      }
      await client.query("COMMIT");
      // Only now replace the constructor's per-process key: nothing
      // outside this method can ever observe a non-durable key.
      this.signingKeys.clear();
      for (const [keyId, material] of loaded) this.signingKeys.set(keyId, material);
      this.activeSigningKeyId = activeKeyId;
      this.signingKeysDurable = true;
      // M-16: populate the warm cache for the next create() on this
      // isolate (same connection string + secret). The fingerprint is
      // computed from the rows just loaded, so the next hit can prove
      // the table has not changed since (see fingerprintSigningKeyRows).
      signingKeyCache.set(cacheKey, {
        keys: new Map(loaded),
        activeKeyId,
        cachedAtMs: Date.now(),
        fingerprint: fingerprintSigningKeyRows(rows),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  /**
   * M-16 warm-cache validation, shared by resolveSigningKey (which
   * queries its own fingerprint) and ensureSigningKeys (which is
   * handed the fingerprint the validate lookup statement computed).
   * Adopts the cached material ONLY on an exact fingerprint match
   * inside the TTL; anything else returns false and the caller falls
   * through to the full reload, which decrypts and fails closed.
   * Returns true when the keys are now durable on this store.
   */
  private applyCachedSigningKeys(cacheKey: string, fingerprint: string): boolean {
    const cached = signingKeyCache.get(cacheKey);
    if (!cached || Date.now() - cached.cachedAtMs >= SIGNING_KEY_CACHE_TTL_MS) {
      return false;
    }
    if (fingerprint !== cached.fingerprint) return false;
    this.signingKeys.clear();
    for (const [keyId, material] of cached.keys) this.signingKeys.set(keyId, material);
    this.activeSigningKeyId = cached.activeKeyId;
    this.signingKeysDurable = true;
    return true;
  }

  /**
   * B-01 Track A — deferred signing-key resolution for a
   * createTargeted(loadSigningKey) store. Call after the license
   * lookup, just before signing, with the fingerprint the lookup
   * statement returned (findLicenseForValidation,
   * includeSigningKeyFingerprint). Warm path: the fingerprint
   * validates the M-16 cache — ZERO extra queries. Cold/mismatch
   * path (first request after a rotation, TTL expiry, or a null
   * fingerprint): the full advisory-locked reload, exactly like
   * resolveSigningKey — decrypting and failing closed on a
   * corrupt/undecryptable row. A store whose keys are already
   * durable (create(), or an earlier ensure on this instance) is a
   * no-op. Throws when called on a store that never deferred
   * resolution — sign with a create()/createTargeted(loadSigningKey)
   * store instead; the constructor's per-process key is never used.
   */
  public async ensureSigningKeys(fingerprint: string | null): Promise<void> {
    if (this.signingKeysDurable) return;
    const opts = this.deferredSigningKeyOpts;
    if (!opts) {
      throw new Error(
        "DrizzleStore: ensureSigningKeys called on a store that never deferred signing-key resolution (no loadSigningKey). Use a create() store or createTargeted({ loadSigningKey: true }) instead."
      );
    }
    const secret = this.resolveEncryptionSecret(opts);
    this.encryptionSecret = secret;
    if (!this.capabilities.signingKeys) {
      throw new Error(
        "DrizzleStore: signing_keys table is missing. Apply migration 0004 (db/migrations/0004_signing_keys.sql) before starting the API — license signing keys are durable-only and a per-process key is no longer generated."
      );
    }
    const cacheKey = signingKeyCacheKey(
      opts.connectionString,
      secret,
      opts.signingKeyId?.trim() ?? "",
      opts.signingPrivateJwk
        ? createHash("sha256").update(opts.signingPrivateJwk).digest("hex")
        : "",
    );
    if (fingerprint !== null && this.applyCachedSigningKeys(cacheKey, fingerprint)) {
      return;
    }
    await this.resolveSigningKey(opts, fingerprint);
  }

  /**
   * First-boot key creation, inside the caller's advisory-locked
   * transaction. Key id priority: create() option `signingKeyId` → the
   * active signing_key_metadata row (legacy hint) → the current month
   * (sm-ed25519-YYYY-MM). Private material priority: env/option JWK
   * (imported once, bootstrap-only) → generate one key. The row is
   * inserted ON CONFLICT DO NOTHING so a concurrent boot that won the
   * same key id converges instead of erroring; the caller's re-read
   * then loads whichever active row exists.
   */
  private async bootstrapSigningKey(
    client: Client,
    opts: DrizzleStoreCreateOptions,
    secret: string
  ): Promise<void> {
    let keyId = opts.signingKeyId?.trim() ?? "";
    if (keyId.length === 0) {
      const metaRows = await queryRows(
        client,
        `SELECT key_id FROM signing_key_metadata
          WHERE status = 'active'
          ORDER BY activated_at DESC NULLS LAST, created_at DESC
          LIMIT 1`
      );
      keyId =
        (metaRows[0] === undefined ? null : str(metaRows[0], "key_id")) ??
        deriveMonthlySigningKeyId();
    }
    const privateJwkRaw =
      opts.signingPrivateJwk ?? process.env.LICENSE_SIGNING_PRIVATE_JWK;
    const publicJwkRaw =
      opts.signingPublicJwk ?? process.env.LICENSE_SIGNING_PUBLIC_JWK;
    let material: Ed25519KeyMaterial;
    let privateJwkJson: string;
    if (privateJwkRaw !== undefined && privateJwkRaw.trim().length > 0) {
      material = importEd25519KeyMaterialFromPrivateJwk(
        privateJwkRaw,
        keyId,
        publicJwkRaw
      );
      privateJwkJson = JSON.stringify(
        JSON.parse(privateJwkRaw) as Record<string, unknown>
      );
    } else {
      material = generateEd25519KeyMaterial(keyId);
      privateJwkJson = exportPrivateJwkJson(material);
    }
    const encrypted = encryptSecretAtRest(
      privateJwkJson,
      secret,
      "v1",
      signingKeyAadContext(keyId)
    );
    const inserted = await client.query(
      `INSERT INTO signing_keys
         (id, key_id, public_jwk, encrypted_private_jwk, status,
          created_at, activated_at, supersedes_key_id, rotation_reason)
       VALUES ($1, $2, $3::jsonb, $4, 'active', now(), now(), NULL, NULL)
       ON CONFLICT (key_id) DO NOTHING`,
      [randomUUID(), keyId, JSON.stringify(material.publicKeyJwk), encrypted]
    );
    if (inserted.rowCount === 0) {
      // Same key_id already exists (concurrent boot won it, or it is a
      // retired/revoked row). The caller's re-read decides: an active
      // row means the race converged; otherwise boot fails closed.
      return;
    }
    await this.syncSigningKeyMetadata(client, {
      keyId,
      publicJwk: material.publicKeyJwk,
      status: "active",
      retiredAt: null,
    });
  }

  /**
   * Decrypt one signing_keys row into key material. The stored public
   * JWK is passed to the importer as a cross-check: import fails loudly
   * if it does not match the private key. An undecryptable row is a
   * fail-closed boot error, never a silent fallback to a fresh key —
   * silently replacing the key would invalidate every token ever signed
   * with it.
   */
  private decryptSigningKeyRow(row: Row, secret: string): Ed25519KeyMaterial {
    const keyId = reqStr(row, "key_id", "signing_keys");
    const encrypted = reqStr(row, "encrypted_private_jwk", "signing_keys");
    let privateJwkJson: string;
    try {
      privateJwkJson = decryptSecretAtRest(
        encrypted,
        secret,
        signingKeyAadContext(keyId)
      );
    } catch {
      throw new Error(
        `DrizzleStore: could not decrypt signing key '${keyId}' with ENCRYPTION_KEY_V1. The stored private key was encrypted with a different master secret (or the ciphertext is corrupt). Rotation to a fresh key is the only recovery — old tokens signed by this key become unverifiable. See docs/operations/KEY-ROTATION-AND-SECURITY-RUNBOOK.md.`
      );
    }
    const publicJwk = asJsonObject(row, "public_jwk");
    return importEd25519KeyMaterialFromPrivateJwk(
      privateJwkJson,
      keyId,
      JSON.stringify(publicJwk)
    );
  }

  /**
   * Keep signing_key_metadata (migration 0000) in sync with signing_keys:
   * same key id, same public JWK, same lifecycle status. Same
   * transaction as the signing_keys write, so the mirror can never
   * diverge. Private material is NEVER written here.
   */
  private async syncSigningKeyMetadata(
    client: Client,
    row: {
      keyId: string;
      publicJwk: Record<string, unknown>;
      status: "active" | "retired" | "revoked";
      retiredAt: string | null;
    }
  ): Promise<void> {
    await execSql(
      client,
      `INSERT INTO signing_key_metadata
         (id, key_id, algorithm, public_key_jwk, status, activated_at, retired_at, created_at)
       VALUES ($1, $2, 'EdDSA', $3::jsonb, $4, now(), $5, now())
       ON CONFLICT (key_id) DO UPDATE SET
         public_key_jwk = EXCLUDED.public_key_jwk,
         status = EXCLUDED.status,
         retired_at = EXCLUDED.retired_at`,
      [
        randomUUID(),
        row.keyId,
        JSON.stringify(row.publicJwk),
        row.status,
        row.retiredAt,
      ]
    );
  }

  /**
   * Fresh rotation key id: sm-ed25519-YYYY-MM for the current month,
   * with a -2, -3, … suffix when that id (or the suffixed one) is
   * already taken — e.g. rotating twice in one month yields
   * sm-ed25519-2026-11-2. Key ids are never reused, so a retired key's
   * `kid` can never be hijacked by new material.
   */
  private async deriveRotationKeyId(client: Client): Promise<string> {
    const base = deriveMonthlySigningKeyId();
    const candidates = [
      base,
      ...Array.from({ length: 9 }, (_, i) => `${base}-${i + 2}`),
    ];
    const rows = await queryRows(
      client,
      `SELECT key_id FROM signing_keys WHERE key_id = ANY($1)`,
      [candidates]
    );
    const taken = new Set(rows.map((r) => String(r["key_id"])));
    for (const candidate of candidates) {
      if (!taken.has(candidate) && !this.signingKeys.has(candidate)) {
        return candidate;
      }
    }
    throw new AppError(
      "CONFLICT",
      `Could not derive a fresh signing key id: '${base}' and its -2..-10 suffixes are all taken. Pass an explicit new key id to rotateSigningKey().`,
      409
    );
  }

  /**
   * The active key always comes from signing_keys. Refuses to serve
   * until the durable load in resolveSigningKey() succeeded — a store
   * that never completed that load has only the constructor's
   * per-process key, which must never sign a token.
   */
  public override getActiveSigningKey(): Ed25519KeyMaterial {
    if (!this.signingKeysDurable) {
      throw new Error(
        "DrizzleStore: no durable signing key is loaded — the database-backed key load did not complete. Refusing to sign with a per-process key."
      );
    }
    return super.getActiveSigningKey();
  }

  /**
   * Durably rotate the active signing key. Generates a new key (explicit
   * id, or a derived sm-ed25519-YYYY-MM[-n] id), encrypts its private
   * JWK, and — inside ONE advisory-locked transaction — retires the old
   * active row, inserts the new active row (supersedes_key_id points at
   * the old key, rotation_reason recorded), and syncs
   * signing_key_metadata for both. The old key stays loaded (and stays a
   * 'retired' row), so tokens it signed keep verifying. In-memory state
   * changes only after the durable commit.
   */
  public override async rotateSigningKey(
    newKeyId?: string,
    options?: { reason?: string }
  ): Promise<Ed25519KeyMaterial> {
    this.assertOpen();
    if (!this.signingKeysDurable || !this.encryptionSecret) {
      throw new Error(
        "DrizzleStore: cannot rotate signing keys before the durable key load completed (see resolveSigningKey)."
      );
    }
    const secret = this.encryptionSecret;
    const client = this.pgClient;
    const release = await this.acquireStoreLock();
    let nextKeyId = "";
    let material: Ed25519KeyMaterial | null = null;
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [WRITER_ADVISORY_LOCK_KEY]);
        const activeRows = await queryRows(
          client,
          `SELECT key_id, public_jwk FROM signing_keys
            WHERE status = 'active'
            ORDER BY activated_at DESC NULLS LAST LIMIT 1`
        );
        const oldKeyId =
          activeRows[0] === undefined ? null : str(activeRows[0], "key_id");
        const oldPublicJwk =
          activeRows[0] === undefined
            ? null
            : asJsonObject(activeRows[0], "public_jwk");
        nextKeyId = newKeyId?.trim() ?? "";
        if (nextKeyId.length === 0) {
          nextKeyId = await this.deriveRotationKeyId(client);
        } else {
          if (
            nextKeyId.length > 80 ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nextKeyId)
          ) {
            throw new AppError(
              "VALIDATION_ERROR",
              `Signing key ID '${nextKeyId}' is invalid: use 1-80 characters, letters/digits/dot/dash/underscore, starting with a letter or digit.`,
              400
            );
          }
          const clash = await queryRows(
            client,
            `SELECT key_id FROM signing_keys WHERE key_id = $1`,
            [nextKeyId]
          );
          if (clash.length > 0 || this.signingKeys.has(nextKeyId)) {
            throw new AppError(
              "CONFLICT",
              `Signing key ID '${nextKeyId}' already exists.`,
              409
            );
          }
        }
        const generated = generateEd25519KeyMaterial(nextKeyId);
        material = generated;
        const encrypted = encryptSecretAtRest(
          exportPrivateJwkJson(generated),
          secret,
          "v1",
          signingKeyAadContext(nextKeyId)
        );
        const reason = options?.reason?.trim() || null;
        const nowIso = new Date().toISOString();
        if (oldKeyId !== null) {
          // Retire FIRST: the single-active partial unique index forbids
          // two active rows even for an instant inside the transaction.
          await execSql(
            client,
            `UPDATE signing_keys SET status = 'retired', retired_at = now()
              WHERE key_id = $1 AND status = 'active'`,
            [oldKeyId]
          );
          await this.syncSigningKeyMetadata(client, {
            keyId: oldKeyId,
            publicJwk:
              oldPublicJwk ?? this.signingKeys.get(oldKeyId)?.publicKeyJwk ?? {},
            status: "retired",
            retiredAt: nowIso,
          });
        }
        await execSql(
          client,
          `INSERT INTO signing_keys
             (id, key_id, public_jwk, encrypted_private_jwk, status,
              created_at, activated_at, supersedes_key_id, rotation_reason)
           VALUES ($1, $2, $3::jsonb, $4, 'active', now(), now(), $5, $6)`,
          [
            randomUUID(),
            nextKeyId,
            JSON.stringify(generated.publicKeyJwk),
            encrypted,
            oldKeyId,
            reason,
          ]
        );
        await this.syncSigningKeyMetadata(client, {
          keyId: nextKeyId,
          publicJwk: generated.publicKeyJwk,
          status: "active",
          retiredAt: null,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      if (material === null || nextKeyId.length === 0) {
        // Unreachable: the inner try either commits with both set or throws.
        throw new Error("DrizzleStore: rotation completed without producing a new key.");
      }
      this.signingKeys.set(nextKeyId, material);
      this.activeSigningKeyId = nextKeyId;
      // M-16: the cached key set is stale after a rotation.
      signingKeyCache.clear();
      return material;
    } finally {
      release();
    }
  }

  /**
   * Durably revoke a NON-ACTIVE signing key. The row becomes 'revoked'
   * (signing_key_metadata synced in the same transaction) and the key
   * is dropped from the in-memory verification set, so its tokens stop
   * verifying and its public JWK leaves
   * GET /api/v1/licenses/signing-keys. Revoking the active key is
   * refused — rotate first, then revoke the retired key — so there is
   * always exactly one active key. Revoking an already-revoked key is
   * a no-op.
   */
  public override async revokeSigningKey(keyId: string): Promise<void> {
    this.assertOpen();
    const client = this.pgClient;
    const release = await this.acquireStoreLock();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [WRITER_ADVISORY_LOCK_KEY]);
        const rows = await queryRows(
          client,
          `SELECT key_id, public_jwk, status, retired_at
             FROM signing_keys WHERE key_id = $1 FOR UPDATE`,
          [keyId]
        );
        if (rows.length === 0) {
          throw new AppError("NOT_FOUND", `Signing key '${keyId}' not found.`, 404);
        }
        const row = rows[0]!;
        const status = str(row, "status");
        if (status === "active" || keyId === this.activeSigningKeyId) {
          throw new AppError(
            "CONFLICT",
            `Cannot revoke the active signing key '${keyId}': rotate to a new key first, then revoke the retired key.`,
            409
          );
        }
        if (status !== "revoked") {
          const retiredAt = iso(row, "retired_at") ?? new Date().toISOString();
          await execSql(
            client,
            `UPDATE signing_keys SET status = 'revoked', retired_at = COALESCE(retired_at, now())
              WHERE key_id = $1`,
            [keyId]
          );
          await this.syncSigningKeyMetadata(client, {
            keyId,
            publicJwk: asJsonObject(row, "public_jwk"),
            status: "revoked",
            retiredAt,
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      this.signingKeys.delete(keyId);
      // M-16: the cached key set is stale after a revocation.
      signingKeyCache.clear();
    } finally {
      release();
    }
  }

  /**
   * C-1: DB-backed rate limiting (table `rate_limit_buckets`,
   * migration 0016 — the DB agent's part). One atomic upsert: the
   * count increments and the window resets iff expired, so concurrent
   * requests cannot both slip under the limit.
   *
   * B-09: `options.skipWhenLimitedBy` names a more specific bucket
   * (e.g. the per-account sign-in lockout). When that bucket is
   * already limited, the generic bucket is skipped entirely — no
   * increment and no upsert round-trip on the hot path; the caller
   * 429s on the specific bucket anyway. The call-site wiring lives in
   * app.ts (sign-in: skip the generic `auth:` bucket when the
   * lockout bucket already applies).
   *
   * A-07: until migration 0016 lands the table is missing (42P01) —
   * the in-memory fallback is KEPT (LV-01 unconfirmed: staging may
   * not have 0016 yet), but every fallback occurrence is now logged
   * LOUDLY (console.error per occurrence, not warn-once) so a dead
   * limiter can never go unnoticed again. See also
   * `rateLimitTableExists()` for the boot/readiness probe.
   */
  public override async checkRateLimit(
    bucketKey: string,
    maxRequests: number,
    windowMs = 60_000,
    options?: {
      skipWhenLimitedBy?: {
        bucketKey: string;
        maxRequests: number;
        windowMs?: number;
      };
    }
  ): Promise<void> {
    this.assertOpen();
    const skip = options?.skipWhenLimitedBy;
    if (skip) {
      // Non-incrementing probe (1 SELECT): if the specific bucket is
      // already limited, the generic bucket must not also be burned.
      const alreadyLimited = await this.isRateLimited(
        skip.bucketKey,
        skip.maxRequests,
        skip.windowMs ?? 60_000
      );
      if (alreadyLimited) return;
    }
    try {
      const res = await this.pgClient.query(
        `INSERT INTO rate_limit_buckets ("key", "count", "reset_at")
           VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
           ON CONFLICT ("key") DO UPDATE SET
             "count" = CASE WHEN rate_limit_buckets."reset_at" <= NOW() THEN 1 ELSE rate_limit_buckets."count" + 1 END,
             "reset_at" = CASE WHEN rate_limit_buckets."reset_at" <= NOW() THEN NOW() + ($2 * INTERVAL '1 millisecond') ELSE rate_limit_buckets."reset_at" END
           RETURNING "count"`,
        [bucketKey, windowMs]
      );
      const count = (res.rows[0] as { count: number } | undefined)?.count ?? 1;
      if (count > maxRequests) {
        throw new AppError(
          "RATE_LIMIT_EXCEEDED",
          "Too many requests. Please retry after the rate-limit window resets.",
          429
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: string })?.code === "42P01") {
        // A-07: LOUD, per occurrence — the DB-backed limiter is down
        // and auth is running on the per-isolate in-memory map (which
        // is effectively empty per request on Workers). Apply
        // migration 0016; see rateLimitTableExists().
        console.error(
          "[stackmate] RATE LIMIT DEGRADED: rate_limit_buckets table is missing " +
            "(migration 0016 not applied) — rate limiting fell back to the per-isolate " +
            `in-memory map for bucket '${bucketKey}'. This fallback is fail-open on Workers.`
        );
        return super.checkRateLimit(bucketKey, maxRequests, windowMs);
      }
      throw error;
    }
  }

  public override async resetRateLimit(bucketKey: string): Promise<void> {
    this.assertOpen();
    try {
      await this.pgClient.query(`DELETE FROM rate_limit_buckets WHERE "key" = $1`, [bucketKey]);
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") {
        return super.resetRateLimit(bucketKey);
      }
      throw error;
    }
  }

  public override async isRateLimited(
    bucketKey: string,
    maxRequests: number,
    windowMs = 60_000
  ): Promise<boolean> {
    this.assertOpen();
    try {
      const res = await this.pgClient.query(
        `SELECT "count", "reset_at" FROM rate_limit_buckets WHERE "key" = $1`,
        [bucketKey]
      );
      const row = res.rows[0] as { count: number; reset_at: Date } | undefined;
      if (!row) return false;
      if (new Date(row.reset_at).getTime() <= Date.now()) return false;
      return Number(row.count) >= maxRequests;
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") {
        return super.isRateLimited(bucketKey, maxRequests, windowMs);
      }
      throw error;
    }
  }

  /**
   * Reload all tables into this.state (per-request refresh). Serialized
   * against withTransaction through the instance lock so two callers
   * never interleave queries on this store's client.
   */
  public async loadState(): Promise<DatabaseState> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      this.queryMetrics.uncachedQueries += 1;
      await this.loadStateInternal(this.pgClient);
      return this.state;
    } finally {
      release();
    }
  }

  // -- B-01 targeted reads (fast paths) --------------------------------------
  // Each method below runs 1–3 targeted SQL queries for ONE route's
  // data and never runs the combined full-state load. They are safe on
  // a `createTargeted()` store (whose `state` is empty) AND on a
  // regular `create()` store. All mappings mirror
  // loadStateInternalImpl / buildLoadStateQuery column-for-column —
  // if a column list changes there, change it here too. Serialized
  // through the instance lock like every other client use.
  //
  // B-01 batching (2026-11-26): a single pg Client executes queries in
  // call order and cannot parallelize them, so the Promise.all
  // fan-outs these methods used to have were SERIALIZED round-trips
  // (~250ms each Hyperdrive→Neon on staging). The multi-table methods
  // therefore fetch everything in ONE statement, with per-table
  // json_agg columns — the same pattern as the combined full-state
  // load (buildLoadStateQuery): ORDER BY lives inside the json_agg
  // call, where it is guaranteed, and rows arrive as parsed JSON
  // values the existing row-mapping helpers already accept (numbers
  // stay numbers, timestamptz arrives as an ISO string — see iso()).

  private async targetedRows(text: string, values: unknown[] = []): Promise<Row[]> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      this.queryMetrics.uncachedQueries += 1;
      return await queryRows(this.pgClient, text, values);
    } finally {
      release();
    }
  }

  /**
   * OD-04: the catalog's transport. Runs `text` against the
   * HYPERDRIVE_CACHED client when `cachedConnectionString` names a
   * REAL cached binding — non-empty, different from this store's own
   * (uncached) connection string, and the same database — and counts
   * the completed read in `queryMetrics.cachedQueries` (exactly once,
   * only after the query succeeds). Every other case — no string,
   * aliased to the uncached string (env.ts default when the binding
   * is unconfigured), a different database, or a dead/unreachable
   * cached binding — runs the IDENTICAL query on the authoritative
   * client and counts it as uncached. A failed cached attempt is
   * never counted as cached: the counter reads real cached reads
   * only (B-11). The fallback keeps the public catalog available
   * when the cached binding is down; it serves the same data, just
   * without the edge cache.
   */
  private async catalogRows(
    text: string,
    cachedConnectionString?: string
  ): Promise<Row[]> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      const useCached =
        typeof cachedConnectionString === "string" &&
        cachedConnectionString.trim().length > 0 &&
        this.cacheConnectionString !== null &&
        cachedConnectionString !== this.cacheConnectionString &&
        sameDatabaseName(cachedConnectionString, this.cacheConnectionString);
      if (useCached) {
        try {
          const client = await this.acquireCachedClient(cachedConnectionString);
          const rows = await queryRows(client, text);
          this.queryMetrics.cachedQueries += 1;
          return rows;
        } catch (error) {
          if (!isConnectionError(error)) throw error;
          this.dropCachedClient();
          const rows = await queryRows(this.pgClient, text);
          this.queryMetrics.uncachedQueries += 1;
          return rows;
        }
      }
      const rows = await queryRows(this.pgClient, text);
      this.queryMetrics.uncachedQueries += 1;
      return rows;
    } finally {
      release();
    }
  }

  /**
   * OD-04: lease the parked cached client for `connectionString`
   * when one is idle, else connect fresh (one retry, as
   * connectWithRetry). Called only from catalogRows, which already
   * holds the store lock.
   */
  private async acquireCachedClient(connectionString: string): Promise<Client> {
    if (this.cachedPgClient) {
      // The parked client belongs to a different cached binding —
      // never serve a read from the wrong connection string.
      if (this.cachedConnectionString === connectionString) {
        return this.cachedPgClient;
      }
      this.dropCachedClient();
    }
    const leasedClient = tryAcquireCachedClient(connectionString);
    let client: Client;
    if (leasedClient) {
      client = leasedClient;
    } else {
      client = await DrizzleStore.connectWithRetry(connectionString);
    }
    this.cachedPgClient = client;
    this.cachedLeasedConnection = leasedClient !== null;
    this.cachedConnectionString = connectionString;
    return client;
  }

  /**
   * OD-04: discard the cached client after a connection failure so
   * the next catalog read re-acquires (a leased entry is removed
   * from the cache; a fresh client is ended). The in-flight read
   * has already fallen back to the uncached client in catalogRows.
   */
  private dropCachedClient(): void {
    const client = this.cachedPgClient;
    if (!client) return;
    this.cachedPgClient = null;
    this.cachedConnectionString = null;
    if (this.cachedLeasedConnection) {
      this.cachedLeasedConnection = false;
      discardCachedClient(client);
    } else {
      client.end().catch(() => {});
    }
  }

  private mapUserRow(row: Row): UserRecord {
    return {
      id: reqStr(row, "id", "users"),
      name: reqStr(row, "name", "users"),
      email: reqStr(row, "email", "users"),
      email_verified: bool(row, "email_verified"),
      password_hash: this.capabilities.usersPasswordHash
        ? (str(row, "password_hash") ?? "")
        : "",
      two_factor_enabled: bool(row, "two_factor_enabled"),
      avatar_url: this.capabilities.usersAvatarUrl
        ? (str(row, "avatar_url") ?? null)
        : null,
      status: asEnum(
        str(row, "staff_status"),
        ["active", "suspended"] as const,
        "active"
      ),
      created_at: reqIso(row, "created_at", "users"),
      updated_at: reqIso(row, "updated_at", "users"),
    };
  }

  private static readonly USER_COLUMNS = `u.id, u.name, u.email, u.email_verified, u.created_at, u.updated_at,
            sp.status AS staff_status`;

  /** One staff user by email (session/principal lookup hot path). */
  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.targetedRows(
      `SELECT ${DrizzleStore.USER_COLUMNS}
            ${this.capabilities.usersPasswordHash ? ", u.password_hash" : ""}
            ${this.capabilities.usersTwoFactorEnabled ? ", u.two_factor_enabled" : ""}
            ${this.capabilities.usersAvatarUrl ? ", u.avatar_url" : ""}
         FROM users u
         LEFT JOIN staff_profiles sp ON sp.user_id = u.id
        WHERE lower(u.email) = lower($1)
        LIMIT 1`,
      [email.trim()]
    );
    const row = rows[0];
    return row ? this.mapUserRow(row) : null;
  }

  /**
   * Staff principal data for one email: the user row + role keys +
   * permission keys + the 2FA policy rows (3 queries). This is what
   * resolveStaffPrincipal needs after Better Auth has already verified
   * the session — it replaces the create-load + principal reload pair
   * on every admin request (A-11). The policy rows are NOT optional:
   * `two_factor_setup_required` is computed from them, and a fast
   * path that skipped them would silently grant a full session to a
   * user under a `required` policy who has not set 2FA up yet. On a
   * pre-0007 database (no auth_two_factor_policy table) the policy
   * list is empty, exactly like the combined load.
   */
  public async findStaffPrincipalByEmail(
    email: string
  ): Promise<{
    user: UserRecord;
    roles: string[];
    permissions: string[];
    twoFactorPolicy: TwoFactorPolicyRecord[];
  } | null> {
    const user = await this.findUserByEmail(email);
    if (!user) return null;
    const rows = await this.targetedRows(
      `SELECT r."key" AS role_key, p."key" AS permission_key
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = [...new Set(rows.map((r) => String(r["role_key"])))];
    const permissions = [
      ...new Set(
        rows
          .map((r) => r["permission_key"])
          .filter((k): k is string => typeof k === "string")
      ),
    ];
    const policyRows = this.capabilities.authEmailTables
      ? await this.targetedRows(
          `SELECT id, scope, mode, updated_at FROM auth_two_factor_policy ORDER BY scope ASC`
        )
      : [];
    const twoFactorPolicy: TwoFactorPolicyRecord[] = policyRows.map((row) => ({
      id: reqStr(row, "id", "auth_two_factor_policy"),
      scope: reqStr(row, "scope", "auth_two_factor_policy"),
      mode: asEnum(
        str(row, "mode"),
        ["off", "optional", "required"] as const,
        "off"
      ),
      updated_at: reqIso(row, "updated_at", "auth_two_factor_policy"),
    }));
    return { user, roles, permissions, twoFactorPolicy };
  }

  /**
   * License validation hot path: the license row by key hash + its
   * entitlement snapshots (+ items), activations, product code, and
   * underlying subscription status — ONE statement (was 1 + 5
   * serialized lookups). Mirrors the license mapping in
   * loadStateInternalImpl. The mutation half of validate/activate
   * (last_seen_at, seat changes) still goes through withTransaction —
   * this read fast path is for the lookup + checks.
   *
   * B-01 Track A (2026-11-27) — single-statement merges. A single
   * pg Client executes queries strictly in call order, so Promise.all
   * over one store's client saves ZERO round trips (proven locally:
   * 2x pg_sleep(0.25) takes ~600ms sequential AND under Promise.all
   * on one client, ~300ms on two clients). The RTT win therefore
   * comes from merging, not fan-out:
   *  - `keyHashes` takes BOTH candidate hashes (v2 then v1) in one
   *    statement (`= ANY($1)` + `array_position` preference) instead
   *    of the service's sequential v2-then-v1 loop: invalid-key and
   *    legacy-v1 validations drop from 2 lookup RTTs to 1. A single
   *    string still works (back-compat for existing callers/tests).
   *  - `includeSigningKeyFingerprint` appends the M-16 signing-key
   *    fingerprint as a column of the SAME statement (string_agg over
   *    signing_keys, byte-identical to signingKeysFingerprint), so
   *    the validate path pays no separate fingerprint RTT at store
   *    creation — see ensureSigningKeys + the createTargeted
   *    deferral. Default off: other callers pay nothing for it.
   */
  public async findLicenseForValidation(
    keyHashes: string | string[],
    opts?: { includeSigningKeyFingerprint?: boolean }
  ): Promise<{
    license: LicenseRecord;
    productCode: string;
    subscriptionStatus: string | null;
    /**
     * The M-16 signing-key fingerprint, only when
     * `includeSigningKeyFingerprint` was set; null otherwise.
     */
    signingKeyFingerprint: string | null;
  } | null> {
    const hashes = Array.isArray(keyHashes) ? keyHashes : [keyHashes];
    const licenseRows = await this.targetedRows(
      `SELECT l.id, l.license_number, l.product_id, l.customer_id, l.source_order_item_id,
              l.subscription_id, l.license_key_hash, l.license_key_hint, l.status,
              l.activation_limit, l.valid_from, l.expires_at, l.grace_until,
              l.current_entitlement_snapshot_id, l.issued_at, l.created_at, l.updated_at,
              p.code AS product_code,
              s.status AS subscription_status,
              COALESCE((SELECT json_agg(sn ORDER BY sn.version_number ASC) FROM (
                 SELECT sn2.*,
                        COALESCE((SELECT json_agg(it ORDER BY it.feature_key_snapshot)
                                    FROM license_entitlement_snapshot_items it
                                   WHERE it.snapshot_id = sn2.id), '[]'::json) AS items
                   FROM license_entitlement_snapshots sn2
                  WHERE sn2.license_id = l.id
              ) sn), '[]'::json) AS snapshots,
              COALESCE((SELECT json_agg(a ORDER BY a.activated_at ASC, a.id ASC)
                          FROM license_activations a
                         WHERE a.license_id = l.id), '[]'::json) AS activations${
        opts?.includeSigningKeyFingerprint
          ? `,
              COALESCE((SELECT string_agg(k.key_id || ':' || k.status || ':' || k.ct_hash, '|' ORDER BY k.key_id ASC)
                          FROM (SELECT key_id, status, md5(COALESCE(encrypted_private_jwk, '')) AS ct_hash
                                  FROM signing_keys WHERE status <> 'revoked') k), '') AS signing_key_fingerprint`
          : ""
      }
         FROM licenses l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN subscriptions s ON s.id = l.subscription_id
        WHERE l.license_key_hash = ANY($1::text[])
        ORDER BY array_position($1::text[], l.license_key_hash)
        LIMIT 1`,
      [hashes]
    );
    const licenseRow = licenseRows[0];
    if (!licenseRow) return null;
    const licenseId = reqStr(licenseRow, "id", "licenses");
    const snapshotRows = asJsonArray<Row>(licenseRow, "snapshots");
    const activationRows = asJsonArray<Row>(licenseRow, "activations");

    const snapshots: LicenseEntitlementSnapshotRecord[] = snapshotRows.map((s) => {
      const snapId = reqStr(s, "id", "license_entitlement_snapshots");
      return {
        id: snapId,
        license_id: licenseId,
        version_number: reqNum(s, "version_number", "license_entitlement_snapshots"),
        source_type: asEnum(
          str(s, "source_type"),
          ["order_item", "subscription_period", "manual_grant", "admin_adjustment"] as const,
          "manual_grant"
        ),
        effective_at: reqIso(s, "effective_at", "license_entitlement_snapshots"),
        reason: str(s, "reason"),
        snapshot_hash: reqStr(s, "snapshot_hash", "license_entitlement_snapshots"),
        items: asJsonArray<Row>(s, "items").map((it) => ({
          feature_key_snapshot: reqStr(
            it,
            "feature_key_snapshot",
            "license_entitlement_snapshot_items"
          ),
          value_type_snapshot: asEnum(
            str(it, "value_type_snapshot"),
            ["boolean", "limit", "quota", "metered"] as const,
            "boolean"
          ),
          entitlement_value: it["entitlement_value"] ?? null,
          unit_snapshot: str(it, "unit_snapshot"),
        })),
        created_by_user_id: str(s, "created_by_user_id"),
        created_at: reqIso(s, "created_at", "license_entitlement_snapshots"),
      };
    });
    const activations: LicenseActivationRecord[] = activationRows.map((a) => ({
      id: reqStr(a, "id", "license_activations"),
      license_id: licenseId,
      installation_id_hash: reqStr(a, "installation_id_hash", "license_activations"),
      domain_normalized: str(a, "domain_normalized"),
      environment: asEnum(
        str(a, "environment"),
        ["production", "staging", "development", "other"] as const,
        "production"
      ),
      status: asEnum(
        str(a, "status"),
        ["active", "deactivated", "blocked"] as const,
        "active"
      ),
      activated_at: reqIso(a, "activated_at", "license_activations"),
      last_seen_at: iso(a, "last_seen_at") ?? reqIso(a, "activated_at", "license_activations"),
      deactivated_at: iso(a, "deactivated_at"),
      metadata: asJsonObject(a, "metadata"),
      created_at: reqIso(a, "created_at", "license_activations"),
    }));
    const license: LicenseRecord = {
      id: licenseId,
      license_number: reqStr(licenseRow, "license_number", "licenses"),
      product_id: reqStr(licenseRow, "product_id", "licenses"),
      customer_id: reqStr(licenseRow, "customer_id", "licenses"),
      source_order_item_id: str(licenseRow, "source_order_item_id"),
      subscription_id: str(licenseRow, "subscription_id"),
      license_key_hash: reqStr(licenseRow, "license_key_hash", "licenses"),
      license_key_hint: reqStr(licenseRow, "license_key_hint", "licenses"),
      status: asEnum(
        str(licenseRow, "status"),
        ["pending", "active", "expired", "suspended", "revoked"] as const,
        "pending"
      ),
      activation_limit: reqNum(licenseRow, "activation_limit", "licenses"),
      valid_from: reqIso(licenseRow, "valid_from", "licenses"),
      expires_at: iso(licenseRow, "expires_at"),
      grace_until: iso(licenseRow, "grace_until"),
      current_entitlement_snapshot_id:
        str(licenseRow, "current_entitlement_snapshot_id") ?? snapshots[0]?.id ?? "",
      snapshots,
      activations,
      issued_at:
        iso(licenseRow, "issued_at") ?? reqIso(licenseRow, "created_at", "licenses"),
      created_at: reqIso(licenseRow, "created_at", "licenses"),
      updated_at: reqIso(licenseRow, "updated_at", "licenses"),
    };
    return {
      license,
      productCode: str(licenseRow, "product_code") ?? "",
      subscriptionStatus: str(licenseRow, "subscription_status"),
      signingKeyFingerprint: str(licenseRow, "signing_key_fingerprint"),
    };
  }

  /**
   * One integrated site by site key, with domains + product ids — ONE
   * statement (was 1 + 2 serialized lookups). The product-ids column
   * keeps the old query's unspecified order (callers only use
   * `.includes()`); domains keep `created_at ASC, id ASC`.
   */
  public async findIntegratedSiteByKey(siteKey: string): Promise<IntegratedSiteRecord | null> {
    const siteRows = await this.targetedRows(
      `SELECT s.id, s.site_key, s.name, s.environment, s.status, s.api_version,
              s.allowed_capabilities, s.created_at, s.updated_at,
              COALESCE((SELECT json_agg(sp)
                          FROM site_products sp
                         WHERE sp.integrated_site_id = s.id), '[]'::json) AS product_ids,
              COALESCE((SELECT json_agg(d ORDER BY d.created_at ASC, d.id ASC)
                          FROM site_domains d
                         WHERE d.integrated_site_id = s.id), '[]'::json) AS domains
         FROM integrated_sites s WHERE s.site_key = $1 LIMIT 1`,
      [siteKey]
    );
    const siteRow = siteRows[0];
    if (!siteRow) return null;
    const siteId = reqStr(siteRow, "id", "integrated_sites");
    const productRows = asJsonArray<Row>(siteRow, "product_ids");
    const domainRows = asJsonArray<Row>(siteRow, "domains");
    return {
      id: siteId,
      site_key: reqStr(siteRow, "site_key", "integrated_sites"),
      name: reqStr(siteRow, "name", "integrated_sites"),
      environment: asEnum(
        str(siteRow, "environment"),
        ["production", "staging", "development"] as const,
        "production"
      ),
      status: asEnum(
        str(siteRow, "status"),
        ["pending_verification", "active", "suspended", "revoked"] as const,
        "pending_verification"
      ),
      api_version: reqStr(siteRow, "api_version", "integrated_sites"),
      allowed_capabilities: asJsonArray<string>(siteRow, "allowed_capabilities"),
      product_ids: productRows.map((r) => String(r["product_id"])),
      domains: domainRows.map((d) => ({
        id: reqStr(d, "id", "site_domains"),
        domain: reqStr(d, "domain", "site_domains"),
        verification_method: asEnum(
          str(d, "verification_method"),
          ["dns_txt", "http_file", "manual_review"] as const,
          "dns_txt"
        ),
        verification_challenge: reqStr(d, "verification_challenge", "site_domains"),
        verification_status: asEnum(
          str(d, "verification_status"),
          ["pending", "verified", "failed"] as const,
          "pending"
        ),
        verified_at: iso(d, "verified_at"),
        is_primary: bool(d, "is_primary"),
      })),
      created_at: reqIso(siteRow, "created_at", "integrated_sites"),
      updated_at: reqIso(siteRow, "updated_at", "integrated_sites"),
    };
  }

  /**
   * Public catalog hot path: active products (+ channels), product
   * features, active packages, published versions (+ feature grants),
   * active prices — ONE statement (was 7 serialized queries). Only
   * the rows a public catalog / checkout read ever needs — no orders,
   * customers, audit, outbox, sessions, or any other table.
   *
   * OD-04: the catalog is the ONE read wired to HYPERDRIVE_CACHED
   * (ADR-0005 §2 — public, read-heavy, 60s-staleness-tolerant).
   * `opts.cachedConnectionString` (passed by the public routes from
   * env.HYPERDRIVE_CACHED) routes the identical SQL through the
   * cached client; see catalogRows for the fallback rules and the
   * honest `cachedQueries` accounting. The SQL and the row mapping
   * below are unchanged — only the transport varies. Auth, finance,
   * and license reads never come here and stay uncached.
   */
  public async loadPublicCatalog(opts?: LoadPublicCatalogOptions): Promise<{
    products: ProductRecord[];
    product_features: ProductFeatureRecord[];
    product_packages: ProductPackageRecord[];
    package_versions: PackageVersionRecord[];
    package_prices: PackagePriceRecord[];
  }> {
    const rows = await this.catalogRows(
      `SELECT
         COALESCE((SELECT json_agg(t) FROM (SELECT product_id, channel_key FROM product_distribution_channels) t), '[]'::json) AS channels,
         COALESCE((SELECT json_agg(t ORDER BY t.created_at ASC, t.id ASC) FROM (
            SELECT id, code, slug, name, description, product_type, fulfillment_type,
                   status, website_url, documentation_url, logo_asset_id, created_by_user_id,
                   created_at, updated_at
                   ${this.capabilities.productsDefaults ? ", default_activation_limit, offline_grace_hours" : ""}
              FROM products WHERE status = 'active'
         ) t), '[]'::json) AS products,
         COALESCE((SELECT json_agg(t ORDER BY t.created_at ASC, t.id ASC) FROM (
            SELECT id, product_id, feature_key, name, description, value_type, unit,
                   default_value, status, created_at, updated_at
              FROM product_features
         ) t), '[]'::json) AS features,
         COALESCE((SELECT json_agg(t ORDER BY t.created_at ASC, t.id ASC) FROM (
            SELECT id, product_id, package_key, name, description, status,
                   created_at, updated_at
                   ${this.capabilities.packagesCurrentVersion ? ", current_version_id" : ""}
              FROM product_packages WHERE status = 'active'
         ) t), '[]'::json) AS packages,
         COALESCE((SELECT json_agg(t ORDER BY t.created_at ASC, t.id ASC) FROM (
            SELECT id, package_id, product_id, version_number, status,
                   change_summary, published_at, created_at
              FROM package_versions WHERE status = 'published'
         ) t), '[]'::json) AS versions,
         COALESCE((SELECT json_agg(t ORDER BY t.package_version_id, t.feature_key_snapshot) FROM (
            SELECT id, package_version_id, product_id, product_feature_id,
                   feature_key_snapshot, value_type_snapshot, entitlement_value
                   ${this.capabilities.packageVersionFeaturesUnit ? ", unit_snapshot" : ""}
              FROM package_version_features
         ) t), '[]'::json) AS grants,
         COALESCE((SELECT json_agg(t ORDER BY t.created_at ASC, t.id ASC) FROM (
            SELECT id, package_version_id, price_key, price_kind, amount_minor,
                   currency_code, interval_unit, interval_count, trial_days,
                   setup_fee_minor, status, created_at
                   ${this.capabilities.packagePricesUsedInOrders ? ", used_in_orders" : ""}
              FROM package_prices WHERE status = 'active'
         ) t), '[]'::json) AS prices`,
      opts?.cachedConnectionString
    );
    const row = rows[0];
    if (!row) {
      return {
        products: [],
        product_features: [],
        product_packages: [],
        package_versions: [],
        package_prices: [],
      };
    }
    const channelRows = asJsonArray<Row>(row, "channels");
    const productRows = asJsonArray<Row>(row, "products");
    const featureRows = asJsonArray<Row>(row, "features");
    const packageRows = asJsonArray<Row>(row, "packages");
    const versionRows = asJsonArray<Row>(row, "versions");
    const grantRows = asJsonArray<Row>(row, "grants");
    const priceRows = asJsonArray<Row>(row, "prices");
    const channelsByProduct = groupBy(channelRows, (r) => String(r["product_id"]));
    const products: ProductRecord[] = productRows.map((row) => {
      const id = reqStr(row, "id", "products");
      return {
        id,
        code: reqStr(row, "code", "products"),
        slug: reqStr(row, "slug", "products"),
        name: reqStr(row, "name", "products"),
        description: str(row, "description"),
        product_type: reqStr(row, "product_type", "products"),
        fulfillment_type: reqStr(row, "fulfillment_type", "products"),
        distribution_channels: (channelsByProduct.get(id) ?? []).map((r) =>
          String(r["channel_key"])
        ),
        default_activation_limit: this.capabilities.productsDefaults
          ? reqNum(row, "default_activation_limit", "products")
          : 1,
        offline_grace_hours: this.capabilities.productsDefaults
          ? reqNum(row, "offline_grace_hours", "products")
          : 72,
        status: asEnum(
          str(row, "status"),
          ["draft", "active", "archived"] as const,
          "draft"
        ),
        website_url: str(row, "website_url"),
        documentation_url: str(row, "documentation_url"),
        // E-13: same gap as the full load — the public-catalog fast
        // path must mirror the load mapping column-for-column.
        logo_asset_id: str(row, "logo_asset_id"),
        created_by_user_id: str(row, "created_by_user_id"),
        created_at: reqIso(row, "created_at", "products"),
        updated_at: reqIso(row, "updated_at", "products"),
      };
    });
    const product_features: ProductFeatureRecord[] = featureRows.map((row) => ({
      id: reqStr(row, "id", "product_features"),
      product_id: reqStr(row, "product_id", "product_features"),
      feature_key: reqStr(row, "feature_key", "product_features"),
      name: reqStr(row, "name", "product_features"),
      description: str(row, "description"),
      value_type: asEnum(
        str(row, "value_type"),
        ["boolean", "limit", "quota", "metered"] as const,
        "boolean"
      ),
      unit: str(row, "unit"),
      default_value: row["default_value"] ?? null,
      status: asEnum(str(row, "status"), ["active", "archived"] as const, "active"),
      created_at: reqIso(row, "created_at", "product_features"),
      updated_at: reqIso(row, "updated_at", "product_features"),
    }));
    const product_packages: ProductPackageRecord[] = packageRows.map((row) => ({
      id: reqStr(row, "id", "product_packages"),
      product_id: reqStr(row, "product_id", "product_packages"),
      package_key: reqStr(row, "package_key", "product_packages"),
      name: reqStr(row, "name", "product_packages"),
      description: str(row, "description"),
      status: asEnum(
        str(row, "status"),
        ["draft", "active", "archived"] as const,
        "draft"
      ),
      current_version_id: this.capabilities.packagesCurrentVersion
        ? str(row, "current_version_id")
        : null,
      created_at: reqIso(row, "created_at", "product_packages"),
      updated_at: reqIso(row, "updated_at", "product_packages"),
    }));
    const grantsByVersion = groupBy(grantRows, (r) =>
      String(r["package_version_id"])
    );
    const package_versions: PackageVersionRecord[] = versionRows.map((row) => {
      const id = reqStr(row, "id", "package_versions");
      const features: PackageVersionFeatureGrant[] = (
        grantsByVersion.get(id) ?? []
      ).map((g) => ({
        id: reqStr(g, "id", "package_version_features"),
        package_version_id: id,
        product_id: reqStr(g, "product_id", "package_version_features"),
        product_feature_id: reqStr(g, "product_feature_id", "package_version_features"),
        feature_key_snapshot: reqStr(g, "feature_key_snapshot", "package_version_features"),
        value_type_snapshot: asEnum(
          str(g, "value_type_snapshot"),
          ["boolean", "limit", "quota", "metered"] as const,
          "boolean"
        ),
        entitlement_value: g["entitlement_value"] ?? null,
        unit_snapshot: this.capabilities.packageVersionFeaturesUnit
          ? str(g, "unit_snapshot")
          : null,
      }));
      return {
        id,
        package_id: reqStr(row, "package_id", "package_versions"),
        product_id: reqStr(row, "product_id", "package_versions"),
        version_number: reqNum(row, "version_number", "package_versions"),
        status: asEnum(
          str(row, "status"),
          ["draft", "published", "retired"] as const,
          "draft"
        ),
        change_summary: str(row, "change_summary"),
        features,
        published_at: iso(row, "published_at"),
        created_at: reqIso(row, "created_at", "package_versions"),
      };
    });
    const package_prices: PackagePriceRecord[] = priceRows.map((row) => ({
      id: reqStr(row, "id", "package_prices"),
      package_version_id: reqStr(row, "package_version_id", "package_prices"),
      price_key: reqStr(row, "price_key", "package_prices"),
      price_kind: asEnum(
        str(row, "price_kind"),
        ["free", "one_time", "recurring", "lifetime"] as const,
        "one_time"
      ),
      amount_minor: reqNum(row, "amount_minor", "package_prices"),
      currency_code: reqStr(row, "currency_code", "package_prices"),
      interval_unit: asEnumOrNull(str(row, "interval_unit"), [
        "day",
        "week",
        "month",
        "year",
      ] as const),
      interval_count: num(row, "interval_count"),
      trial_days: reqNum(row, "trial_days", "package_prices"),
      setup_fee_minor: reqNum(row, "setup_fee_minor", "package_prices"),
      status: asEnum(
        str(row, "status"),
        ["active", "inactive", "retired"] as const,
        "active"
      ),
      used_in_orders: this.capabilities.packagePricesUsedInOrders
        ? bool(row, "used_in_orders")
        : false,
      created_at: reqIso(row, "created_at", "package_prices"),
    }));
    return { products, product_features, product_packages, package_versions, package_prices };
  }

  private mapOutboxRow(row: Row): OutboxEventRecord {
    return {
      id: reqStr(row, "id", "outbox_events"),
      event_key: reqStr(row, "event_key", "outbox_events"),
      aggregate_type: reqStr(row, "aggregate_type", "outbox_events"),
      aggregate_id: reqStr(row, "aggregate_id", "outbox_events"),
      event_type: reqStr(row, "event_type", "outbox_events"),
      payload: asJsonObject(row, "payload"),
      status: asEnum(
        str(row, "status"),
        ["pending", "processing", "delivered", "dead_letter", "simulated", "skipped"] as const,
        "pending"
      ),
      attempt_count: reqNum(row, "attempt_count", "outbox_events"),
      available_at: reqIso(row, "available_at", "outbox_events"),
      locked_until: iso(row, "locked_until"),
      locked_by: str(row, "locked_by"),
      last_error_code: str(row, "last_error_code"),
      created_at: reqIso(row, "created_at", "outbox_events"),
      processed_at: iso(row, "processed_at"),
    };
  }

  /**
   * C-05 (real SQL claim): lease a batch of due outbox events with
   * row-level locking — ONE statement, no full-state load, no
   * advisory-lock serialisation of the whole drain. `FOR UPDATE SKIP
   * LOCKED` lets two concurrent drains split the batch instead of
   * contending on the global writer lock; the eligible set is ordered
   * explicitly by `available_at, created_at` (the old in-memory claim
   * relied on the load query's ordering). Claimed rows come back as
   * `processing` with the attempt count already incremented.
   */
  public async claimOutboxEvents(
    batchSize: number,
    workerId: string,
    leaseMs = 60_000
  ): Promise<OutboxEventRecord[]> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      this.queryMetrics.uncachedQueries += 1;
      const res = await this.pgClient.query(
        `UPDATE outbox_events SET status = 'processing',
               locked_by = $2,
               locked_until = NOW() + ($3 * INTERVAL '1 millisecond'),
               attempt_count = attempt_count + 1
          WHERE id IN (
            SELECT id FROM outbox_events
             WHERE (status = 'pending' AND available_at <= NOW())
                OR (status = 'processing' AND locked_until IS NOT NULL AND locked_until <= NOW())
             ORDER BY available_at ASC, created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, event_key, aggregate_type, aggregate_id, event_type, payload,
            status, attempt_count, available_at, locked_until, locked_by,
            last_error_code, created_at, processed_at`,
        [batchSize, workerId, leaseMs]
      );
      const claimed = (res.rows as unknown as Row[]).map((r) => this.mapOutboxRow(r));
      // UPDATE ... RETURNING has no defined row order — the subquery
      // picks the right SET, but the drain must process in claim
      // order (available_at, created_at), so sort here (batch ≤ 25).
      claimed.sort(
        (a, b) =>
          new Date(a.available_at).getTime() - new Date(b.available_at).getTime() ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      return claimed;
    } finally {
      release();
    }
  }

  /**
   * B-12: delete ONLY expiry-defined rows — idempotency records past
   * their 24h `expires_at`, expired rate-limit buckets, expired
   * sessions, expired request nonces. Audit / tracking / outbox /
   * financial rows are NEVER touched here (OD-01 retention decision
   * pending). Each table deletes at most `limitPerTable` rows per
   * call, so a cron tick stays cheap. Returns the per-table counts.
   */
  public async cleanupExpiredRows(
    limitPerTable = 1000
  ): Promise<Record<string, number>> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      const counts: Record<string, number> = {};
      const prune = async (table: string, where: string): Promise<number> => {
        const res = await this.pgClient.query(
          `DELETE FROM "${table}" WHERE id IN (
             SELECT id FROM "${table}" WHERE ${where} LIMIT $1
           )`,
          [limitPerTable]
        );
        this.queryMetrics.uncachedQueries += 1;
        return res.rowCount ?? 0;
      };
      // rate_limit_buckets has no `id` column — delete by its natural
      // key instead.
      const pruneByKey = async (
        table: string,
        keyColumn: string,
        where: string
      ): Promise<number> => {
        const res = await this.pgClient.query(
          `DELETE FROM "${table}" WHERE "${keyColumn}" IN (
             SELECT "${keyColumn}" FROM "${table}" WHERE ${where} LIMIT $1
           )`,
          [limitPerTable]
        );
        this.queryMetrics.uncachedQueries += 1;
        return res.rowCount ?? 0;
      };
      counts["idempotency_records"] = await prune(
        "idempotency_records",
        "expires_at < NOW()"
      );
      counts["rate_limit_buckets"] = await pruneByKey(
        "rate_limit_buckets",
        "key",
        "reset_at <= NOW()"
      );
      counts["sessions"] = await prune("sessions", "expires_at < NOW()");
      // request_nonces: `nonce` alone is not unique across
      // credentials — delete by the composite key.
      const nonceRes = await this.pgClient.query(
        `DELETE FROM "request_nonces" WHERE (credential_id, nonce) IN (
           SELECT credential_id, nonce FROM "request_nonces"
            WHERE expires_at < NOW() LIMIT $1
         )`,
        [limitPerTable]
      );
      this.queryMetrics.uncachedQueries += 1;
      counts["request_nonces"] = nonceRes.rowCount ?? 0;
      return counts;
    } finally {
      release();
    }
  }

  /**
   * A-07: readiness probe for the DB-backed rate limiter — true when
   * the `rate_limit_buckets` table (migration 0016) exists. The cron /
   * boot path can call this and fail loudly instead of silently
   * running on the in-memory fallback.
   */
  public async rateLimitTableExists(): Promise<boolean> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    try {
      const rows = await queryRows(
        this.pgClient,
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'rate_limit_buckets'
          LIMIT 1`
      );
      return rows.length > 0;
    } finally {
      release();
    }
  }

  private async loadStateInternal(client: Client): Promise<void> {
    this.state = await loadStateInternalImpl(client, this.capabilities);
    // A-11: the state is fresh as of this load — a principal lookup
    // in the same request must not pay for a second full load.
    this.loadedAtMs = Date.now();
  }

  /**
   * Transactional unit of work, mirroring the base class contract:
   * serialized writers, snapshot rollback on error, idempotency + outbox
   * covered because they flow through fn(state).
   *
   * BEGIN → pg_advisory_xact_lock(727271) → reload state from inside the
   * transaction → fn(state) → diff-persist the mutated state back to the
   * DB in the SAME transaction → COMMIT. On any error: ROLLBACK and
   * restore this.state to the pre-transaction snapshot.
   */
  public override async withTransaction<T>(
    fn: (state: DatabaseState) => Promise<T> | T
  ): Promise<T> {
    this.assertOpen();
    const release = await this.acquireStoreLock();
    const client = this.pgClient;
    let begun = false;
    // B-04: ONE parse of the snapshot. The parsed `before` object is
    // the rollback target too — the old code stringified once, parsed
    // for the diff, and parsed AGAIN on rollback, so every transaction
    // paid two whole-state JSON parses (CPU + memory ∝ total DB size).
    let before: DatabaseState | null = null;
    try {
      this.queryMetrics.uncachedQueries += 1;
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITER_ADVISORY_LOCK_KEY]);
      await this.loadStateInternal(client);
      before = JSON.parse(JSON.stringify(this.state)) as DatabaseState;
      const result = await fn(this.state);
      await persistStateDiff(client, this.capabilities, before, this.state);
      await client.query("COMMIT");
      begun = false;
      this.queryMetrics.transactionsCommitted += 1;
      return result;
    } catch (error) {
      if (begun) {
        await client.query("ROLLBACK").catch(() => {});
        this.queryMetrics.transactionsRolledBack += 1;
      }
      if (before !== null) {
        this.state = before;
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Fail-closed accessor for upload paths: throws when no real R2 bucket
   * was provided at create() time. Production wiring should call this
   * before serving payment-evidence uploads instead of using
   * `store.r2Bucket` directly.
   */
  public requireRealBucket(): R2BucketBinding {
    if (this.usesInMemoryBucket) {
      throw new Error(
        "DrizzleStore: no real R2 bucket was provided (usesInMemoryBucket is true). Payment-evidence uploads must fail closed: pass env.R2_BUCKET to DrizzleStore.create() and check usesInMemoryBucket before serving uploads."
      );
    }
    return this.r2Bucket;
  }

  /**
   * End this store's pg client — or, under B-01 reuse, return it to
   * the connection cache. Idempotent; the store must not be used
   * afterwards. A leased client is released synchronously (the lease
   * flag flips before any await, while this request still owns it);
   * a fresh client is parked as the idle entry when the slot is free,
   * otherwise ended exactly as before. The Worker entrypoint calls
   * this when the request finishes (see apps/api/src/app.ts
   * closeRequestStore).
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // OD-04: release/park the cached catalog client first, under the
    // same lease rules as the main client (leased → release, fresh →
    // park when the slot is free, else end). Must run before the
    // early returns of the main-client handling below.
    const cached = this.cachedPgClient;
    if (cached) {
      const cachedConnStr = this.cachedConnectionString;
      this.cachedPgClient = null;
      this.cachedConnectionString = null;
      if (this.cachedLeasedConnection) {
        this.cachedLeasedConnection = false;
        releaseCachedClient(cached);
      } else if (
        cachedConnStr !== null &&
        parkCachedClient(cachedConnStr, cached)
      ) {
        // Parked for the next catalog read; do not end.
      } else {
        await cached.end().catch(() => {});
      }
    }
    if (this.leasedConnection) {
      this.leasedConnection = false;
      releaseCachedClient(this.pgClient);
      return;
    }
    if (
      this.cacheConnectionString !== null &&
      parkCachedClient(this.cacheConnectionString, this.pgClient)
    ) {
      return;
    }
    await this.pgClient.end().catch(() => {});
  }

  /** Alias for close(). */
  public async dispose(): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        "DrizzleStore is closed; create a new store with DrizzleStore.create()."
      );
    }
  }

  /**
   * Serialize operations on THIS store's client (see the `storeQueue`
   * field comment). The tail promise never rejects — `release` only
   * ever resolves it — so awaiting `prev` cannot throw.
   */
  private async acquireStoreLock(): Promise<() => void> {
    let release!: () => void;
    const prev = this.storeQueue;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.storeQueue = next;
    await prev;
    return release;
  }

}

// ---------------------------------------------------------------------------
// Loading (SELECT every mapped table into the inherited DatabaseState shape)
// ---------------------------------------------------------------------------

/** Derive counters from the highest existing human numbers in the data. */
function deriveCountersFromData(
  state: DatabaseState
): DatabaseState["sequence_counters"] {
  const maxSuffix = (values: string[]): number => {
    let max = 0;
    for (const v of values) {
      const m = /(\d+)$/.exec(v);
      if (m?.[1] !== undefined) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
    return max;
  };
  return {
    customer: Math.max(
      COUNTER_BASE_VALUES.customer,
      maxSuffix(state.customers.map((c) => c.customer_number))
    ),
    order: Math.max(
      COUNTER_BASE_VALUES.order,
      maxSuffix(state.orders.map((o) => o.order_number))
    ),
    invoice: Math.max(
      COUNTER_BASE_VALUES.invoice,
      maxSuffix(state.invoices.map((i) => i.invoice_number))
    ),
    subscription: Math.max(
      COUNTER_BASE_VALUES.subscription,
      maxSuffix(state.subscriptions.map((s) => s.subscription_number))
    ),
    license: Math.max(
      COUNTER_BASE_VALUES.license,
      maxSuffix(state.licenses.map((l) => l.license_number))
    ),
    ticket: Math.max(
      COUNTER_BASE_VALUES.ticket,
      maxSuffix(state.support_tickets.map((t) => t.ticket_number))
    ),
    lead: Math.max(
      COUNTER_BASE_VALUES.lead,
      maxSuffix(state.leads.map((l) => l.lead_number))
    ),
  };
}

/**
 * The full-state load as ONE round-trip (perf, 2026-11-15): every mapped
 * table is fetched as a JSON array in a single statement instead of ~48
 * sequential queryRows calls. A single pg Client executes queries in
 * call order and cannot parallelize them, so the only way to cut the
 * round-trips on one pinned connection is to fetch everything at once.
 *
 * Each entry's SQL is the pre-refactor SELECT verbatim (same columns,
 * same caps interpolations); its ORDER BY moved into the json_agg call,
 * where it is guaranteed (an ORDER BY inside the subquery is NOT
 * guaranteed to survive aggregation). Mapping code below is unchanged:
 * rows arrive as parsed JSON values and the existing row-mapping
 * helpers already accept them (numbers stay numbers, timestamptz
 * arrives as an ISO string — see iso(), which normalizes it).
 * The sequence_counters column is included only when the capability
 * exists (migration 0002); otherwise counters are derived from the
 * data exactly as before.
 */
interface LoadQuery {
  key: string;
  sql: string;
  orderBy: string | null;
}

function buildLoadStateQuery(caps: StoreCapabilities): string {
  const queries: LoadQuery[] = [
    { key: "users", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT u.id, u.name, u.email, u.email_verified, u.created_at, u.updated_at,
            sp.status AS staff_status
            ${caps.usersPasswordHash ? ", u.password_hash" : ""}
            ${caps.usersTwoFactorEnabled ? ", u.two_factor_enabled" : ""}
            ${caps.usersAvatarUrl ? ", u.avatar_url" : ""}
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id` },
    { key: "sessions", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, token, user_id, ip_address, user_agent, expires_at, created_at
       FROM sessions` },
    { key: "roles", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, "key", name, description, is_system, created_at
       FROM roles` },
    { key: "rolePerms", orderBy: null, sql: `SELECT rp.role_id, p."key" AS permission_key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id` },
    { key: "userRoles", orderBy: "t.created_at ASC, t.user_id ASC, t.role_id ASC", sql: `SELECT user_id, role_id, created_at FROM user_roles` },
    { key: "staffInvitations", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, email, name, role_keys, token_hash, status,
            expires_at, invited_by_user_id, accepted_user_id, accepted_at,
            revoked_at, created_at, updated_at
       FROM staff_invitations` },
    { key: "currencies", orderBy: null, sql: `SELECT code FROM currencies` },
    { key: "assets", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, object_key, bucket_name, original_filename, content_type,
            byte_size, checksum_sha256, visibility, uploaded_by_user_id,
            owner_customer_id, created_at
       FROM uploaded_assets` },
    { key: "mediaAssets", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, object_key, driver, original_filename, mime_type,
            byte_size, checksum_sha256, width, height, folder, tags,
            uploaded_by_user_id, created_at, updated_at
       FROM media_assets` },
    { key: "customers", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, customer_number, customer_type, name, email, normalized_email,
            phone, normalized_phone, whatsapp, credit_balance_minor,
            company_name, website, country_code, status,
            registration_source, notes, created_at, updated_at
       FROM customers` },
    { key: "customerContacts", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, customer_id, kind, value, normalized_value, created_at
       FROM customer_contacts` },
    { key: "customerAddresses", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, customer_id, address_type, contact_name, phone,
            address_line_1, address_line_2, city, state_or_region,
            postal_code, country_code, is_default, created_at, updated_at
       FROM customer_addresses` },
    { key: "customerReports", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, customer_id, author_user_id, type, detail, created_at
       FROM customer_reports` },
    { key: "channels", orderBy: "t.product_id, t.channel_key", sql: `SELECT product_id, channel_key FROM product_distribution_channels` },
    { key: "products", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, code, slug, name, description, product_type, fulfillment_type,
            status, website_url, documentation_url, logo_asset_id, created_by_user_id,
            created_at, updated_at
            ${caps.productsDefaults ? ", default_activation_limit, offline_grace_hours" : ""}
       FROM products` },
    { key: "features", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, product_id, feature_key, name, description, value_type, unit,
            default_value, status, created_at, updated_at
       FROM product_features` },
    { key: "packages", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, product_id, package_key, name, description, status,
            created_at, updated_at
            ${caps.packagesCurrentVersion ? ", current_version_id" : ""}
       FROM product_packages` },
    { key: "versionFeatures", orderBy: "t.package_version_id, t.feature_key_snapshot", sql: `SELECT id, package_version_id, product_id, product_feature_id,
            feature_key_snapshot, value_type_snapshot, entitlement_value
            ${caps.packageVersionFeaturesUnit ? ", unit_snapshot" : ""}
       FROM package_version_features` },
    { key: "versions", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, package_id, product_id, version_number, status,
            change_summary, published_at, created_at
       FROM package_versions` },
    { key: "prices", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, package_version_id, price_key, price_kind, amount_minor,
            currency_code, interval_unit, interval_count, trial_days,
            setup_fee_minor, status, created_at
            ${caps.packagePricesUsedInOrders ? ", used_in_orders" : ""}
       FROM package_prices` },
    { key: "siteProducts", orderBy: "t.integrated_site_id, t.product_id", sql: `SELECT integrated_site_id, product_id FROM site_products` },
    { key: "domains", orderBy: "t.integrated_site_id, t.created_at ASC, t.id ASC", sql: `SELECT id, integrated_site_id, domain, verification_method,
            verification_challenge, verification_status, verified_at, is_primary, created_at
       FROM site_domains` },
    { key: "sites", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, site_key, name, environment, status, api_version,
            allowed_capabilities, created_at, updated_at
       FROM integrated_sites` },
    { key: "credentials", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, integrated_site_id, key_id, credential_type, secret_hash,
            secret_ciphertext, encryption_key_version, scopes, status,
            created_at, revoked_at, last_used_at
       FROM site_credentials` },
    { key: "nonces", orderBy: "t.created_at ASC, t.credential_id ASC, t.nonce ASC", sql: `SELECT credential_id, nonce, expires_at, created_at FROM request_nonces` },
    { key: "attributions", orderBy: null, sql: `SELECT order_id, utm_source, utm_medium, utm_campaign, utm_content,
            utm_term, fbp, fbc FROM order_attributions` },
    { key: "orderSnapshotItems", orderBy: "t.snapshot_id, t.feature_key_snapshot", sql: `SELECT id, snapshot_id, feature_key_snapshot, value_type_snapshot,
            entitlement_value, unit_snapshot
       FROM order_item_entitlement_snapshot_items` },
    { key: "orderSnapshots", orderBy: null, sql: `SELECT id, order_item_id, source_type, source_package_version_id,
            schema_version, snapshot_hash, created_at
       FROM order_item_entitlement_snapshots` },
    { key: "orderItems", orderBy: "t.order_id, t.created_at ASC, t.id ASC", sql: `SELECT id, order_id, product_id, package_id, package_version_id,
            package_price_id, item_kind, fulfillment_type_snapshot,
            product_name_snapshot, package_name_snapshot,
            package_version_snapshot, price_kind_snapshot,
            interval_unit_snapshot, interval_count_snapshot,
            activation_limit_snapshot, quantity, unit_amount_minor,
            line_subtotal_minor, line_discount_minor, line_tax_minor,
            line_total_minor, currency_code, created_at
       FROM order_items` },
    { key: "orders", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, order_number, public_reference, customer_id, source,
            integrated_site_id, status, payment_status, currency_code,
            subtotal_minor, discount_minor, tax_minor, total_minor,
            customer_note, internal_note, created_by_user_id,
            activation_mode, activation_percent, activation_date,
            suspend_on_missed_schedule, grace_days, payment_method_id,
            lead_id, created_at,
            updated_at, completed_at, cancelled_at
       FROM orders` },
    { key: "orderInstallments", orderBy: "t.order_id, t.installment_number ASC", sql: `SELECT id, order_id, installment_number, amount_minor, due_date,
            status, paid_amount_minor, paid_at, notes, created_at, updated_at
       FROM order_installments` },
    { key: "periods", orderBy: "t.subscription_id, t.period_number ASC", sql: `SELECT id, subscription_id, period_number, period_start, period_end,
            status, renewal_order_id, invoice_id, payment_transaction_id,
            activated_at, created_at
       FROM subscription_periods` },
    { key: "subscriptions", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, subscription_number, customer_id, product_id,
            source_order_item_id, source_package_version_id, status,
            billing_kind, interval_unit, interval_count, currency_code,
            current_period_start, current_period_end, next_renewal_at,
            cancel_at_period_end, cancelled_at, created_at, updated_at,
            grace_days
            ${caps.subscriptionsUnitAmount ? ", unit_amount_minor" : ""}
       FROM subscriptions` },
    { key: "invoiceItems", orderBy: "t.invoice_id, t.created_at ASC, t.id ASC", sql: `SELECT id, invoice_id, description_snapshot, quantity,
            unit_amount_minor, line_amount_minor, currency_code, created_at
       FROM invoice_items` },
    { key: "invoices", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, invoice_number, customer_id, order_id, subscription_id,
            invoice_type, status, currency_code, subtotal_minor,
            discount_minor, tax_minor, total_minor, amount_paid_minor,
            amount_due_minor, issued_at, paid_at, created_at
       FROM invoices` },
    { key: "providers", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, provider_key, display_name, provider_type, adapter_key, status, created_at
       FROM payment_providers` },
    { key: "rails", orderBy: "t.payment_method_id, t.rail_key", sql: `SELECT payment_method_id, rail_key FROM payment_method_transfer_rails` },
    { key: "methods", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, provider_id, method_key, display_name, method_kind,
            account_type, account_label, instructions, configuration,
            is_enabled, sort_order, created_at
       FROM payment_methods` },
    { key: "submissions", orderBy: "t.submitted_at ASC, t.id ASC", sql: `SELECT id, order_id, customer_id, payment_method_id, installment_id, amount_minor,
            currency_code, sender_name, sender_phone, sender_bank_name,
            sender_account_reference, transfer_rail_key,
            transaction_reference, normalized_transaction_reference,
            payment_date, proof_asset_id, status, customer_note,
            submitted_at, reviewed_at, reviewed_by_user_id
            ${caps.paymentSubmissionsDuplicateWarning ? ", duplicate_risk_warning" : ""}
       FROM payment_submissions` },
    { key: "transactions", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, order_id, payment_method_id, payment_submission_id,
            provider_id, provider_transaction_id, amount_minor, currency_code,
            status, paid_at, verified_by_user_id, verification_source,
            created_at
       FROM payment_transactions` },
    { key: "verificationLogs", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, payment_submission_id, actor_user_id, decision, reason_code,
            customer_message, notes, created_at
       FROM payment_verification_logs` },
    { key: "refunds", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, payment_transaction_id, amount_minor, currency_code, status,
            reason, provider_refund_id, requested_by_user_id, processed_by_user_id,
            created_at, updated_at
       FROM payment_refunds` },
    { key: "expenseCategories", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, name, description, color, icon, parent_id, is_active,
            created_at, updated_at
       FROM expense_categories` },
    { key: "expenses", orderBy: "t.expense_date ASC, t.created_at ASC, t.id ASC", sql: `SELECT id, amount_minor, currency, expense_date, category_id, product_id,
            payment_method_id, vendor, notes, receipt_media_id, recorded_by,
            created_at, updated_at
       FROM expenses` },
    { key: "licenseSnapshotItems", orderBy: "t.snapshot_id, t.feature_key_snapshot", sql: `SELECT id, snapshot_id, feature_key_snapshot, value_type_snapshot,
            entitlement_value, unit_snapshot
       FROM license_entitlement_snapshot_items` },
    { key: "licenseSnapshots", orderBy: "t.license_id, t.version_number ASC", sql: `SELECT id, license_id, version_number, source_type, effective_at,
            reason, snapshot_hash, created_by_user_id, created_at
       FROM license_entitlement_snapshots` },
    { key: "activations", orderBy: "t.license_id, t.activated_at ASC, t.id ASC", sql: `SELECT id, license_id, installation_id_hash, domain_normalized,
            environment, status, activated_at, last_seen_at, deactivated_at,
            metadata, created_at
       FROM license_activations` },
    { key: "licenses", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, license_number, product_id, customer_id, source_order_item_id,
            subscription_id, license_key_hash, license_key_hint, status,
            activation_limit, valid_from, expires_at, grace_until,
            current_entitlement_snapshot_id, issued_at, created_at, updated_at
       FROM licenses` },
    { key: "trackingConfigs", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, integrated_site_id, provider, label, pixel_id,
            access_token_ciphertext, encryption_key_version, test_event_code,
            enabled_events, status, created_at, updated_at, rotated_at
       FROM tracking_configurations` },
    { key: "trackingEvents", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, integrated_site_id, event_name, event_id, event_time,
            event_source_url, order_id, consent_state,
            consent_policy_version, sanitized_payload, status, created_at
            ${caps.trackingEventsDelivery ? ", delivery_attempts, delivered_at" : ""}
       FROM tracking_events` },
    { key: "endpointSecrets", orderBy: "t.webhook_endpoint_id, t.created_at ASC", sql: `SELECT webhook_endpoint_id, key_id, secret_ciphertext, key_version, status, created_at
       FROM webhook_endpoint_secrets` },
    { key: "endpoints", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, integrated_site_id, url, description, subscribed_events,
            status, created_at
       FROM webhook_endpoints` },
    { key: "deliveries", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, webhook_endpoint_id, event_id, delivery_id, status,
            attempt_count, last_http_status, delivered_at, created_at
       FROM webhook_deliveries` },
    { key: "outbox", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, event_key, aggregate_type, aggregate_id, event_type, payload,
            status, attempt_count, available_at, locked_until, locked_by,
            last_error_code, created_at, processed_at
       FROM outbox_events` },
    { key: "idempotency", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, scope_key, idempotency_key, request_hash, status,
            response_status, expires_at, created_at
            ${caps.idempotencyResponseBody ? ", response_body" : ", response_reference"}
       FROM idempotency_records` },
    { key: "audit", orderBy: "t.created_at DESC, t.id DESC", sql: `SELECT id, actor_type, actor_user_id, integrated_site_id, action,
            resource_type, resource_id, outcome, request_id, changes, created_at
       FROM audit_logs` },
    { key: "licenseEvents", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, license_id, event_type, actor_type, actor_user_id,
            activation_id, metadata, created_at
       FROM license_events` },
    { key: "reminderSettings", orderBy: null, sql: `SELECT id, due_offsets_days, overdue_offsets_days, overdue_enabled, updated_at
       FROM reminder_settings` },
    { key: "sentReminders", orderBy: "t.sent_at ASC, t.id ASC", sql: `SELECT id, kind, reference_id, offset_days, sent_at
       FROM sent_reminders` },
    { key: "supportTickets", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, ticket_number, customer_id, order_id, subscription_id,
            license_id, product_id, title, description, status, priority,
            category, reporter_user_id, source_note, assignee_user_id,
            created_at, updated_at, resolved_at, closed_at
       FROM support_tickets` },
    { key: "ticketComments", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, ticket_id, author_user_id, body, is_internal, created_at
       FROM ticket_comments` },
    { key: "leads", orderBy: "t.created_at ASC, t.id ASC", sql: `SELECT id, lead_number, name, email, normalized_email, phone,
            normalized_phone, whatsapp, source_site_id, utm_source,
            utm_medium, utm_campaign, interest, product_id, message, notes,
            status, assignee_user_id, created_at, updated_at, converted_at,
            converted_customer_id, converted_order_id
       FROM leads` },
  ];
  // Migration 0007 (auth + email): the policy table only exists on a
  // migrated database — selecting it unconditionally would break a
  // pre-0007 store. Same conditional pattern as sequence_counters.
  if (caps.authEmailTables) {
    queries.push({ key: "twoFactorPolicy", orderBy: "t.scope ASC", sql: `SELECT id, scope, mode, updated_at
       FROM auth_two_factor_policy` });
  }
  if (caps.sequenceCounters) {
    queries.push({ key: "counters", orderBy: null, sql: `SELECT counter_key, counter_value FROM sequence_counters` });
  }
  const cols = queries
    .map((q) =>
      q.orderBy
        ? `(SELECT COALESCE(json_agg(t ORDER BY ${q.orderBy}), '[]'::json) FROM (${q.sql}) t) AS "${q.key}"`
        : `(SELECT COALESCE(json_agg(t), '[]'::json) FROM (${q.sql}) t) AS "${q.key}"`
    )
    .join(",\n");
  return `SELECT ${cols}`;
}

/**
 * Pull one table's rows out of the combined load row. A missing or
 * non-array column is a corrupt load, never an empty table (empty tables
 * arrive as [] via COALESCE).
 */
function loadRows(combined: Row, key: string): Row[] {
  const value = combined[key];
  if (!Array.isArray(value)) {
    throw new Error(
      `DrizzleStore: combined state load is missing the "${key}" table data.`
    );
  }
  return value as unknown as Row[];
}

async function loadStateInternalImpl(
  client: Client,
  caps: StoreCapabilities
): Promise<DatabaseState> {
  // One statement fetches every table (see buildLoadStateQuery). The
  // mapping code below is unchanged — each table's rows come from the
  // combined row instead of its own round-trip.
  const combinedRows = await queryRows(client, buildLoadStateQuery(caps));
  const combined = combinedRows[0];
  if (!combined) {
    throw new Error("DrizzleStore: combined state load returned no rows.");
  }


  // -- Identity -------------------------------------------------------------
  const userRows = loadRows(combined, "users");
  const users: UserRecord[] = userRows.map((row) => ({
    id: reqStr(row, "id", "users"),
    name: reqStr(row, "name", "users"),
    email: reqStr(row, "email", "users"),
    email_verified: bool(row, "email_verified"),
    // Users created by Better Auth have no password_hash (NULL) and cannot
    // use staff password sign-in; verifyPasswordScrypt fails closed on "".
    password_hash: caps.usersPasswordHash ? (str(row, "password_hash") ?? "") : "",
    two_factor_enabled: bool(row, "two_factor_enabled"),
    // M-23: custom avatar R2 object key (migration 0014); null =
    // Gravatar/initials. Missing column (pre-0014 DB) reads as null.
    avatar_url: caps.usersAvatarUrl ? (str(row, "avatar_url") ?? null) : null,
    status: asEnum(str(row, "staff_status"), ["active", "suspended"] as const, "active"),
    created_at: reqIso(row, "created_at", "users"),
    updated_at: reqIso(row, "updated_at", "users"),
  }));

  const sessionRows = loadRows(combined, "sessions");
  const sessions: SessionRecord[] = sessionRows.map((row) => ({
    id: reqStr(row, "id", "sessions"),
    token: reqStr(row, "token", "sessions"),
    user_id: reqStr(row, "user_id", "sessions"),
    ip_address: str(row, "ip_address"),
    user_agent: str(row, "user_agent"),
    expires_at: reqIso(row, "expires_at", "sessions"),
    created_at: reqIso(row, "created_at", "sessions"),
  }));

  // -- RBAC (roles + permission_keys via role_permissions → permissions) ----
  const roleRows = loadRows(combined, "roles");
  const rolePermRows = loadRows(combined, "rolePerms");
  const permsByRole = groupBy(rolePermRows, (r) => String(r["role_id"]));
  const roles: RoleRecord[] = roleRows.map((row) => {
    const id = reqStr(row, "id", "roles");
    return {
      id,
      key: reqStr(row, "key", "roles"),
      name: reqStr(row, "name", "roles"),
      description: str(row, "description") ?? "",
      is_system: bool(row, "is_system"),
      permission_keys: (permsByRole.get(id) ?? []).map((r) =>
        String(r["permission_key"])
      ),
      created_at: reqIso(row, "created_at", "roles"),
    };
  });

  const userRoleRows = loadRows(combined, "userRoles");
  const user_roles = userRoleRows.map((row) => ({
    user_id: reqStr(row, "user_id", "user_roles"),
    role_id: reqStr(row, "role_id", "user_roles"),
    assigned_at: reqIso(row, "created_at", "user_roles"),
  }));

  const invitationRows = loadRows(combined, "staffInvitations");
  const staff_invitations: StaffInvitationRecord[] = invitationRows.map((row) => ({
    id: reqStr(row, "id", "staff_invitations"),
    email: reqStr(row, "email", "staff_invitations"),
    name: reqStr(row, "name", "staff_invitations"),
    role_keys: asJsonArray<string>(row, "role_keys"),
    token_hash: reqStr(row, "token_hash", "staff_invitations"),
    status: asEnum(
      str(row, "status"),
      ["pending", "accepted", "revoked", "expired"] as const,
      "pending"
    ),
    expires_at: reqIso(row, "expires_at", "staff_invitations"),
    invited_by_user_id: str(row, "invited_by_user_id"),
    accepted_user_id: str(row, "accepted_user_id"),
    accepted_at: iso(row, "accepted_at"),
    revoked_at: iso(row, "revoked_at"),
    created_at: reqIso(row, "created_at", "staff_invitations"),
    updated_at: reqIso(row, "updated_at", "staff_invitations"),
  }));

  // Reference data must come from migration 0001 — never auto-seeded here.
  const currencyRows = loadRows(combined, "currencies");
  if (roles.length === 0 || currencyRows.length === 0) {
    throw new Error(
      "DrizzleStore: reference data is missing (roles or currencies table is empty). Migration 0001 (db/migrations/0001_seed_reference_catalog.sql) has not been applied."
    );
  }

  // -- Assets / customers ----------------------------------------------------
  const assetRows = loadRows(combined, "assets");
  const uploaded_assets: UploadedAssetRecord[] = assetRows.map((row) => ({
    id: reqStr(row, "id", "uploaded_assets"),
    object_key: reqStr(row, "object_key", "uploaded_assets"),
    bucket_name: reqStr(row, "bucket_name", "uploaded_assets"),
    original_filename: reqStr(row, "original_filename", "uploaded_assets"),
    content_type: reqStr(row, "content_type", "uploaded_assets"),
    byte_size: reqNum(row, "byte_size", "uploaded_assets"),
    checksum_sha256: reqStr(row, "checksum_sha256", "uploaded_assets"),
    visibility: asEnum(str(row, "visibility"), ["private", "public"] as const, "private"),
    uploaded_by_user_id: str(row, "uploaded_by_user_id"),
    owner_customer_id: str(row, "owner_customer_id"),
    created_at: reqIso(row, "created_at", "uploaded_assets"),
  }));

  // -- Media library ---------------------------------------------------------
  const mediaAssetRows = loadRows(combined, "mediaAssets");
  const media_assets: MediaAssetRecord[] = mediaAssetRows.map((row) => ({
    id: reqStr(row, "id", "media_assets"),
    object_key: reqStr(row, "object_key", "media_assets"),
    driver: asEnum(str(row, "driver"), ["r2", "local"] as const, "r2"),
    original_filename: reqStr(row, "original_filename", "media_assets"),
    mime_type: reqStr(row, "mime_type", "media_assets"),
    byte_size: reqNum(row, "byte_size", "media_assets"),
    checksum_sha256: reqStr(row, "checksum_sha256", "media_assets"),
    width: num(row, "width"),
    height: num(row, "height"),
    folder: str(row, "folder") ?? "",
    tags: asJsonArray<string>(row, "tags"),
    uploaded_by_user_id: str(row, "uploaded_by_user_id"),
    created_at: reqIso(row, "created_at", "media_assets"),
    updated_at: reqIso(row, "updated_at", "media_assets"),
  }));

  const customerRows = loadRows(combined, "customers");
  const customers: CustomerRecord[] = customerRows.map((row) => ({
    id: reqStr(row, "id", "customers"),
    customer_number: reqStr(row, "customer_number", "customers"),
    customer_type: asEnum(str(row, "customer_type"), ["person", "business"] as const, "person"),
    name: reqStr(row, "name", "customers"),
    email: str(row, "email"),
    normalized_email: str(row, "normalized_email"),
    phone: str(row, "phone"),
    normalized_phone: str(row, "normalized_phone"),
    whatsapp: str(row, "whatsapp"),
    credit_balance_minor: num(row, "credit_balance_minor") ?? 0,
    company_name: str(row, "company_name"),
    website: str(row, "website"),
    country_code: str(row, "country_code") ?? "BD",
    status: asEnum(
      str(row, "status"),
      ["active", "inactive", "blocked"] as const,
      "active"
    ),
    registration_source: str(row, "registration_source") ?? "admin",
    notes: str(row, "notes"),
    created_at: reqIso(row, "created_at", "customers"),
    updated_at: reqIso(row, "updated_at", "customers"),
  }));

  // -- Customer contacts / addresses / reports (migration 0009) ---------------
  const customerContactRows = loadRows(combined, "customerContacts");
  const customer_contacts: CustomerContactRecord[] = customerContactRows.map((row) => ({
    id: reqStr(row, "id", "customer_contacts"),
    customer_id: reqStr(row, "customer_id", "customer_contacts"),
    kind: asEnum(str(row, "kind"), ["email", "phone"] as const, "email"),
    value: reqStr(row, "value", "customer_contacts"),
    normalized_value: reqStr(row, "normalized_value", "customer_contacts"),
    created_at: reqIso(row, "created_at", "customer_contacts"),
  }));

  const customerAddressRows = loadRows(combined, "customerAddresses");
  const customer_addresses: CustomerAddressRecord[] = customerAddressRows.map((row) => ({
    id: reqStr(row, "id", "customer_addresses"),
    customer_id: reqStr(row, "customer_id", "customer_addresses"),
    address_type: asEnum(
      str(row, "address_type"),
      ["billing", "shipping", "other"] as const,
      "billing"
    ),
    contact_name: str(row, "contact_name"),
    phone: str(row, "phone"),
    address_line_1: str(row, "address_line_1"),
    address_line_2: str(row, "address_line_2"),
    city: str(row, "city"),
    state_or_region: str(row, "state_or_region"),
    postal_code: str(row, "postal_code"),
    country_code: str(row, "country_code") ?? "BD",
    is_default: bool(row, "is_default"),
    created_at: reqIso(row, "created_at", "customer_addresses"),
    updated_at: reqIso(row, "updated_at", "customer_addresses"),
  }));

  const customerReportRows = loadRows(combined, "customerReports");
  const customer_reports: CustomerReportRecord[] = customerReportRows.map((row) => ({
    id: reqStr(row, "id", "customer_reports"),
    customer_id: reqStr(row, "customer_id", "customer_reports"),
    author_user_id: reqStr(row, "author_user_id", "customer_reports"),
    type: asEnum(str(row, "type"), ["note", "concern"] as const, "note"),
    detail: reqStr(row, "detail", "customer_reports"),
    created_at: reqIso(row, "created_at", "customer_reports"),
  }));

  // -- Catalog ---------------------------------------------------------------
  const channelRows = loadRows(combined, "channels");
  const channelsByProduct = groupBy(channelRows, (r) => String(r["product_id"]));
  const productRows = loadRows(combined, "products");
  const products: ProductRecord[] = productRows.map((row) => {
    const id = reqStr(row, "id", "products");
    return {
      id,
      code: reqStr(row, "code", "products"),
      slug: reqStr(row, "slug", "products"),
      name: reqStr(row, "name", "products"),
      description: str(row, "description"),
      product_type: reqStr(row, "product_type", "products"),
      fulfillment_type: reqStr(row, "fulfillment_type", "products"),
      distribution_channels: (channelsByProduct.get(id) ?? []).map((r) =>
        String(r["channel_key"])
      ),
      default_activation_limit: caps.productsDefaults
        ? reqNum(row, "default_activation_limit", "products")
        : 1,
      offline_grace_hours: caps.productsDefaults
        ? reqNum(row, "offline_grace_hours", "products")
        : 72,
      status: asEnum(
        str(row, "status"),
        ["draft", "active", "archived"] as const,
        "draft"
      ),
      website_url: str(row, "website_url"),
      documentation_url: str(row, "documentation_url"),
      // E-13: logo_asset_id (uuid → uploaded_assets, migration 0000)
      // was missing from the load mapping, so a logo set via the
      // catalog service vanished on the next DB reload.
      logo_asset_id: str(row, "logo_asset_id"),
      created_by_user_id: str(row, "created_by_user_id"),
      created_at: reqIso(row, "created_at", "products"),
      updated_at: reqIso(row, "updated_at", "products"),
    };
  });

  const featureRows = loadRows(combined, "features");
  const product_features: ProductFeatureRecord[] = featureRows.map((row) => ({
    id: reqStr(row, "id", "product_features"),
    product_id: reqStr(row, "product_id", "product_features"),
    feature_key: reqStr(row, "feature_key", "product_features"),
    name: reqStr(row, "name", "product_features"),
    description: str(row, "description"),
    value_type: asEnum(
      str(row, "value_type"),
      ["boolean", "limit", "quota", "metered"] as const,
      "boolean"
    ),
    unit: str(row, "unit"),
    default_value: row["default_value"] ?? null,
    status: asEnum(str(row, "status"), ["active", "archived"] as const, "active"),
    created_at: reqIso(row, "created_at", "product_features"),
    updated_at: reqIso(row, "updated_at", "product_features"),
  }));

  const packageRows = loadRows(combined, "packages");
  const product_packages: ProductPackageRecord[] = packageRows.map((row) => ({
    id: reqStr(row, "id", "product_packages"),
    product_id: reqStr(row, "product_id", "product_packages"),
    package_key: reqStr(row, "package_key", "product_packages"),
    name: reqStr(row, "name", "product_packages"),
    description: str(row, "description"),
    status: asEnum(
      str(row, "status"),
      ["draft", "active", "archived"] as const,
      "draft"
    ),
    current_version_id: caps.packagesCurrentVersion
      ? str(row, "current_version_id")
      : null,
    created_at: reqIso(row, "created_at", "product_packages"),
    updated_at: reqIso(row, "updated_at", "product_packages"),
  }));

  const versionFeatureRows = loadRows(combined, "versionFeatures");
  const grantsByVersion = groupBy(versionFeatureRows, (r) =>
    String(r["package_version_id"])
  );
  const versionRows = loadRows(combined, "versions");
  const package_versions: PackageVersionRecord[] = versionRows.map((row) => {
    const id = reqStr(row, "id", "package_versions");
    const features: PackageVersionFeatureGrant[] = (
      grantsByVersion.get(id) ?? []
    ).map((g) => ({
      id: reqStr(g, "id", "package_version_features"),
      package_version_id: id,
      product_id: reqStr(g, "product_id", "package_version_features"),
      product_feature_id: reqStr(g, "product_feature_id", "package_version_features"),
      feature_key_snapshot: reqStr(g, "feature_key_snapshot", "package_version_features"),
      value_type_snapshot: asEnum(
        str(g, "value_type_snapshot"),
        ["boolean", "limit", "quota", "metered"] as const,
        "boolean"
      ),
      entitlement_value: g["entitlement_value"] ?? null,
      unit_snapshot: caps.packageVersionFeaturesUnit
        ? str(g, "unit_snapshot")
        : null,
    }));
    return {
      id,
      package_id: reqStr(row, "package_id", "package_versions"),
      product_id: reqStr(row, "product_id", "package_versions"),
      version_number: reqNum(row, "version_number", "package_versions"),
      status: asEnum(
        str(row, "status"),
        ["draft", "published", "retired"] as const,
        "draft"
      ),
      change_summary: str(row, "change_summary"),
      features,
      published_at: iso(row, "published_at"),
      created_at: reqIso(row, "created_at", "package_versions"),
    };
  });

  const priceRows = loadRows(combined, "prices");
  const package_prices: PackagePriceRecord[] = priceRows.map((row) => ({
    id: reqStr(row, "id", "package_prices"),
    package_version_id: reqStr(row, "package_version_id", "package_prices"),
    price_key: reqStr(row, "price_key", "package_prices"),
    price_kind: asEnum(
      str(row, "price_kind"),
      ["free", "one_time", "recurring", "lifetime"] as const,
      "one_time"
    ),
    amount_minor: reqNum(row, "amount_minor", "package_prices"),
    currency_code: reqStr(row, "currency_code", "package_prices"),
    interval_unit: asEnumOrNull(str(row, "interval_unit"), [
      "day",
      "week",
      "month",
      "year",
    ] as const),
    interval_count: num(row, "interval_count"),
    trial_days: reqNum(row, "trial_days", "package_prices"),
    setup_fee_minor: reqNum(row, "setup_fee_minor", "package_prices"),
    status: asEnum(
      str(row, "status"),
      ["active", "inactive", "retired"] as const,
      "active"
    ),
    used_in_orders: caps.packagePricesUsedInOrders
      ? bool(row, "used_in_orders")
      : false,
    created_at: reqIso(row, "created_at", "package_prices"),
  }));

  // -- Integrated sites -------------------------------------------------------
  const siteProductRows = loadRows(combined, "siteProducts");
  const productsBySite = groupBy(siteProductRows, (r) =>
    String(r["integrated_site_id"])
  );
  const domainRows = loadRows(combined, "domains");
  const domainsBySite = groupBy(domainRows, (r) => String(r["integrated_site_id"]));
  const siteRows = loadRows(combined, "sites");
  const integrated_sites: IntegratedSiteRecord[] = siteRows.map((row) => {
    const id = reqStr(row, "id", "integrated_sites");
    return {
      id,
      site_key: reqStr(row, "site_key", "integrated_sites"),
      name: reqStr(row, "name", "integrated_sites"),
      environment: asEnum(
        str(row, "environment"),
        ["production", "staging", "development"] as const,
        "production"
      ),
      status: asEnum(
        str(row, "status"),
        ["pending_verification", "active", "suspended", "revoked"] as const,
        "pending_verification"
      ),
      api_version: reqStr(row, "api_version", "integrated_sites"),
      allowed_capabilities: asJsonArray<string>(row, "allowed_capabilities"),
      product_ids: (productsBySite.get(id) ?? []).map((r) =>
        String(r["product_id"])
      ),
      domains: (domainsBySite.get(id) ?? []).map((d) => ({
        id: reqStr(d, "id", "site_domains"),
        domain: reqStr(d, "domain", "site_domains"),
        verification_method: asEnum(
          str(d, "verification_method"),
          ["dns_txt", "http_file", "manual_review"] as const,
          "dns_txt"
        ),
        verification_challenge: reqStr(d, "verification_challenge", "site_domains"),
        verification_status: asEnum(
          str(d, "verification_status"),
          ["pending", "verified", "failed"] as const,
          "pending"
        ),
        verified_at: iso(d, "verified_at"),
        is_primary: bool(d, "is_primary"),
      })),
      created_at: reqIso(row, "created_at", "integrated_sites"),
      updated_at: reqIso(row, "updated_at", "integrated_sites"),
    };
  });

  const credentialRows = loadRows(combined, "credentials");
  const site_credentials: SiteCredentialRecord[] = credentialRows.map((row) => ({
    id: reqStr(row, "id", "site_credentials"),
    integrated_site_id: reqStr(row, "integrated_site_id", "site_credentials"),
    key_id: reqStr(row, "key_id", "site_credentials"),
    credential_type: asEnum(
      str(row, "credential_type"),
      ["public_key", "bearer_secret", "hmac_shared_secret", "public_signing_key"] as const,
      "hmac_shared_secret"
    ),
    secret_hash: str(row, "secret_hash"),
    secret_ciphertext: str(row, "secret_ciphertext"),
    encryption_key_version: str(row, "encryption_key_version"),
    scopes: asJsonArray<string>(row, "scopes"),
    status: asEnum(
      str(row, "status"),
      ["active", "rotated", "revoked", "expired"] as const,
      "active"
    ),
    created_at: reqIso(row, "created_at", "site_credentials"),
    revoked_at: iso(row, "revoked_at"),
    last_used_at: iso(row, "last_used_at"),
  }));

  const nonceRows = loadRows(combined, "nonces");
  const request_nonces = nonceRows.map((row) => ({
    credential_id: reqStr(row, "credential_id", "request_nonces"),
    nonce: reqStr(row, "nonce", "request_nonces"),
    expires_at: reqIso(row, "expires_at", "request_nonces"),
  }));

  // -- Orders (items + entitlement snapshots + attributions) -----------------
  const attributionRows = loadRows(combined, "attributions");
  const attributionByOrder = new Map<string, Record<string, string | undefined>>();
  for (const row of attributionRows) {
    const rec: Record<string, string | undefined> = {};
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "fbp",
      "fbc",
    ] as const) {
      const v = str(row, key);
      if (v !== null) rec[key] = v;
    }
    if (Object.keys(rec).length > 0) {
      attributionByOrder.set(reqStr(row, "order_id", "order_attributions"), rec);
    }
  }

  const orderSnapshotItemRows = loadRows(combined, "orderSnapshotItems");
  const orderSnapshotItemsBySnapshot = groupBy(orderSnapshotItemRows, (r) =>
    String(r["snapshot_id"])
  );
  const orderSnapshotRows = loadRows(combined, "orderSnapshots");
  const orderSnapshotByItem = new Map<string, OrderItemSnapshotRecord>();
  for (const row of orderSnapshotRows) {
    const id = reqStr(row, "id", "order_item_entitlement_snapshots");
    orderSnapshotByItem.set(reqStr(row, "order_item_id", "order_item_entitlement_snapshots"), {
      id,
      order_item_id: reqStr(row, "order_item_id", "order_item_entitlement_snapshots"),
      source_type: asEnum(
        str(row, "source_type"),
        ["package_version", "custom_offer", "complimentary", "manual_adjustment"] as const,
        "custom_offer"
      ),
      source_package_version_id: str(row, "source_package_version_id"),
      schema_version: reqNum(row, "schema_version", "order_item_entitlement_snapshots"),
      snapshot_hash: reqStr(row, "snapshot_hash", "order_item_entitlement_snapshots"),
      items: (orderSnapshotItemsBySnapshot.get(id) ?? []).map((it) => ({
        feature_key_snapshot: reqStr(
          it,
          "feature_key_snapshot",
          "order_item_entitlement_snapshot_items"
        ),
        value_type_snapshot: asEnum(
          str(it, "value_type_snapshot"),
          ["boolean", "limit", "quota", "metered"] as const,
          "boolean"
        ),
        entitlement_value: it["entitlement_value"] ?? null,
        unit_snapshot: str(it, "unit_snapshot"),
      })),
      created_at: reqIso(row, "created_at", "order_item_entitlement_snapshots"),
    });
  }

  const orderItemRows = loadRows(combined, "orderItems");
  const orderItemsByOrder = groupBy(orderItemRows, (r) => String(r["order_id"]));
  const orderRows = loadRows(combined, "orders");
  const orders: OrderRecord[] = orderRows.map((row) => {
    const id = reqStr(row, "id", "orders");
    const items: OrderItemRecord[] = (orderItemsByOrder.get(id) ?? []).map((it) => {
      const itemId = reqStr(it, "id", "order_items");
      const snapshot = orderSnapshotByItem.get(itemId);
      if (!snapshot) {
        // The entitlement snapshot IS the purchased entitlement — a row
        // without one is corrupt data, not something to paper over.
        throw new Error(
          `DrizzleStore: order_items row ${itemId} has no order_item_entitlement_snapshots row. The order cannot be loaded losslessly; repair the data (or re-run the fulfillment that created it).`
        );
      }
      return {
        id: itemId,
        order_id: id,
        product_id: reqStr(it, "product_id", "order_items"),
        package_id: str(it, "package_id"),
        package_version_id: str(it, "package_version_id"),
        package_price_id: str(it, "package_price_id"),
        item_kind: asEnum(
          str(it, "item_kind"),
          ["package", "custom", "one_time_product", "other"] as const,
          "package"
        ),
        fulfillment_type_snapshot: reqStr(it, "fulfillment_type_snapshot", "order_items"),
        product_name_snapshot: reqStr(it, "product_name_snapshot", "order_items"),
        package_name_snapshot: str(it, "package_name_snapshot"),
        package_version_snapshot: num(it, "package_version_snapshot"),
        price_kind_snapshot: asEnum(
          str(it, "price_kind_snapshot"),
          ["free", "one_time", "recurring", "lifetime"] as const,
          "recurring"
        ),
        interval_unit_snapshot: asEnumOrNull(str(it, "interval_unit_snapshot"), [
          "day",
          "week",
          "month",
          "year",
        ] as const),
        interval_count_snapshot: num(it, "interval_count_snapshot"),
        activation_limit_snapshot: reqNum(it, "activation_limit_snapshot", "order_items"),
        quantity: reqNum(it, "quantity", "order_items"),
        unit_amount_minor: reqNum(it, "unit_amount_minor", "order_items"),
        line_subtotal_minor: reqNum(it, "line_subtotal_minor", "order_items"),
        line_discount_minor: reqNum(it, "line_discount_minor", "order_items"),
        line_tax_minor: reqNum(it, "line_tax_minor", "order_items"),
        line_total_minor: reqNum(it, "line_total_minor", "order_items"),
        currency_code: reqStr(it, "currency_code", "order_items"),
        entitlement_snapshot: snapshot,
        created_at: reqIso(it, "created_at", "order_items"),
      };
    });
    return {
      id,
      order_number: reqStr(row, "order_number", "orders"),
      public_reference: reqStr(row, "public_reference", "orders"),
      customer_id: reqStr(row, "customer_id", "orders"),
      source: asEnum(
        str(row, "source"),
        ["admin", "website", "api", "import"] as const,
        "admin"
      ),
      integrated_site_id: str(row, "integrated_site_id"),
      status: asEnum(
        str(row, "status"),
        ["draft", "awaiting_payment", "processing", "completed", "cancelled", "failed"] as const,
        "draft"
      ),
      payment_status: asEnum(
        str(row, "payment_status"),
        ["unpaid", "pending_verification", "partially_paid", "paid", "partially_refunded", "refunded"] as const,
        "unpaid"
      ),
      currency_code: reqStr(row, "currency_code", "orders"),
      subtotal_minor: reqNum(row, "subtotal_minor", "orders"),
      discount_minor: reqNum(row, "discount_minor", "orders"),
      tax_minor: reqNum(row, "tax_minor", "orders"),
      total_minor: reqNum(row, "total_minor", "orders"),
      customer_note: str(row, "customer_note"),
      internal_note: str(row, "internal_note"),
      items,
      attribution: attributionByOrder.get(id) ?? null,
      created_by_user_id: str(row, "created_by_user_id"),
      activation_mode: asEnum(
        str(row, "activation_mode"),
        ["on_full_payment", "on_percent", "on_date"] as const,
        "on_full_payment"
      ),
      activation_percent: num(row, "activation_percent"),
      activation_date: dateOnly(row, "activation_date"),
      suspend_on_missed_schedule: bool(row, "suspend_on_missed_schedule"),
      grace_days: num(row, "grace_days") ?? 3,
      payment_method_id: str(row, "payment_method_id"),
      lead_id: str(row, "lead_id"),
      created_at: reqIso(row, "created_at", "orders"),
      updated_at: reqIso(row, "updated_at", "orders"),
      completed_at: iso(row, "completed_at"),
      cancelled_at: iso(row, "cancelled_at"),
    };
  });

  // -- Order installments (migration 0009) ------------------------------------
  const orderInstallmentRows = loadRows(combined, "orderInstallments");
  const order_installments: OrderInstallmentRecord[] = orderInstallmentRows.map((row) => ({
    id: reqStr(row, "id", "order_installments"),
    order_id: reqStr(row, "order_id", "order_installments"),
    installment_number: reqNum(row, "installment_number", "order_installments"),
    amount_minor: reqNum(row, "amount_minor", "order_installments"),
    due_date: dateOnly(row, "due_date") ?? "",
    status: asEnum(
      str(row, "status"),
      ["pending", "partially_paid", "paid", "overdue"] as const,
      "pending"
    ),
    paid_amount_minor: num(row, "paid_amount_minor") ?? 0,
    paid_at: iso(row, "paid_at"),
    notes: str(row, "notes"),
    created_at: reqIso(row, "created_at", "order_installments"),
    updated_at: reqIso(row, "updated_at", "order_installments"),
  }));

  // -- Subscriptions (periods) + invoices (items) -----------------------------
  const periodRows = loadRows(combined, "periods");
  const periodsBySubscription = groupBy(periodRows, (r) =>
    String(r["subscription_id"])
  );
  const subscriptionRows = loadRows(combined, "subscriptions");
  const subscriptions: SubscriptionRecord[] = subscriptionRows.map((row) => {
    const id = reqStr(row, "id", "subscriptions");
    const periods: SubscriptionPeriodRecord[] = (
      periodsBySubscription.get(id) ?? []
    ).map((p) => ({
      id: reqStr(p, "id", "subscription_periods"),
      subscription_id: id,
      period_number: reqNum(p, "period_number", "subscription_periods"),
      period_start: reqIso(p, "period_start", "subscription_periods"),
      period_end: reqIso(p, "period_end", "subscription_periods"),
      status: asEnum(
        str(p, "status"),
        ["pending", "active", "completed", "void", "failed"] as const,
        "pending"
      ),
      renewal_order_id: str(p, "renewal_order_id"),
      invoice_id: str(p, "invoice_id"),
      payment_transaction_id: str(p, "payment_transaction_id"),
      activated_at: iso(p, "activated_at"),
      created_at: reqIso(p, "created_at", "subscription_periods"),
    }));
    return {
      id,
      subscription_number: reqStr(row, "subscription_number", "subscriptions"),
      customer_id: reqStr(row, "customer_id", "subscriptions"),
      product_id: reqStr(row, "product_id", "subscriptions"),
      source_order_item_id: str(row, "source_order_item_id"),
      source_package_version_id: str(row, "source_package_version_id"),
      status: asEnum(
        str(row, "status"),
        ["trialing", "pending", "active", "past_due", "paused", "cancelled", "expired"] as const,
        "pending"
      ),
      billing_kind: asEnum(
        str(row, "billing_kind"),
        ["one_time", "recurring", "lifetime", "custom"] as const,
        "recurring"
      ),
      interval_unit: asEnumOrNull(str(row, "interval_unit"), [
        "day",
        "week",
        "month",
        "year",
      ] as const),
      interval_count: num(row, "interval_count"),
      currency_code: reqStr(row, "currency_code", "subscriptions"),
      unit_amount_minor: caps.subscriptionsUnitAmount
        ? reqNum(row, "unit_amount_minor", "subscriptions")
        : 0,
      grace_days: num(row, "grace_days") ?? 3,
      current_period_start: iso(row, "current_period_start"),
      current_period_end: iso(row, "current_period_end"),
      next_renewal_at: iso(row, "next_renewal_at"),
      cancel_at_period_end: bool(row, "cancel_at_period_end"),
      cancelled_at: iso(row, "cancelled_at"),
      periods,
      created_at: reqIso(row, "created_at", "subscriptions"),
      updated_at: reqIso(row, "updated_at", "subscriptions"),
    };
  });

  const invoiceItemRows = loadRows(combined, "invoiceItems");
  const invoiceItemsByInvoice = groupBy(invoiceItemRows, (r) =>
    String(r["invoice_id"])
  );
  const invoiceRows = loadRows(combined, "invoices");
  const invoices: InvoiceRecord[] = invoiceRows.map((row) => {
    const id = reqStr(row, "id", "invoices");
    return {
      id,
      invoice_number: reqStr(row, "invoice_number", "invoices"),
      customer_id: reqStr(row, "customer_id", "invoices"),
      order_id: str(row, "order_id"),
      subscription_id: str(row, "subscription_id"),
      invoice_type: asEnum(
        str(row, "invoice_type"),
        ["initial", "renewal", "adjustment", "credit_note"] as const,
        "initial"
      ),
      status: asEnum(
        str(row, "status"),
        ["draft", "open", "paid", "void", "uncollectible", "partially_paid"] as const,
        "open"
      ),
      currency_code: reqStr(row, "currency_code", "invoices"),
      subtotal_minor: reqNum(row, "subtotal_minor", "invoices"),
      discount_minor: reqNum(row, "discount_minor", "invoices"),
      tax_minor: reqNum(row, "tax_minor", "invoices"),
      total_minor: reqNum(row, "total_minor", "invoices"),
      amount_paid_minor: reqNum(row, "amount_paid_minor", "invoices"),
      amount_due_minor: reqNum(row, "amount_due_minor", "invoices"),
      issued_at: reqIso(row, "issued_at", "invoices"),
      paid_at: iso(row, "paid_at"),
      items: (invoiceItemsByInvoice.get(id) ?? []).map((it) => ({
        id: reqStr(it, "id", "invoice_items"),
        description_snapshot: reqStr(it, "description_snapshot", "invoice_items"),
        quantity: reqNum(it, "quantity", "invoice_items"),
        unit_amount_minor: reqNum(it, "unit_amount_minor", "invoice_items"),
        line_amount_minor: reqNum(it, "line_amount_minor", "invoice_items"),
        currency_code: reqStr(it, "currency_code", "invoice_items"),
      })),
      created_at: reqIso(row, "created_at", "invoices"),
    };
  });

  // -- Payments ---------------------------------------------------------------
  const providerRows = loadRows(combined, "providers");
  const payment_providers: PaymentProviderRecord[] = providerRows.map((row) => ({
    id: reqStr(row, "id", "payment_providers"),
    provider_key: reqStr(row, "provider_key", "payment_providers"),
    display_name: reqStr(row, "display_name", "payment_providers"),
    provider_type: asEnum(
      str(row, "provider_type"),
      ["manual_mfs", "manual_bank", "automated"] as const,
      "manual_mfs"
    ),
    adapter_key: reqStr(row, "adapter_key", "payment_providers"),
    status: asEnum(str(row, "status"), ["enabled", "disabled"] as const, "enabled"),
  }));
  if (payment_providers.length === 0) {
    throw new Error(
      "DrizzleStore: payment_providers table is empty. Migration 0001 (db/migrations/0001_seed_reference_catalog.sql) has not been applied."
    );
  }

  const railRows = loadRows(combined, "rails");
  const railsByMethod = groupBy(railRows, (r) => String(r["payment_method_id"]));
  const methodRows = loadRows(combined, "methods");
  const payment_methods: PaymentMethodRecord[] = methodRows.map((row) => {
    const id = reqStr(row, "id", "payment_methods");
    const cfg = asJsonObject(row, "configuration");
    const configuration: PaymentMethodRecord["configuration"] = {
      account_number: typeof cfg["account_number"] === "string" ? cfg["account_number"] : "",
      transaction_id_requirement: asEnum(
        cfg["transaction_id_requirement"],
        ["required", "optional", "disabled"] as const,
        "disabled"
      ),
    };
    if (typeof cfg["account_holder_name"] === "string") {
      configuration.account_holder_name = cfg["account_holder_name"];
    }
    if (typeof cfg["bank_name"] === "string") configuration.bank_name = cfg["bank_name"];
    if (typeof cfg["branch_name"] === "string") {
      configuration.branch_name = cfg["branch_name"];
    }
    if (typeof cfg["routing_number"] === "string") {
      configuration.routing_number = cfg["routing_number"];
    }
    return {
      id,
      provider_id: reqStr(row, "provider_id", "payment_methods"),
      method_key: reqStr(row, "method_key", "payment_methods"),
      display_name: reqStr(row, "display_name", "payment_methods"),
      method_kind: asEnum(
        str(row, "method_kind"),
        ["mfs_account", "bank_account", "automated_checkout"] as const,
        "mfs_account"
      ),
      account_type: asEnumOrNull(str(row, "account_type"), [
        "personal",
        "merchant",
        "agent",
      ] as const),
      account_label: str(row, "account_label"),
      instructions: str(row, "instructions"),
      configuration,
      transfer_rails: (railsByMethod.get(id) ?? []).map((r) =>
        asEnum(
          String(r["rail_key"]),
          ["npsb", "beftn", "rtgs"] as const,
          "npsb"
        )
      ),
      is_enabled: bool(row, "is_enabled"),
      sort_order: reqNum(row, "sort_order", "payment_methods"),
      created_at: reqIso(row, "created_at", "payment_methods"),
    };
  });

  const submissionRows = loadRows(combined, "submissions");
  const payment_submissions: PaymentSubmissionRecord[] = submissionRows.map((row) => ({
    id: reqStr(row, "id", "payment_submissions"),
    order_id: reqStr(row, "order_id", "payment_submissions"),
    customer_id: reqStr(row, "customer_id", "payment_submissions"),
    payment_method_id: reqStr(row, "payment_method_id", "payment_submissions"),
    installment_id: str(row, "installment_id"),
    amount_minor: reqNum(row, "amount_minor", "payment_submissions"),
    currency_code: reqStr(row, "currency_code", "payment_submissions"),
    sender_name: str(row, "sender_name"),
    sender_phone: str(row, "sender_phone"),
    sender_bank_name: str(row, "sender_bank_name"),
    sender_account_reference: str(row, "sender_account_reference"),
    transfer_rail_key: str(row, "transfer_rail_key"),
    transaction_reference: str(row, "transaction_reference"),
    normalized_transaction_reference: str(row, "normalized_transaction_reference"),
    payment_date: dateOnly(row, "payment_date"),
    proof_asset_id: str(row, "proof_asset_id"),
    duplicate_risk_Warning: caps.paymentSubmissionsDuplicateWarning
      ? bool(row, "duplicate_risk_warning")
      : false,
    status: asEnum(
      str(row, "status"),
      ["submitted", "under_review", "approved", "rejected", "cancelled"] as const,
      "submitted"
    ),
    customer_note: str(row, "customer_note"),
    submitted_at: reqIso(row, "submitted_at", "payment_submissions"),
    reviewed_at: iso(row, "reviewed_at"),
    reviewed_by_user_id: str(row, "reviewed_by_user_id"),
  }));

  const transactionRows = loadRows(combined, "transactions");
  const payment_transactions: PaymentTransactionRecord[] = transactionRows.map(
    (row) => ({
      id: reqStr(row, "id", "payment_transactions"),
      order_id: reqStr(row, "order_id", "payment_transactions"),
      payment_method_id: str(row, "payment_method_id"),
      payment_submission_id: str(row, "payment_submission_id"),
      provider_id: reqStr(row, "provider_id", "payment_transactions"),
      provider_transaction_id: str(row, "provider_transaction_id"),
      amount_minor: reqNum(row, "amount_minor", "payment_transactions"),
      currency_code: reqStr(row, "currency_code", "payment_transactions"),
      status: asEnum(
        str(row, "status"),
        ["succeeded", "pending", "failed", "partially_refunded", "refunded"] as const,
        "succeeded"
      ),
      // The store type requires paid_at; the column is nullable. A NULL
      // here means the row was written outside the service (which always
      // sets it); created_at is the closest honest fallback.
      paid_at: iso(row, "paid_at") ?? reqIso(row, "created_at", "payment_transactions"),
      verified_by_user_id: str(row, "verified_by_user_id"),
      verification_source: asEnum(
        str(row, "verification_source"),
        ["manual_staff", "provider_webhook", "provider_query", "import"] as const,
        "manual_staff"
      ),
      created_at: reqIso(row, "created_at", "payment_transactions"),
    })
  );

  const verificationLogRows = loadRows(combined, "verificationLogs");
  const payment_verification_logs: PaymentVerificationLogRecord[] =
    verificationLogRows.map((row) => ({
      id: reqStr(row, "id", "payment_verification_logs"),
      payment_submission_id: reqStr(
        row,
        "payment_submission_id",
        "payment_verification_logs"
      ),
      actor_user_id: reqStr(row, "actor_user_id", "payment_verification_logs"),
      decision: asEnum(
        str(row, "decision"),
        ["approved", "rejected", "requested_information", "reopened"] as const,
        "approved"
      ),
      reason_code: str(row, "reason_code"),
      customer_message: str(row, "customer_message"),
      notes: str(row, "notes"),
      created_at: reqIso(row, "created_at", "payment_verification_logs"),
    }));

  // -- Manual refunds (F-03) --------------------------------------------------
  const refundRows = loadRows(combined, "refunds");
  const payment_refunds: PaymentRefundRecord[] = refundRows.map((row) => ({
    id: reqStr(row, "id", "payment_refunds"),
    payment_transaction_id: reqStr(row, "payment_transaction_id", "payment_refunds"),
    amount_minor: reqNum(row, "amount_minor", "payment_refunds"),
    currency_code: reqStr(row, "currency_code", "payment_refunds"),
    status: asEnum(
      str(row, "status"),
      ["requested", "pending", "succeeded", "failed", "cancelled"] as const,
      "requested"
    ),
    reason: reqStr(row, "reason", "payment_refunds"),
    provider_refund_id: str(row, "provider_refund_id"),
    requested_by_user_id: str(row, "requested_by_user_id"),
    processed_by_user_id: str(row, "processed_by_user_id"),
    created_at: reqIso(row, "created_at", "payment_refunds"),
    updated_at: reqIso(row, "updated_at", "payment_refunds"),
  }));

  // -- Expense categories + expenses (migration 0018) -----------------------
  const expenseCategoryRows = loadRows(combined, "expenseCategories");
  const expense_categories: ExpenseCategoryRecord[] = expenseCategoryRows.map((row) => ({
    id: reqStr(row, "id", "expense_categories"),
    name: reqStr(row, "name", "expense_categories"),
    description: str(row, "description"),
    color: reqStr(row, "color", "expense_categories"),
    icon: str(row, "icon"),
    parent_id: str(row, "parent_id"),
    is_active: bool(row, "is_active"),
    created_at: reqIso(row, "created_at", "expense_categories"),
    updated_at: reqIso(row, "updated_at", "expense_categories"),
  }));

  const expenseRows = loadRows(combined, "expenses");
  const expenses: ExpenseRecord[] = expenseRows.map((row) => ({
    id: reqStr(row, "id", "expenses"),
    amount_minor: reqNum(row, "amount_minor", "expenses"),
    // BDT-only by contract (the service never writes another currency);
    // a hand-edited row with another currency falls back to BDT, the
    // same asEnum fallback pattern used for status columns above.
    currency: asEnum(str(row, "currency"), ["BDT"] as const, "BDT"),
    expense_date: dateOnly(row, "expense_date") ?? "",
    category_id: reqStr(row, "category_id", "expenses"),
    product_id: str(row, "product_id"),
    payment_method_id: str(row, "payment_method_id"),
    vendor: str(row, "vendor"),
    notes: str(row, "notes"),
    receipt_media_id: str(row, "receipt_media_id"),
    recorded_by: str(row, "recorded_by"),
    created_at: reqIso(row, "created_at", "expenses"),
    updated_at: reqIso(row, "updated_at", "expenses"),
  }));

  // -- Licenses (snapshots + items + activations) -----------------------------
  const licenseSnapshotItemRows = loadRows(combined, "licenseSnapshotItems");
  const licenseSnapshotItemsBySnapshot = groupBy(licenseSnapshotItemRows, (r) =>
    String(r["snapshot_id"])
  );
  const licenseSnapshotRows = loadRows(combined, "licenseSnapshots");
  const licenseSnapshotsByLicense = groupBy(licenseSnapshotRows, (r) =>
    String(r["license_id"])
  );
  const activationRows = loadRows(combined, "activations");
  const activationsByLicense = groupBy(activationRows, (r) => String(r["license_id"]));
  const licenseRows = loadRows(combined, "licenses");
  const licenses: LicenseRecord[] = licenseRows.map((row) => {
    const id = reqStr(row, "id", "licenses");
    const snapshots: LicenseEntitlementSnapshotRecord[] = (
      licenseSnapshotsByLicense.get(id) ?? []
    ).map((s) => {
      const snapId = reqStr(s, "id", "license_entitlement_snapshots");
      return {
        id: snapId,
        license_id: id,
        version_number: reqNum(s, "version_number", "license_entitlement_snapshots"),
        source_type: asEnum(
          str(s, "source_type"),
          ["order_item", "subscription_period", "manual_grant", "admin_adjustment"] as const,
          "manual_grant"
        ),
        effective_at: reqIso(s, "effective_at", "license_entitlement_snapshots"),
        reason: str(s, "reason"),
        snapshot_hash: reqStr(s, "snapshot_hash", "license_entitlement_snapshots"),
        items: (licenseSnapshotItemsBySnapshot.get(snapId) ?? []).map((it) => ({
          feature_key_snapshot: reqStr(
            it,
            "feature_key_snapshot",
            "license_entitlement_snapshot_items"
          ),
          value_type_snapshot: asEnum(
            str(it, "value_type_snapshot"),
            ["boolean", "limit", "quota", "metered"] as const,
            "boolean"
          ),
          entitlement_value: it["entitlement_value"] ?? null,
          unit_snapshot: str(it, "unit_snapshot"),
        })),
        created_by_user_id: str(s, "created_by_user_id"),
        created_at: reqIso(s, "created_at", "license_entitlement_snapshots"),
      };
    });
    const activations: LicenseActivationRecord[] = (
      activationsByLicense.get(id) ?? []
    ).map((a) => ({
      id: reqStr(a, "id", "license_activations"),
      license_id: id,
      installation_id_hash: reqStr(a, "installation_id_hash", "license_activations"),
      domain_normalized: str(a, "domain_normalized"),
      environment: asEnum(
        str(a, "environment"),
        ["production", "staging", "development", "other"] as const,
        "production"
      ),
      status: asEnum(
        str(a, "status"),
        ["active", "deactivated", "blocked"] as const,
        "active"
      ),
      activated_at: reqIso(a, "activated_at", "license_activations"),
      last_seen_at: iso(a, "last_seen_at") ?? reqIso(a, "activated_at", "license_activations"),
      deactivated_at: iso(a, "deactivated_at"),
      metadata: asJsonObject(a, "metadata"),
      created_at: reqIso(a, "created_at", "license_activations"),
    }));
    return {
      id,
      license_number: reqStr(row, "license_number", "licenses"),
      product_id: reqStr(row, "product_id", "licenses"),
      customer_id: reqStr(row, "customer_id", "licenses"),
      source_order_item_id: str(row, "source_order_item_id"),
      subscription_id: str(row, "subscription_id"),
      license_key_hash: reqStr(row, "license_key_hash", "licenses"),
      license_key_hint: reqStr(row, "license_key_hint", "licenses"),
      // issued_raw_key_once is NEVER persisted (issuance-tx response only).
      status: asEnum(
        str(row, "status"),
        ["pending", "active", "expired", "suspended", "revoked"] as const,
        "pending"
      ),
      activation_limit: reqNum(row, "activation_limit", "licenses"),
      valid_from: reqIso(row, "valid_from", "licenses"),
      expires_at: iso(row, "expires_at"),
      grace_until: iso(row, "grace_until"),
      // A license without snapshots is degraded data (issuance always
      // creates one); fall back to the first snapshot id, else "" — the
      // license stays listable and validation fails closed for it alone.
      current_entitlement_snapshot_id:
        str(row, "current_entitlement_snapshot_id") ??
        snapshots[0]?.id ??
        "",
      snapshots,
      activations,
      issued_at: iso(row, "issued_at") ?? reqIso(row, "created_at", "licenses"),
      created_at: reqIso(row, "created_at", "licenses"),
      updated_at: reqIso(row, "updated_at", "licenses"),
    };
  });

  // -- Tracking -----------------------------------------------------------------
  const trackingConfigRows = loadRows(combined, "trackingConfigs");
  const tracking_configurations: TrackingConfigRecord[] = trackingConfigRows.map(
    (row) => ({
      id: reqStr(row, "id", "tracking_configurations"),
      integrated_site_id: reqStr(row, "integrated_site_id", "tracking_configurations"),
      provider: asEnum(str(row, "provider"), ["meta", "tiktok"] as const, "meta"),
      label: str(row, "label"),
      pixel_id: reqStr(row, "pixel_id", "tracking_configurations"),
      access_token_ciphertext: reqStr(row, "access_token_ciphertext", "tracking_configurations"),
      encryption_key_version: reqStr(row, "encryption_key_version", "tracking_configurations"),
      test_event_code: str(row, "test_event_code"),
      enabled_events: asJsonArray<string>(row, "enabled_events"),
      status: asEnum(str(row, "status"), ["enabled", "disabled"] as const, "enabled"),
      created_at: reqIso(row, "created_at", "tracking_configurations"),
      updated_at: reqIso(row, "updated_at", "tracking_configurations"),
      rotated_at: iso(row, "rotated_at"),
    })
  );

  const trackingEventRows = loadRows(combined, "trackingEvents");
  const tracking_events: TrackingEventRecord[] = trackingEventRows.map((row) => ({
    id: reqStr(row, "id", "tracking_events"),
    integrated_site_id: reqStr(row, "integrated_site_id", "tracking_events"),
    event_name: reqStr(row, "event_name", "tracking_events"),
    event_id: reqStr(row, "event_id", "tracking_events"),
    event_time: reqIso(row, "event_time", "tracking_events"),
    event_source_url: str(row, "event_source_url"),
    order_id: str(row, "order_id"),
    consent_state: asEnum(str(row, "consent_state"), ["granted", "denied"] as const, "denied"),
    consent_policy_version: reqStr(row, "consent_policy_version", "tracking_events"),
    sanitized_payload: asJsonObject(row, "sanitized_payload"),
    status: asEnum(
      str(row, "status"),
      // C-2/D-6: "simulated" must survive the load — without it a
      // simulated event would silently reload as "received".
      ["received", "queued", "processed", "rejected", "simulated"] as const,
      "received"
    ),
    delivery_attempts: caps.trackingEventsDelivery
      ? reqNum(row, "delivery_attempts", "tracking_events")
      : 0,
    delivered_at: caps.trackingEventsDelivery ? iso(row, "delivered_at") : null,
    created_at: reqIso(row, "created_at", "tracking_events"),
  }));

  // -- Webhooks / outbox / idempotency / audit ----------------------------------
  const endpointSecretRows = loadRows(combined, "endpointSecrets");
  const secretsByEndpoint = groupBy(endpointSecretRows, (r) =>
    String(r["webhook_endpoint_id"])
  );
  const endpointRows = loadRows(combined, "endpoints");
  const webhook_endpoints: WebhookEndpointRecord[] = endpointRows.map((row) => {
    const id = reqStr(row, "id", "webhook_endpoints");
    const secrets = secretsByEndpoint.get(id) ?? [];
    // Prefer the active secret; fall back to the latest row. An endpoint
    // with no secret row at all is corrupt (registration always creates
    // one) — fail the load rather than inventing secret material.
    const active = [...secrets].reverse().find((s) => str(s, "status") === "active");
    const chosen = active ?? secrets[secrets.length - 1];
    if (!chosen) {
      throw new Error(
        `DrizzleStore: webhook_endpoints row ${id} has no webhook_endpoint_secrets row. The endpoint cannot be loaded losslessly; repair the data.`
      );
    }
    return {
      id,
      integrated_site_id: str(row, "integrated_site_id"),
      url: reqStr(row, "url", "webhook_endpoints"),
      description: reqStr(row, "description", "webhook_endpoints"),
      subscribed_events: asJsonArray<string>(row, "subscribed_events"),
      status: asEnum(
        str(row, "status"),
        ["active", "disabled", "revoked"] as const,
        "active"
      ),
      secret_key_id: reqStr(chosen, "key_id", "webhook_endpoint_secrets"),
      secret_ciphertext: reqStr(chosen, "secret_ciphertext", "webhook_endpoint_secrets"),
      key_version: reqStr(chosen, "key_version", "webhook_endpoint_secrets"),
      created_at: reqIso(row, "created_at", "webhook_endpoints"),
    };
  });

  const deliveryRows = loadRows(combined, "deliveries");
  const webhook_deliveries = deliveryRows.map((row) => ({
    id: reqStr(row, "id", "webhook_deliveries"),
    webhook_endpoint_id: reqStr(row, "webhook_endpoint_id", "webhook_deliveries"),
    event_id: reqStr(row, "event_id", "webhook_deliveries"),
    delivery_id: reqStr(row, "delivery_id", "webhook_deliveries"),
    status: asEnum(
      str(row, "status"),
      // C-2/D-6: "simulated" must survive the load.
      ["pending", "delivered", "retrying", "failed", "simulated"] as const,
      "pending"
    ),
    attempt_count: reqNum(row, "attempt_count", "webhook_deliveries"),
    last_http_status: num(row, "last_http_status"),
    delivered_at: iso(row, "delivered_at"),
  }));

  const outboxRows = loadRows(combined, "outbox");
  const outbox_events: OutboxEventRecord[] = outboxRows.map((row) => ({
    id: reqStr(row, "id", "outbox_events"),
    event_key: reqStr(row, "event_key", "outbox_events"),
    aggregate_type: reqStr(row, "aggregate_type", "outbox_events"),
    aggregate_id: reqStr(row, "aggregate_id", "outbox_events"),
    event_type: reqStr(row, "event_type", "outbox_events"),
    payload: asJsonObject(row, "payload"),
    status: asEnum(
      str(row, "status"),
      // C-2/D-6: "simulated" must survive the load — without it a
      // simulated outbox row would silently reload as "pending"
      // and the next cron would try to deliver it for real.
      // Q3: same for "skipped" — without it a skipped row would
      // reload as "pending" and be re-claimed (and re-skipped)
      // on every cron run.
      ["pending", "processing", "delivered", "dead_letter", "simulated", "skipped"] as const,
      "pending"
    ),
    attempt_count: reqNum(row, "attempt_count", "outbox_events"),
    available_at: reqIso(row, "available_at", "outbox_events"),
    locked_until: iso(row, "locked_until"),
    locked_by: str(row, "locked_by"),
    last_error_code: str(row, "last_error_code"),
    created_at: reqIso(row, "created_at", "outbox_events"),
    processed_at: iso(row, "processed_at"),
  }));

  const idempotencyRows = loadRows(combined, "idempotency");
  const idempotency_records: IdempotencyRecord[] = idempotencyRows.map((row) => {
    let response_body: unknown;
    if (caps.idempotencyResponseBody) {
      response_body = row["response_body"] ?? null;
    } else {
      // Migration-0002-less fallback: small bodies were stored JSON-encoded
      // in response_reference (see persist). Parse them back when possible.
      const ref = str(row, "response_reference");
      if (ref !== null && (ref.startsWith("{") || ref.startsWith("["))) {
        try {
          response_body = JSON.parse(ref) as unknown;
        } catch {
          response_body = ref;
        }
      } else {
        response_body = ref ?? null;
      }
    }
    return {
      id: reqStr(row, "id", "idempotency_records"),
      scope_key: reqStr(row, "scope_key", "idempotency_records"),
      idempotency_key: reqStr(row, "idempotency_key", "idempotency_records"),
      request_hash: reqStr(row, "request_hash", "idempotency_records"),
      status: asEnum(
        str(row, "status"),
        ["processing", "completed", "failed"] as const,
        "completed"
      ),
      response_status: num(row, "response_status") ?? 0,
      response_body,
      expires_at: reqIso(row, "expires_at", "idempotency_records"),
      created_at: reqIso(row, "created_at", "idempotency_records"),
    };
  });

  const auditRows = loadRows(combined, "audit");
  const audit_logs: AuditLogRecord[] = auditRows.map((row) => ({
    id: reqStr(row, "id", "audit_logs"),
    actor_type: asEnum(
      str(row, "actor_type"),
      ["staff", "system", "integration"] as const,
      "system"
    ),
    actor_user_id: str(row, "actor_user_id"),
    integrated_site_id: str(row, "integrated_site_id"),
    action: reqStr(row, "action", "audit_logs"),
    resource_type: reqStr(row, "resource_type", "audit_logs"),
    resource_id: reqStr(row, "resource_id", "audit_logs"),
    outcome: asEnum(
      str(row, "outcome"),
      ["success", "denied", "failed"] as const,
      "failed"
    ),
    request_id: str(row, "request_id") ?? "",
    changes: asJsonObject(row, "changes"),
    created_at: reqIso(row, "created_at", "audit_logs"),
  }));

  // -- License events (table since 0000; wired up in 0009) --------------------
  const licenseEventRows = loadRows(combined, "licenseEvents");
  const license_events: LicenseEventRecord[] = licenseEventRows.map((row) => ({
    id: reqStr(row, "id", "license_events"),
    license_id: reqStr(row, "license_id", "license_events"),
    event_type: reqStr(row, "event_type", "license_events"),
    actor_type: asEnum(
      str(row, "actor_type"),
      ["system", "staff", "client"] as const,
      "system"
    ),
    actor_user_id: str(row, "actor_user_id"),
    activation_id: str(row, "activation_id"),
    metadata: asJsonObject(row, "metadata"),
    created_at: reqIso(row, "created_at", "license_events"),
  }));

  // -- Reminder settings (migration 0009, read-only state — no SyncSpec,
  // same pattern as two_factor_policy: the reminders service writes via
  // direct Drizzle).
  const reminder_settings: ReminderSettingsRecord[] = loadRows(combined, "reminderSettings").map(
    (row) => ({
      id: reqStr(row, "id", "reminder_settings"),
      due_offsets_days: asJsonArray<number>(row, "due_offsets_days") ?? [7, 1],
      overdue_offsets_days: asJsonArray<number>(row, "overdue_offsets_days") ?? [1, 3],
      overdue_enabled: bool(row, "overdue_enabled"),
      updated_at: reqIso(row, "updated_at", "reminder_settings"),
    })
  );

  const sentReminderRows = loadRows(combined, "sentReminders");
  const sent_reminders: SentReminderRecord[] = sentReminderRows.map((row) => ({
    id: reqStr(row, "id", "sent_reminders"),
    kind: asEnum(
      str(row, "kind"),
      [
        "installment_due",
        "installment_overdue",
        "subscription_renewal",
        "subscription_overdue",
      ] as const,
      "installment_due"
    ),
    reference_id: reqStr(row, "reference_id", "sent_reminders"),
    offset_days: reqNum(row, "offset_days", "sent_reminders"),
    sent_at: reqIso(row, "sent_at", "sent_reminders"),
  }));

  // -- Support tickets + comments (migration 0009) ---------------------------
  const supportTicketRows = loadRows(combined, "supportTickets");
  const support_tickets: SupportTicketRecord[] = supportTicketRows.map((row) => ({
    id: reqStr(row, "id", "support_tickets"),
    ticket_number: reqStr(row, "ticket_number", "support_tickets"),
    customer_id: str(row, "customer_id"),
    order_id: str(row, "order_id"),
    subscription_id: str(row, "subscription_id"),
    license_id: str(row, "license_id"),
    product_id: str(row, "product_id"),
    title: reqStr(row, "title", "support_tickets"),
    description: str(row, "description") ?? "",
    status: asEnum(
      str(row, "status"),
      ["open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const,
      "open"
    ),
    priority: asEnum(
      str(row, "priority"),
      ["low", "medium", "high", "urgent"] as const,
      "medium"
    ),
    category: asEnum(
      str(row, "category"),
      ["billing", "technical", "license", "order", "other"] as const,
      "other"
    ),
    reporter_user_id: reqStr(row, "reporter_user_id", "support_tickets"),
    source_note: str(row, "source_note"),
    assignee_user_id: str(row, "assignee_user_id"),
    created_at: reqIso(row, "created_at", "support_tickets"),
    updated_at: reqIso(row, "updated_at", "support_tickets"),
    resolved_at: iso(row, "resolved_at"),
    closed_at: iso(row, "closed_at"),
  }));

  const ticketCommentRows = loadRows(combined, "ticketComments");
  const ticket_comments: TicketCommentRecord[] = ticketCommentRows.map((row) => ({
    id: reqStr(row, "id", "ticket_comments"),
    ticket_id: reqStr(row, "ticket_id", "ticket_comments"),
    author_user_id: reqStr(row, "author_user_id", "ticket_comments"),
    body: reqStr(row, "body", "ticket_comments"),
    is_internal: bool(row, "is_internal"),
    created_at: reqIso(row, "created_at", "ticket_comments"),
  }));

  // -- Leads (migration 0009) --------------------------------------------------
  const leadRows = loadRows(combined, "leads");
  const leads: LeadRecord[] = leadRows.map((row) => ({
    id: reqStr(row, "id", "leads"),
    lead_number: reqStr(row, "lead_number", "leads"),
    name: reqStr(row, "name", "leads"),
    email: str(row, "email"),
    normalized_email: str(row, "normalized_email"),
    phone: str(row, "phone"),
    normalized_phone: str(row, "normalized_phone"),
    whatsapp: str(row, "whatsapp"),
    source_site_id: str(row, "source_site_id"),
    utm_source: str(row, "utm_source"),
    utm_medium: str(row, "utm_medium"),
    utm_campaign: str(row, "utm_campaign"),
    interest: str(row, "interest"),
    product_id: str(row, "product_id"),
    message: str(row, "message"),
    notes: str(row, "notes"),
    status: asEnum(
      str(row, "status"),
      ["new", "contacted", "qualified", "converted", "lost"] as const,
      "new"
    ),
    assignee_user_id: str(row, "assignee_user_id"),
    created_at: reqIso(row, "created_at", "leads"),
    updated_at: reqIso(row, "updated_at", "leads"),
    converted_at: iso(row, "converted_at"),
    converted_customer_id: str(row, "converted_customer_id"),
    converted_order_id: str(row, "converted_order_id"),
  }));

  // 2FA policy rows (migration 0007, read-only state — no SyncSpec, so
  // persistStateDiff never writes them; the auth-config service writes
  // via direct Drizzle). Empty on a pre-0007 database (the combined
  // query only selects the table when caps.authEmailTables is true).
  const two_factor_policy: TwoFactorPolicyRecord[] = caps.authEmailTables
    ? loadRows(combined, "twoFactorPolicy").map((row) => ({
        id: reqStr(row, "id", "auth_two_factor_policy"),
        scope: reqStr(row, "scope", "auth_two_factor_policy"),
        mode: asEnum(
          str(row, "mode"),
          ["off", "optional", "required"] as const,
          "off"
        ),
        updated_at: reqIso(row, "updated_at", "auth_two_factor_policy"),
      }))
    : [];

  // -- Sequence counters --------------------------------------------------------
  const state: DatabaseState = {
    users,
    sessions,
    roles,
    staff_invitations,
    user_roles,
    uploaded_assets,
    media_assets,
    products,
    product_features,
    product_packages,
    package_versions,
    package_prices,
    customers,
    customer_contacts,
    customer_addresses,
    customer_reports,
    orders,
    order_installments,
    invoices,
    payment_providers,
    payment_methods,
    payment_submissions,
    payment_transactions,
    payment_verification_logs,
    payment_refunds,
    expense_categories,
    expenses,
    subscriptions,
    licenses,
    license_events,
    reminder_settings,
    sent_reminders,
    support_tickets,
    ticket_comments,
    leads,
    integrated_sites,
    site_credentials,
    request_nonces,
    tracking_configurations,
    tracking_events,
    webhook_endpoints,
    webhook_deliveries,
    outbox_events,
    idempotency_records,
    audit_logs,
    two_factor_policy,
    sequence_counters: { ...COUNTER_BASE_VALUES },
  };

  if (caps.sequenceCounters) {
    const counterRows = loadRows(combined, "counters");
    const values: DatabaseState["sequence_counters"] = { ...COUNTER_BASE_VALUES };
    for (const row of counterRows) {
      const key = str(row, "counter_key");
      const value = num(row, "counter_value");
      if (
        key !== null &&
        value !== null &&
        (key === "customer" ||
          key === "order" ||
          key === "invoice" ||
          key === "subscription" ||
          key === "license" ||
          key === "ticket" ||
          key === "lead")
      ) {
        values[key] = value;
      }
    }
    state.sequence_counters = values;
  } else {
    // No migration 0002: derive from the data (in-memory only — a restart
    // re-derives; numbers already minted stay reserved because they exist
    // as rows). Persisted counters require 0002.
    state.sequence_counters = deriveCountersFromData(state);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Persisting (diff the before/after snapshots back to the DB, same tx)
// ---------------------------------------------------------------------------

interface SyncSpec<T> {
  keyOf: (row: T) => string;
  scalarOf: (row: T) => unknown;
  insert: (client: Client, row: T) => Promise<void>;
  update: (client: Client, before: T, after: T) => Promise<void>;
  remove: (client: Client, row: T) => Promise<void>;
  /** Append-only tables (migration 0000 immutability triggers). */
  immutable?: boolean;
  /**
   * B-04: optional multi-row batch insert. When present, syncUpserts
   * inserts ALL new rows of this table in ONE statement
   * (`INSERT ... VALUES (...), (...)`) instead of one round-trip per
   * row. Must insert exactly the rows `insert` would (same columns
   * and values); updates still go one row at a time.
   */
  insertMany?: (client: Client, rows: T[]) => Promise<void>;
}

function immutableError(table: string, key: string, op: string): Error {
  return new Error(
    `DrizzleStore: refusing to ${op} immutable ${table} row ${key}. Historical snapshots, verification logs and audit logs are append-only (migration 0000 triggers enforce this); a service mutated or removed a row it must only ever insert.`
  );
}

async function syncDeletes<T>(
  client: Client,
  before: T[],
  after: T[],
  spec: SyncSpec<T>,
  table: string
): Promise<void> {
  const afterKeys = new Set(after.map(spec.keyOf));
  for (const row of before) {
    if (!afterKeys.has(spec.keyOf(row))) {
      if (spec.immutable) throw immutableError(table, spec.keyOf(row), "delete");
      await spec.remove(client, row);
    }
  }
}

async function syncUpserts<T>(
  client: Client,
  before: T[],
  after: T[],
  spec: SyncSpec<T>,
  table: string
): Promise<Set<string>> {
  const touched = new Set<string>();
  const beforeByKey = new Map(before.map((r) => [spec.keyOf(r), r]));
  // B-04: collect new rows first — updates run one row at a time (as
  // before), but inserts go through `insertMany` in ONE multi-row
  // statement when the spec provides it, instead of N sequential
  // round-trips on the single pinned client.
  const newRows: T[] = [];
  for (const row of after) {
    const key = spec.keyOf(row);
    const prev = beforeByKey.get(key);
    if (prev === undefined) {
      newRows.push(row);
      touched.add(key);
    } else if (
      JSON.stringify(spec.scalarOf(prev)) !== JSON.stringify(spec.scalarOf(row))
    ) {
      if (spec.immutable) throw immutableError(table, key, "update");
      await spec.update(client, prev, row);
      touched.add(key);
    }
  }
  if (newRows.length > 0) {
    if (spec.insertMany) {
      await spec.insertMany(client, newRows);
    } else {
      for (const row of newRows) {
        await spec.insert(client, row);
      }
    }
  }
  return touched;
}

function insertSql(table: string, columns: string[]): string {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const params = columns.map((_, i) => `$${i + 1}`).join(", ");
  return `INSERT INTO "${table}" (${cols}) VALUES (${params})`;
}

/**
 * B-04: one multi-row INSERT statement for a batch of rows
 * (`INSERT ... VALUES (...), (...)`). Returns the SQL text + the
 * flattened parameter values in row order.
 */
function insertManySql(
  table: string,
  columns: string[],
  rowsValues: unknown[][]
): { text: string; values: unknown[] } {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const values: unknown[] = [];
  const groups = rowsValues.map((rowVals) => {
    const params = rowVals.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    return `(${params.join(", ")})`;
  });
  return { text: `INSERT INTO "${table}" (${cols}) VALUES ${groups.join(", ")}`, values };
}

function updateSql(
  table: string,
  columns: string[],
  whereClause: string,
  touchUpdatedAt: boolean
): string {
  const set = columns.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
  const touch = touchUpdatedAt ? `, "updated_at" = now()` : "";
  return `UPDATE "${table}" SET ${set}${touch} WHERE ${whereClause}`;
}

type UserRoleRow = DatabaseState["user_roles"][number];
type RequestNonceRow = DatabaseState["request_nonces"][number];
type WebhookDeliveryRow = DatabaseState["webhook_deliveries"][number];
type OrderSnapshotItemRow = OrderItemSnapshotRecord["items"][number] & {
  snapshot_id: string;
};
type LicenseSnapshotItemRow =
  LicenseEntitlementSnapshotRecord["items"][number] & { snapshot_id: string };
type InvoiceItemRow = InvoiceRecord["items"][number] & { invoice_id: string };
type SiteDomainRow = IntegratedSiteRecord["domains"][number] & {
  integrated_site_id: string;
};

function flattenState(s: DatabaseState): {
  orderItems: OrderItemRecord[];
  orderSnapshots: OrderItemSnapshotRecord[];
  orderSnapshotItems: OrderSnapshotItemRow[];
  invoiceItems: InvoiceItemRow[];
  periods: SubscriptionPeriodRecord[];
  versionFeatures: PackageVersionFeatureGrant[];
  domains: SiteDomainRow[];
  licenseSnapshots: LicenseEntitlementSnapshotRecord[];
  licenseSnapshotItems: LicenseSnapshotItemRow[];
  licenseActivations: LicenseActivationRecord[];
} {
  return {
    orderItems: s.orders.flatMap((o) => o.items),
    orderSnapshots: s.orders.flatMap((o) =>
      o.items.map((i) => i.entitlement_snapshot)
    ),
    orderSnapshotItems: s.orders.flatMap((o) =>
      o.items.flatMap((i) =>
        i.entitlement_snapshot.items.map((it) => ({
          ...it,
          snapshot_id: i.entitlement_snapshot.id,
        }))
      )
    ),
    invoiceItems: s.invoices.flatMap((i) =>
      i.items.map((it) => ({ ...it, invoice_id: i.id }))
    ),
    periods: s.subscriptions.flatMap((x) => x.periods),
    versionFeatures: s.package_versions.flatMap((v) => v.features),
    domains: s.integrated_sites.flatMap((x) =>
      x.domains.map((d) => ({ ...d, integrated_site_id: x.id }))
    ),
    licenseSnapshots: s.licenses.flatMap((l) => l.snapshots),
    licenseSnapshotItems: s.licenses.flatMap((l) =>
      l.snapshots.flatMap((sn) =>
        sn.items.map((it) => ({ ...it, snapshot_id: sn.id }))
      )
    ),
    licenseActivations: s.licenses.flatMap((l) => l.activations),
  };
}

function immutableStub<T>(): SyncSpec<T>["insert"] {
  return async () => {
    throw new Error(
      "DrizzleStore: internal error — immutable table write reached a stub."
    );
  };
}

/**
 * Diff-persist `after` over `before` inside the caller's transaction.
 *
 * Deletes run first (children before parents, so RESTRICT foreign keys
 * never fire), then inserts + updates (parents before children). Derived
 * rows that live in their own tables (distribution channels, role
 * permissions, site products, transfer rails, attributions, webhook
 * secrets, staff profiles) are synced alongside their parent. Columns
 * that exist only with migration 0002 are skipped when the capability is
 * absent (see header note 3); license issuance and large idempotency
 * bodies fail closed with a clear "apply migration 0002" error instead.
 */
async function persistStateDiff(
  client: Client,
  caps: StoreCapabilities,
  before: DatabaseState,
  after: DatabaseState
): Promise<void> {
  const ins = (table: string, columns: string[], values: unknown[]) =>
    execSql(client, insertSql(table, columns), values);
  const upd = (
    table: string,
    columns: string[],
    values: unknown[],
    where: string,
    touch: boolean
  ) => execSql(client, updateSql(table, columns, where, touch), values);
  const del = (table: string, where: string, values: unknown[]) =>
    execSql(client, `DELETE FROM "${table}" WHERE ${where}`, values);
  const json = (v: unknown): string => JSON.stringify(v ?? null);
  const idWhere = (n: number): string => `"id" = $${n}`;

  const fb = flattenState(before);
  const fa = flattenState(after);
  const byId = <T extends { id: string }>(rows: T[]): Map<string, T> =>
    new Map(rows.map((r) => [r.id, r]));
  const beforeUsers = byId(before.users);
  const afterUsers = byId(after.users);
  const beforeRoles = byId(before.roles);
  const beforeProducts = byId(before.products);
  const beforeMethods = byId(before.payment_methods);
  const beforeOrders = byId(before.orders);
  const beforeSites = byId(before.integrated_sites);
  const beforeEndpoints = byId(before.webhook_endpoints);

  // -- Specs ---------------------------------------------------------------
  const userSpec: SyncSpec<UserRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      const cols = ["id", "name", "email", "email_verified", "created_at", "updated_at"];
      const vals: unknown[] = [r.id, r.name, r.email, r.email_verified, r.created_at, r.updated_at];
      if (caps.usersPasswordHash) {
        cols.push("password_hash");
        vals.push(r.password_hash);
      }
      if (caps.usersAvatarUrl) {
        cols.push("avatar_url");
        vals.push(r.avatar_url ?? null);
      }
      await ins("users", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = ["name", "email", "email_verified", "updated_at"];
      const vals: unknown[] = [r.name, r.email, r.email_verified, r.updated_at];
      if (caps.usersPasswordHash) {
        cols.push("password_hash");
        vals.push(r.password_hash);
      }
      if (caps.usersAvatarUrl) {
        cols.push("avatar_url");
        vals.push(r.avatar_url ?? null);
      }
      await upd("users", cols, [...vals, r.id], idWhere(cols.length + 1), false);
    },
    remove: async (c, r) => {
      await del("users", idWhere(1), [r.id]);
    },
  };

  const sessionSpec: SyncSpec<SessionRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "sessions",
        ["id", "token", "user_id", "ip_address", "user_agent", "expires_at", "created_at"],
        [r.id, r.token, r.user_id, r.ip_address, r.user_agent, r.expires_at, r.created_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["token", "user_id", "ip_address", "user_agent", "expires_at"];
      await upd(
        "sessions",
        cols,
        [r.token, r.user_id, r.ip_address, r.user_agent, r.expires_at, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("sessions", idWhere(1), [r.id]);
    },
  };

  const roleSpec: SyncSpec<RoleRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, permission_keys: [] }),
    insert: async (c, r) => {
      await ins(
        "roles",
        ["id", "key", "name", "description", "is_system", "created_at"],
        [r.id, r.key, r.name, r.description, r.is_system, r.created_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["key", "name", "description", "is_system"];
      await upd(
        "roles",
        cols,
        [r.key, r.name, r.description, r.is_system, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("roles", idWhere(1), [r.id]);
    },
  };

  const invitationSpec: SyncSpec<StaffInvitationRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "staff_invitations",
        ["id", "email", "name", "role_keys", "token_hash", "status", "expires_at",
          "invited_by_user_id", "accepted_user_id", "accepted_at", "revoked_at",
          "created_at", "updated_at"],
        [r.id, r.email, r.name, json(r.role_keys), r.token_hash, r.status, r.expires_at,
          r.invited_by_user_id, r.accepted_user_id, r.accepted_at, r.revoked_at,
          r.created_at, r.updated_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["email", "name", "role_keys", "token_hash", "status", "expires_at",
        "invited_by_user_id", "accepted_user_id", "accepted_at", "revoked_at"];
      await upd(
        "staff_invitations",
        cols,
        [r.email, r.name, json(r.role_keys), r.token_hash, r.status, r.expires_at,
          r.invited_by_user_id, r.accepted_user_id, r.accepted_at, r.revoked_at, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("staff_invitations", idWhere(1), [r.id]);
    },
  };

  const userRoleSpec: SyncSpec<UserRoleRow> = {
    keyOf: (r) => `${r.user_id}|${r.role_id}`,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "user_roles",
        ["id", "user_id", "role_id", "created_at"],
        [randomUUID(), r.user_id, r.role_id, r.assigned_at]
      );
    },
    update: async (c, _b, r) => {
      await upd(
        "user_roles",
        ["created_at"],
        [r.assigned_at, r.user_id, r.role_id],
        `"user_id" = $2 AND "role_id" = $3`,
        false
      );
    },
    remove: async (c, r) => {
      await del("user_roles", `"user_id" = $1 AND "role_id" = $2`, [
        r.user_id,
        r.role_id,
      ]);
    },
  };

  const assetSpec: SyncSpec<UploadedAssetRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "uploaded_assets",
        [
          "id",
          "object_key",
          "bucket_name",
          "original_filename",
          "content_type",
          "byte_size",
          "checksum_sha256",
          "visibility",
          "uploaded_by_user_id",
          "owner_customer_id",
          "created_at",
        ],
        [
          r.id,
          r.object_key,
          r.bucket_name,
          r.original_filename,
          r.content_type,
          r.byte_size,
          r.checksum_sha256,
          r.visibility,
          r.uploaded_by_user_id,
          r.owner_customer_id,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "object_key",
        "bucket_name",
        "original_filename",
        "content_type",
        "byte_size",
        "checksum_sha256",
        "visibility",
        "uploaded_by_user_id",
        "owner_customer_id",
      ];
      await upd(
        "uploaded_assets",
        cols,
        [
          r.object_key,
          r.bucket_name,
          r.original_filename,
          r.content_type,
          r.byte_size,
          r.checksum_sha256,
          r.visibility,
          r.uploaded_by_user_id,
          r.owner_customer_id,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("uploaded_assets", idWhere(1), [r.id]);
    },
  };

  // Media library (PLAN §31): per-row driver so a driver switch never orphans files.
  const mediaSpec: SyncSpec<MediaAssetRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "media_assets",
        [
          "id",
          "object_key",
          "driver",
          "original_filename",
          "mime_type",
          "byte_size",
          "checksum_sha256",
          "width",
          "height",
          "folder",
          "tags",
          "uploaded_by_user_id",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.object_key,
          r.driver,
          r.original_filename,
          r.mime_type,
          r.byte_size,
          r.checksum_sha256,
          r.width,
          r.height,
          r.folder,
          r.tags,
          r.uploaded_by_user_id,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "object_key",
        "driver",
        "original_filename",
        "mime_type",
        "byte_size",
        "checksum_sha256",
        "width",
        "height",
        "folder",
        "tags",
        "uploaded_by_user_id",
      ];
      await upd(
        "media_assets",
        cols,
        [
          r.object_key,
          r.driver,
          r.original_filename,
          r.mime_type,
          r.byte_size,
          r.checksum_sha256,
          r.width,
          r.height,
          r.folder,
          r.tags,
          r.uploaded_by_user_id,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("media_assets", idWhere(1), [r.id]);
    },
  };

  const customerSpec: SyncSpec<CustomerRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "customers",
        [
          "id",
          "customer_number",
          "customer_type",
          "name",
          "email",
          "normalized_email",
          "phone",
          "normalized_phone",
          "whatsapp",
          "credit_balance_minor",
          "company_name",
          "website",
          "country_code",
          "status",
          "registration_source",
          "notes",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.customer_number,
          r.customer_type,
          r.name,
          r.email,
          r.normalized_email,
          r.phone,
          r.normalized_phone,
          r.whatsapp,
          r.credit_balance_minor,
          r.company_name,
          r.website,
          r.country_code,
          r.status,
          r.registration_source,
          r.notes,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "customer_number",
        "customer_type",
        "name",
        "email",
        "normalized_email",
        "phone",
        "normalized_phone",
        "whatsapp",
        "credit_balance_minor",
        "company_name",
        "website",
        "country_code",
        "status",
        "registration_source",
        "notes",
        "updated_at",
      ];
      await upd(
        "customers",
        cols,
        [
          r.customer_number,
          r.customer_type,
          r.name,
          r.email,
          r.normalized_email,
          r.phone,
          r.normalized_phone,
          r.whatsapp,
          r.credit_balance_minor,
          r.company_name,
          r.website,
          r.country_code,
          r.status,
          r.registration_source,
          r.notes,
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("customers", idWhere(1), [r.id]);
    },
  };

  // -- Customer operations (migration 0009) ----------------------------------
  const customerContactSpec: SyncSpec<CustomerContactRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "customer_contacts",
        ["id", "customer_id", "kind", "value", "normalized_value", "created_at"],
        [r.id, r.customer_id, r.kind, r.value, r.normalized_value, r.created_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["customer_id", "kind", "value", "normalized_value"];
      await upd(
        "customer_contacts",
        cols,
        [r.customer_id, r.kind, r.value, r.normalized_value, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("customer_contacts", idWhere(1), [r.id]);
    },
  };

  const customerAddressSpec: SyncSpec<CustomerAddressRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "customer_addresses",
        [
          "id",
          "customer_id",
          "address_type",
          "contact_name",
          "phone",
          "address_line_1",
          "address_line_2",
          "city",
          "state_or_region",
          "postal_code",
          "country_code",
          "is_default",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.customer_id,
          r.address_type,
          r.contact_name,
          r.phone,
          r.address_line_1,
          r.address_line_2,
          r.city,
          r.state_or_region,
          r.postal_code,
          r.country_code,
          r.is_default,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "address_type",
        "contact_name",
        "phone",
        "address_line_1",
        "address_line_2",
        "city",
        "state_or_region",
        "postal_code",
        "country_code",
        "is_default",
        "updated_at",
      ];
      await upd(
        "customer_addresses",
        cols,
        [
          r.address_type,
          r.contact_name,
          r.phone,
          r.address_line_1,
          r.address_line_2,
          r.city,
          r.state_or_region,
          r.postal_code,
          r.country_code,
          r.is_default,
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("customer_addresses", idWhere(1), [r.id]);
    },
  };

  const customerReportSpec: SyncSpec<CustomerReportRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "customer_reports",
        ["id", "customer_id", "author_user_id", "type", "detail", "created_at"],
        [r.id, r.customer_id, r.author_user_id, r.type, r.detail, r.created_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["type", "detail"];
      await upd(
        "customer_reports",
        cols,
        [r.type, r.detail, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("customer_reports", idWhere(1), [r.id]);
    },
  };

  const productSpec: SyncSpec<ProductRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, distribution_channels: [] }),
    insert: async (c, r) => {
      const cols = [
        "id",
        "code",
        "slug",
        "name",
        "description",
        "product_type",
        "fulfillment_type",
        "status",
        "website_url",
        "documentation_url",
        "logo_asset_id",
        "created_by_user_id",
        "created_at",
        "updated_at",
      ];
      const vals: unknown[] = [
        r.id,
        r.code,
        r.slug,
        r.name,
        r.description,
        r.product_type,
        r.fulfillment_type,
        r.status,
        r.website_url,
        r.documentation_url,
        r.logo_asset_id ?? null,
        r.created_by_user_id,
        r.created_at,
        r.updated_at,
      ];
      if (caps.productsDefaults) {
        cols.push("default_activation_limit", "offline_grace_hours");
        vals.push(r.default_activation_limit, r.offline_grace_hours);
      }
      await ins("products", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "code",
        "slug",
        "name",
        "description",
        "product_type",
        "fulfillment_type",
        "status",
        "website_url",
        "documentation_url",
        "logo_asset_id",
        "created_by_user_id",
        "updated_at",
      ];
      const vals: unknown[] = [
        r.code,
        r.slug,
        r.name,
        r.description,
        r.product_type,
        r.fulfillment_type,
        r.status,
        r.website_url,
        r.documentation_url,
        r.logo_asset_id ?? null,
        r.created_by_user_id,
        r.updated_at,
      ];
      if (caps.productsDefaults) {
        cols.push("default_activation_limit", "offline_grace_hours");
        vals.push(r.default_activation_limit, r.offline_grace_hours);
      }
      await upd("products", cols, [...vals, r.id], idWhere(cols.length + 1), false);
    },
    remove: async (c, r) => {
      await del("products", idWhere(1), [r.id]);
    },
  };

  const featureSpec: SyncSpec<ProductFeatureRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "product_features",
        [
          "id",
          "product_id",
          "feature_key",
          "name",
          "description",
          "value_type",
          "unit",
          "default_value",
          "status",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.product_id,
          r.feature_key,
          r.name,
          r.description,
          r.value_type,
          r.unit,
          json(r.default_value),
          r.status,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "product_id",
        "feature_key",
        "name",
        "description",
        "value_type",
        "unit",
        "default_value",
        "status",
        "updated_at",
      ];
      await upd(
        "product_features",
        cols,
        [
          r.product_id,
          r.feature_key,
          r.name,
          r.description,
          r.value_type,
          r.unit,
          json(r.default_value),
          r.status,
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("product_features", idWhere(1), [r.id]);
    },
  };

  const packageSpec: SyncSpec<ProductPackageRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    // current_version_id is deliberately NOT written here: on insert the
    // referenced version may not exist yet (same-tx cycle package ↔
    // version). It is backfilled by the fix-up pass after versions sync.
    insert: async (c, r) => {
      await ins(
        "product_packages",
        [
          "id",
          "product_id",
          "package_key",
          "name",
          "description",
          "status",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.product_id,
          r.package_key,
          r.name,
          r.description,
          r.status,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["product_id", "package_key", "name", "description", "status", "updated_at"];
      await upd(
        "product_packages",
        cols,
        [r.product_id, r.package_key, r.name, r.description, r.status, r.updated_at, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("product_packages", idWhere(1), [r.id]);
    },
  };

  const versionSpec: SyncSpec<PackageVersionRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, features: [] }),
    insert: async (c, r) => {
      await ins(
        "package_versions",
        [
          "id",
          "package_id",
          "product_id",
          "version_number",
          "status",
          "change_summary",
          "published_at",
          "created_at",
        ],
        [
          r.id,
          r.package_id,
          r.product_id,
          r.version_number,
          r.status,
          r.change_summary,
          r.published_at,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "package_id",
        "product_id",
        "version_number",
        "status",
        "change_summary",
        "published_at",
      ];
      await upd(
        "package_versions",
        cols,
        [
          r.package_id,
          r.product_id,
          r.version_number,
          r.status,
          r.change_summary,
          r.published_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("package_versions", idWhere(1), [r.id]);
    },
  };

  const versionFeatureSpec: SyncSpec<PackageVersionFeatureGrant> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      const cols = [
        "id",
        "package_version_id",
        "product_id",
        "product_feature_id",
        "feature_key_snapshot",
        "value_type_snapshot",
        "entitlement_value",
      ];
      const vals: unknown[] = [
        r.id,
        r.package_version_id,
        r.product_id,
        r.product_feature_id,
        r.feature_key_snapshot,
        r.value_type_snapshot,
        json(r.entitlement_value),
      ];
      if (caps.packageVersionFeaturesUnit) {
        cols.push("unit_snapshot");
        vals.push(r.unit_snapshot);
      }
      await ins("package_version_features", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "package_version_id",
        "product_id",
        "product_feature_id",
        "feature_key_snapshot",
        "value_type_snapshot",
        "entitlement_value",
      ];
      const vals: unknown[] = [
        r.package_version_id,
        r.product_id,
        r.product_feature_id,
        r.feature_key_snapshot,
        r.value_type_snapshot,
        json(r.entitlement_value),
      ];
      if (caps.packageVersionFeaturesUnit) {
        cols.push("unit_snapshot");
        vals.push(r.unit_snapshot);
      }
      await upd(
        "package_version_features",
        cols,
        [...vals, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("package_version_features", idWhere(1), [r.id]);
    },
  };

  const priceSpec: SyncSpec<PackagePriceRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      const cols = [
        "id",
        "package_version_id",
        "price_key",
        "price_kind",
        "amount_minor",
        "currency_code",
        "interval_unit",
        "interval_count",
        "trial_days",
        "setup_fee_minor",
        "status",
        "created_at",
      ];
      const vals: unknown[] = [
        r.id,
        r.package_version_id,
        r.price_key,
        r.price_kind,
        r.amount_minor,
        r.currency_code,
        r.interval_unit,
        r.interval_count,
        r.trial_days,
        r.setup_fee_minor,
        r.status,
        r.created_at,
      ];
      if (caps.packagePricesUsedInOrders) {
        cols.push("used_in_orders");
        vals.push(r.used_in_orders);
      }
      await ins("package_prices", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "package_version_id",
        "price_key",
        "price_kind",
        "amount_minor",
        "currency_code",
        "interval_unit",
        "interval_count",
        "trial_days",
        "setup_fee_minor",
        "status",
      ];
      const vals: unknown[] = [
        r.package_version_id,
        r.price_key,
        r.price_kind,
        r.amount_minor,
        r.currency_code,
        r.interval_unit,
        r.interval_count,
        r.trial_days,
        r.setup_fee_minor,
        r.status,
      ];
      if (caps.packagePricesUsedInOrders) {
        cols.push("used_in_orders");
        vals.push(r.used_in_orders);
      }
      await upd(
        "package_prices",
        cols,
        [...vals, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("package_prices", idWhere(1), [r.id]);
    },
  };

  const siteSpec: SyncSpec<IntegratedSiteRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, domains: [], product_ids: [] }),
    insert: async (c, r) => {
      await ins(
        "integrated_sites",
        [
          "id",
          "site_key",
          "name",
          "environment",
          "status",
          "api_version",
          "allowed_capabilities",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.site_key,
          r.name,
          r.environment,
          r.status,
          r.api_version,
          json(r.allowed_capabilities),
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "site_key",
        "name",
        "environment",
        "status",
        "api_version",
        "allowed_capabilities",
        "updated_at",
      ];
      await upd(
        "integrated_sites",
        cols,
        [
          r.site_key,
          r.name,
          r.environment,
          r.status,
          r.api_version,
          json(r.allowed_capabilities),
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("integrated_sites", idWhere(1), [r.id]);
    },
  };

  const domainSpec: SyncSpec<SiteDomainRow> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "site_domains",
        [
          "id",
          "integrated_site_id",
          "domain",
          "verification_method",
          "verification_challenge",
          "verification_status",
          "verified_at",
          "is_primary",
        ],
        [
          r.id,
          r.integrated_site_id,
          r.domain,
          r.verification_method,
          r.verification_challenge,
          r.verification_status,
          r.verified_at,
          r.is_primary,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "domain",
        "verification_method",
        "verification_challenge",
        "verification_status",
        "verified_at",
        "is_primary",
      ];
      await upd(
        "site_domains",
        cols,
        [
          r.domain,
          r.verification_method,
          r.verification_challenge,
          r.verification_status,
          r.verified_at,
          r.is_primary,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("site_domains", idWhere(1), [r.id]);
    },
  };

  const credentialSpec: SyncSpec<SiteCredentialRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "site_credentials",
        [
          "id",
          "integrated_site_id",
          "key_id",
          "credential_type",
          "secret_hash",
          "secret_ciphertext",
          "encryption_key_version",
          "scopes",
          "status",
          "created_at",
          "revoked_at",
          "last_used_at",
        ],
        [
          r.id,
          r.integrated_site_id,
          r.key_id,
          r.credential_type,
          r.secret_hash,
          r.secret_ciphertext,
          r.encryption_key_version,
          json(r.scopes),
          r.status,
          r.created_at,
          r.revoked_at,
          r.last_used_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "integrated_site_id",
        "key_id",
        "credential_type",
        "secret_hash",
        "secret_ciphertext",
        "encryption_key_version",
        "scopes",
        "status",
        "revoked_at",
        "last_used_at",
      ];
      await upd(
        "site_credentials",
        cols,
        [
          r.integrated_site_id,
          r.key_id,
          r.credential_type,
          r.secret_hash,
          r.secret_ciphertext,
          r.encryption_key_version,
          json(r.scopes),
          r.status,
          r.revoked_at,
          r.last_used_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("site_credentials", idWhere(1), [r.id]);
    },
  };

  const nonceSpec: SyncSpec<RequestNonceRow> = {
    keyOf: (r) => `${r.credential_id}|${r.nonce}`,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      // The store carries no request time; stamp the write time. The
      // replay check only uses credential_id + nonce + expires_at.
      await ins(
        "request_nonces",
        ["id", "credential_id", "nonce", "request_timestamp", "expires_at"],
        [randomUUID(), r.credential_id, r.nonce, new Date().toISOString(), r.expires_at]
      );
    },
    update: async (c, _b, r) => {
      await upd(
        "request_nonces",
        ["expires_at"],
        [r.expires_at, r.credential_id, r.nonce],
        `"credential_id" = $2 AND "nonce" = $3`,
        false
      );
    },
    remove: async (c, r) => {
      await del("request_nonces", `"credential_id" = $1 AND "nonce" = $2`, [
        r.credential_id,
        r.nonce,
      ]);
    },
  };

  const orderSpec: SyncSpec<OrderRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, items: [], attribution: null }),
    insert: async (c, r) => {
      await ins(
        "orders",
        [
          "id",
          "order_number",
          "public_reference",
          "customer_id",
          "source",
          "integrated_site_id",
          "status",
          "payment_status",
          "currency_code",
          "subtotal_minor",
          "discount_minor",
          "tax_minor",
          "total_minor",
          "customer_note",
          "internal_note",
          "created_by_user_id",
          "activation_mode",
          "activation_percent",
          "activation_date",
          "suspend_on_missed_schedule",
          "grace_days",
          "payment_method_id",
          "lead_id",
          "created_at",
          "updated_at",
          "completed_at",
          "cancelled_at",
        ],
        [
          r.id,
          r.order_number,
          r.public_reference,
          r.customer_id,
          r.source,
          r.integrated_site_id,
          r.status,
          r.payment_status,
          r.currency_code,
          r.subtotal_minor,
          r.discount_minor,
          r.tax_minor,
          r.total_minor,
          r.customer_note,
          r.internal_note,
          r.created_by_user_id,
          r.activation_mode,
          r.activation_percent,
          r.activation_date,
          r.suspend_on_missed_schedule,
          r.grace_days,
          r.payment_method_id,
          r.lead_id,
          r.created_at,
          r.updated_at,
          r.completed_at,
          r.cancelled_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "order_number",
        "public_reference",
        "customer_id",
        "source",
        "integrated_site_id",
        "status",
        "payment_status",
        "currency_code",
        "subtotal_minor",
        "discount_minor",
        "tax_minor",
        "total_minor",
        "customer_note",
        "internal_note",
        "created_by_user_id",
        "activation_mode",
        "activation_percent",
        "activation_date",
        "suspend_on_missed_schedule",
        "grace_days",
        "payment_method_id",
        "lead_id",
        "updated_at",
        "completed_at",
        "cancelled_at",
      ];
      await upd(
        "orders",
        cols,
        [
          r.order_number,
          r.public_reference,
          r.customer_id,
          r.source,
          r.integrated_site_id,
          r.status,
          r.payment_status,
          r.currency_code,
          r.subtotal_minor,
          r.discount_minor,
          r.tax_minor,
          r.total_minor,
          r.customer_note,
          r.internal_note,
          r.created_by_user_id,
          r.activation_mode,
          r.activation_percent,
          r.activation_date,
          r.suspend_on_missed_schedule,
          r.grace_days,
          r.payment_method_id,
          r.lead_id,
          r.updated_at,
          r.completed_at,
          r.cancelled_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("orders", idWhere(1), [r.id]);
    },
  };

  const orderInstallmentSpec: SyncSpec<OrderInstallmentRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "order_installments",
        [
          "id",
          "order_id",
          "installment_number",
          "amount_minor",
          "due_date",
          "status",
          "paid_amount_minor",
          "paid_at",
          "notes",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.order_id,
          r.installment_number,
          r.amount_minor,
          r.due_date,
          r.status,
          r.paid_amount_minor,
          r.paid_at,
          r.notes,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "installment_number",
        "amount_minor",
        "due_date",
        "status",
        "paid_amount_minor",
        "paid_at",
        "notes",
        "updated_at",
      ];
      await upd(
        "order_installments",
        cols,
        [
          r.installment_number,
          r.amount_minor,
          r.due_date,
          r.status,
          r.paid_amount_minor,
          r.paid_at,
          r.notes,
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("order_installments", idWhere(1), [r.id]);
    },
  };

  const orderItemSpec: SyncSpec<OrderItemRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "order_items",
        [
          "id",
          "order_id",
          "product_id",
          "package_id",
          "package_version_id",
          "package_price_id",
          "item_kind",
          "fulfillment_type_snapshot",
          "product_name_snapshot",
          "package_name_snapshot",
          "package_version_snapshot",
          "price_kind_snapshot",
          "interval_unit_snapshot",
          "interval_count_snapshot",
          "activation_limit_snapshot",
          "quantity",
          "unit_amount_minor",
          "line_subtotal_minor",
          "line_discount_minor",
          "line_tax_minor",
          "line_total_minor",
          "currency_code",
          "created_at",
        ],
        [
          r.id,
          r.order_id,
          r.product_id,
          r.package_id,
          r.package_version_id,
          r.package_price_id,
          r.item_kind,
          r.fulfillment_type_snapshot,
          r.product_name_snapshot,
          r.package_name_snapshot,
          r.package_version_snapshot,
          r.price_kind_snapshot,
          r.interval_unit_snapshot,
          r.interval_count_snapshot,
          r.activation_limit_snapshot,
          r.quantity,
          r.unit_amount_minor,
          r.line_subtotal_minor,
          r.line_discount_minor,
          r.line_tax_minor,
          r.line_total_minor,
          r.currency_code,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "product_id",
        "package_id",
        "package_version_id",
        "package_price_id",
        "item_kind",
        "fulfillment_type_snapshot",
        "product_name_snapshot",
        "package_name_snapshot",
        "package_version_snapshot",
        "price_kind_snapshot",
        "interval_unit_snapshot",
        "interval_count_snapshot",
        "activation_limit_snapshot",
        "quantity",
        "unit_amount_minor",
        "line_subtotal_minor",
        "line_discount_minor",
        "line_tax_minor",
        "line_total_minor",
        "currency_code",
      ];
      await upd(
        "order_items",
        cols,
        [
          r.product_id,
          r.package_id,
          r.package_version_id,
          r.package_price_id,
          r.item_kind,
          r.fulfillment_type_snapshot,
          r.product_name_snapshot,
          r.package_name_snapshot,
          r.package_version_snapshot,
          r.price_kind_snapshot,
          r.interval_unit_snapshot,
          r.interval_count_snapshot,
          r.activation_limit_snapshot,
          r.quantity,
          r.unit_amount_minor,
          r.line_subtotal_minor,
          r.line_discount_minor,
          r.line_tax_minor,
          r.line_total_minor,
          r.currency_code,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("order_items", idWhere(1), [r.id]);
    },
  };

  const orderSnapshotSpec: SyncSpec<OrderItemSnapshotRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, items: [] }),
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "order_item_entitlement_snapshots",
        [
          "id",
          "order_item_id",
          "source_type",
          "source_package_version_id",
          "schema_version",
          "snapshot_hash",
          "created_at",
        ],
        [
          r.id,
          r.order_item_id,
          r.source_type,
          r.source_package_version_id,
          r.schema_version,
          r.snapshot_hash,
          r.created_at,
        ]
      );
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  // -- Support tickets + comments, leads, sent reminders (migration 0009) ----
  const supportTicketSpec: SyncSpec<SupportTicketRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "support_tickets",
        [
          "id",
          "ticket_number",
          "customer_id",
          "order_id",
          "subscription_id",
          "license_id",
          "product_id",
          "title",
          "description",
          "status",
          "priority",
          "category",
          "reporter_user_id",
          "source_note",
          "assignee_user_id",
          "created_at",
          "updated_at",
          "resolved_at",
          "closed_at",
        ],
        [
          r.id,
          r.ticket_number,
          r.customer_id,
          r.order_id,
          r.subscription_id,
          r.license_id,
          r.product_id,
          r.title,
          r.description,
          r.status,
          r.priority,
          r.category,
          r.reporter_user_id,
          r.source_note,
          r.assignee_user_id,
          r.created_at,
          r.updated_at,
          r.resolved_at,
          r.closed_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "customer_id",
        "order_id",
        "subscription_id",
        "license_id",
        "product_id",
        "title",
        "description",
        "status",
        "priority",
        "category",
        "source_note",
        "assignee_user_id",
        "updated_at",
        "resolved_at",
        "closed_at",
      ];
      await upd(
        "support_tickets",
        cols,
        [
          r.customer_id,
          r.order_id,
          r.subscription_id,
          r.license_id,
          r.product_id,
          r.title,
          r.description,
          r.status,
          r.priority,
          r.category,
          r.source_note,
          r.assignee_user_id,
          r.updated_at,
          r.resolved_at,
          r.closed_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("support_tickets", idWhere(1), [r.id]);
    },
  };

  const ticketCommentSpec: SyncSpec<TicketCommentRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "ticket_comments",
        ["id", "ticket_id", "author_user_id", "body", "is_internal", "created_at"],
        [r.id, r.ticket_id, r.author_user_id, r.body, r.is_internal, r.created_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["body", "is_internal"];
      await upd(
        "ticket_comments",
        cols,
        [r.body, r.is_internal, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("ticket_comments", idWhere(1), [r.id]);
    },
  };

  const leadSpec: SyncSpec<LeadRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "leads",
        [
          "id",
          "lead_number",
          "name",
          "email",
          "normalized_email",
          "phone",
          "normalized_phone",
          "whatsapp",
          "source_site_id",
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "interest",
          "product_id",
          "message",
          "notes",
          "status",
          "assignee_user_id",
          "created_at",
          "updated_at",
          "converted_at",
          "converted_customer_id",
          "converted_order_id",
        ],
        [
          r.id,
          r.lead_number,
          r.name,
          r.email,
          r.normalized_email,
          r.phone,
          r.normalized_phone,
          r.whatsapp,
          r.source_site_id,
          r.utm_source,
          r.utm_medium,
          r.utm_campaign,
          r.interest,
          r.product_id,
          r.message,
          r.notes,
          r.status,
          r.assignee_user_id,
          r.created_at,
          r.updated_at,
          r.converted_at,
          r.converted_customer_id,
          r.converted_order_id,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "name",
        "email",
        "normalized_email",
        "phone",
        "normalized_phone",
        "whatsapp",
        "source_site_id",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "interest",
        "product_id",
        "message",
        "notes",
        "status",
        "assignee_user_id",
        "updated_at",
        "converted_at",
        "converted_customer_id",
        "converted_order_id",
      ];
      await upd(
        "leads",
        cols,
        [
          r.name,
          r.email,
          r.normalized_email,
          r.phone,
          r.normalized_phone,
          r.whatsapp,
          r.source_site_id,
          r.utm_source,
          r.utm_medium,
          r.utm_campaign,
          r.interest,
          r.product_id,
          r.message,
          r.notes,
          r.status,
          r.assignee_user_id,
          r.updated_at,
          r.converted_at,
          r.converted_customer_id,
          r.converted_order_id,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("leads", idWhere(1), [r.id]);
    },
  };

  const sentReminderSpec: SyncSpec<SentReminderRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "sent_reminders",
        ["id", "kind", "reference_id", "offset_days", "sent_at"],
        [r.id, r.kind, r.reference_id, r.offset_days, r.sent_at]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["kind", "reference_id", "offset_days", "sent_at"];
      await upd(
        "sent_reminders",
        cols,
        [r.kind, r.reference_id, r.offset_days, r.sent_at, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("sent_reminders", idWhere(1), [r.id]);
    },
  };

  const orderSnapshotItemSpec: SyncSpec<OrderSnapshotItemRow> = {
    keyOf: (r) => `${r.snapshot_id}|${r.feature_key_snapshot}`,
    scalarOf: (r) => r,
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "order_item_entitlement_snapshot_items",
        [
          "id",
          "snapshot_id",
          "feature_key_snapshot",
          "value_type_snapshot",
          "entitlement_value",
          "unit_snapshot",
        ],
        [
          randomUUID(),
          r.snapshot_id,
          r.feature_key_snapshot,
          r.value_type_snapshot,
          json(r.entitlement_value),
          r.unit_snapshot,
        ]
      );
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  const subscriptionSpec: SyncSpec<SubscriptionRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, periods: [] }),
    insert: async (c, r) => {
      const cols = [
        "id",
        "subscription_number",
        "customer_id",
        "product_id",
        "source_order_item_id",
        "source_package_version_id",
        "status",
        "billing_kind",
        "interval_unit",
        "interval_count",
        "currency_code",
        "grace_days",
        "current_period_start",
        "current_period_end",
        "next_renewal_at",
        "cancel_at_period_end",
        "cancelled_at",
        "created_at",
        "updated_at",
      ];
      const vals: unknown[] = [
        r.id,
        r.subscription_number,
        r.customer_id,
        r.product_id,
        r.source_order_item_id,
        r.source_package_version_id,
        r.status,
        r.billing_kind,
        r.interval_unit,
        r.interval_count,
        r.currency_code,
        r.grace_days,
        r.current_period_start,
        r.current_period_end,
        r.next_renewal_at,
        r.cancel_at_period_end,
        r.cancelled_at,
        r.created_at,
        r.updated_at,
      ];
      if (caps.subscriptionsUnitAmount) {
        cols.push("unit_amount_minor");
        vals.push(r.unit_amount_minor);
      }
      await ins("subscriptions", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "subscription_number",
        "customer_id",
        "product_id",
        "source_order_item_id",
        "source_package_version_id",
        "status",
        "billing_kind",
        "interval_unit",
        "interval_count",
        "currency_code",
        "grace_days",
        "current_period_start",
        "current_period_end",
        "next_renewal_at",
        "cancel_at_period_end",
        "cancelled_at",
        "updated_at",
      ];
      const vals: unknown[] = [
        r.subscription_number,
        r.customer_id,
        r.product_id,
        r.source_order_item_id,
        r.source_package_version_id,
        r.status,
        r.billing_kind,
        r.interval_unit,
        r.interval_count,
        r.currency_code,
        r.grace_days,
        r.current_period_start,
        r.current_period_end,
        r.next_renewal_at,
        r.cancel_at_period_end,
        r.cancelled_at,
        r.updated_at,
      ];
      if (caps.subscriptionsUnitAmount) {
        cols.push("unit_amount_minor");
        vals.push(r.unit_amount_minor);
      }
      await upd(
        "subscriptions",
        cols,
        [...vals, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("subscriptions", idWhere(1), [r.id]);
    },
  };

  const periodSpec: SyncSpec<SubscriptionPeriodRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "subscription_periods",
        [
          "id",
          "subscription_id",
          "period_number",
          "period_start",
          "period_end",
          "status",
          "renewal_order_id",
          "invoice_id",
          "payment_transaction_id",
          "activated_at",
          "created_at",
        ],
        [
          r.id,
          r.subscription_id,
          r.period_number,
          r.period_start,
          r.period_end,
          r.status,
          r.renewal_order_id,
          r.invoice_id,
          r.payment_transaction_id,
          r.activated_at,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "period_number",
        "period_start",
        "period_end",
        "status",
        "renewal_order_id",
        "invoice_id",
        "payment_transaction_id",
        "activated_at",
      ];
      await upd(
        "subscription_periods",
        cols,
        [
          r.period_number,
          r.period_start,
          r.period_end,
          r.status,
          r.renewal_order_id,
          r.invoice_id,
          r.payment_transaction_id,
          r.activated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("subscription_periods", idWhere(1), [r.id]);
    },
  };

  const invoiceSpec: SyncSpec<InvoiceRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, items: [] }),
    insert: async (c, r) => {
      await ins(
        "invoices",
        [
          "id",
          "invoice_number",
          "customer_id",
          "order_id",
          "subscription_id",
          "invoice_type",
          "status",
          "currency_code",
          "subtotal_minor",
          "discount_minor",
          "tax_minor",
          "total_minor",
          "amount_paid_minor",
          "amount_due_minor",
          "issued_at",
          "paid_at",
          "created_at",
        ],
        [
          r.id,
          r.invoice_number,
          r.customer_id,
          r.order_id,
          r.subscription_id,
          r.invoice_type,
          r.status,
          r.currency_code,
          r.subtotal_minor,
          r.discount_minor,
          r.tax_minor,
          r.total_minor,
          r.amount_paid_minor,
          r.amount_due_minor,
          r.issued_at,
          r.paid_at,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "invoice_number",
        "customer_id",
        "order_id",
        "subscription_id",
        "invoice_type",
        "status",
        "currency_code",
        "subtotal_minor",
        "discount_minor",
        "tax_minor",
        "total_minor",
        "amount_paid_minor",
        "amount_due_minor",
        "issued_at",
        "paid_at",
      ];
      await upd(
        "invoices",
        cols,
        [
          r.invoice_number,
          r.customer_id,
          r.order_id,
          r.subscription_id,
          r.invoice_type,
          r.status,
          r.currency_code,
          r.subtotal_minor,
          r.discount_minor,
          r.tax_minor,
          r.total_minor,
          r.amount_paid_minor,
          r.amount_due_minor,
          r.issued_at,
          r.paid_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("invoices", idWhere(1), [r.id]);
    },
  };

  const invoiceItemSpec: SyncSpec<InvoiceItemRow> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "invoice_items",
        [
          "id",
          "invoice_id",
          "description_snapshot",
          "quantity",
          "unit_amount_minor",
          "line_amount_minor",
          "currency_code",
        ],
        [
          r.id,
          r.invoice_id,
          r.description_snapshot,
          r.quantity,
          r.unit_amount_minor,
          r.line_amount_minor,
          r.currency_code,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "description_snapshot",
        "quantity",
        "unit_amount_minor",
        "line_amount_minor",
        "currency_code",
      ];
      await upd(
        "invoice_items",
        cols,
        [
          r.description_snapshot,
          r.quantity,
          r.unit_amount_minor,
          r.line_amount_minor,
          r.currency_code,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("invoice_items", idWhere(1), [r.id]);
    },
  };

  const providerSpec: SyncSpec<PaymentProviderRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "payment_providers",
        ["id", "provider_key", "display_name", "provider_type", "adapter_key", "status", "created_at"],
        [r.id, r.provider_key, r.display_name, r.provider_type, r.adapter_key, r.status, new Date().toISOString()]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["provider_key", "display_name", "provider_type", "adapter_key", "status"];
      await upd(
        "payment_providers",
        cols,
        [r.provider_key, r.display_name, r.provider_type, r.adapter_key, r.status, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("payment_providers", idWhere(1), [r.id]);
    },
  };

  const methodSpec: SyncSpec<PaymentMethodRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, transfer_rails: [] }),
    insert: async (c, r) => {
      await ins(
        "payment_methods",
        [
          "id",
          "provider_id",
          "method_key",
          "display_name",
          "method_kind",
          "account_type",
          "account_label",
          "instructions",
          "configuration",
          "is_enabled",
          "sort_order",
          "created_at",
        ],
        [
          r.id,
          r.provider_id,
          r.method_key,
          r.display_name,
          r.method_kind,
          r.account_type,
          r.account_label,
          r.instructions,
          json(r.configuration),
          r.is_enabled,
          r.sort_order,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "provider_id",
        "method_key",
        "display_name",
        "method_kind",
        "account_type",
        "account_label",
        "instructions",
        "configuration",
        "is_enabled",
        "sort_order",
      ];
      await upd(
        "payment_methods",
        cols,
        [
          r.provider_id,
          r.method_key,
          r.display_name,
          r.method_kind,
          r.account_type,
          r.account_label,
          r.instructions,
          json(r.configuration),
          r.is_enabled,
          r.sort_order,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("payment_methods", idWhere(1), [r.id]);
    },
  };

  const submissionSpec: SyncSpec<PaymentSubmissionRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      const cols = [
        "id",
        "order_id",
        "customer_id",
        "payment_method_id",
        "installment_id",
        "amount_minor",
        "currency_code",
        "sender_name",
        "sender_phone",
        "sender_bank_name",
        "sender_account_reference",
        "transfer_rail_key",
        "transaction_reference",
        "normalized_transaction_reference",
        "payment_date",
        "proof_asset_id",
        "status",
        "customer_note",
        "submitted_at",
        "reviewed_at",
        "reviewed_by_user_id",
      ];
      const vals: unknown[] = [
        r.id,
        r.order_id,
        r.customer_id,
        r.payment_method_id,
        r.installment_id,
        r.amount_minor,
        r.currency_code,
        r.sender_name,
        r.sender_phone,
        r.sender_bank_name,
        r.sender_account_reference,
        r.transfer_rail_key,
        r.transaction_reference,
        r.normalized_transaction_reference,
        r.payment_date,
        r.proof_asset_id,
        r.status,
        r.customer_note,
        r.submitted_at,
        r.reviewed_at,
        r.reviewed_by_user_id,
      ];
      if (caps.paymentSubmissionsDuplicateWarning) {
        cols.push("duplicate_risk_warning");
        vals.push(r.duplicate_risk_Warning);
      }
      await ins("payment_submissions", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "order_id",
        "customer_id",
        "payment_method_id",
        "installment_id",
        "amount_minor",
        "currency_code",
        "sender_name",
        "sender_phone",
        "sender_bank_name",
        "sender_account_reference",
        "transfer_rail_key",
        "transaction_reference",
        "normalized_transaction_reference",
        "payment_date",
        "proof_asset_id",
        "status",
        "customer_note",
        "reviewed_at",
        "reviewed_by_user_id",
      ];
      const vals: unknown[] = [
        r.order_id,
        r.customer_id,
        r.payment_method_id,
        r.installment_id,
        r.amount_minor,
        r.currency_code,
        r.sender_name,
        r.sender_phone,
        r.sender_bank_name,
        r.sender_account_reference,
        r.transfer_rail_key,
        r.transaction_reference,
        r.normalized_transaction_reference,
        r.payment_date,
        r.proof_asset_id,
        r.status,
        r.customer_note,
        r.reviewed_at,
        r.reviewed_by_user_id,
      ];
      if (caps.paymentSubmissionsDuplicateWarning) {
        cols.push("duplicate_risk_warning");
        vals.push(r.duplicate_risk_Warning);
      }
      await upd(
        "payment_submissions",
        cols,
        [...vals, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("payment_submissions", idWhere(1), [r.id]);
    },
  };

  const transactionSpec: SyncSpec<PaymentTransactionRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "payment_transactions",
        [
          "id",
          "order_id",
          "payment_method_id",
          "payment_submission_id",
          "provider_id",
          "provider_transaction_id",
          "amount_minor",
          "currency_code",
          "status",
          "paid_at",
          "verified_by_user_id",
          "verification_source",
          "created_at",
        ],
        [
          r.id,
          r.order_id,
          r.payment_method_id,
          r.payment_submission_id,
          r.provider_id,
          r.provider_transaction_id,
          r.amount_minor,
          r.currency_code,
          r.status,
          r.paid_at,
          r.verified_by_user_id,
          r.verification_source,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "order_id",
        "payment_method_id",
        "payment_submission_id",
        "provider_id",
        "provider_transaction_id",
        "amount_minor",
        "currency_code",
        "status",
        "paid_at",
        "verified_by_user_id",
        "verification_source",
      ];
      await upd(
        "payment_transactions",
        cols,
        [
          r.order_id,
          r.payment_method_id,
          r.payment_submission_id,
          r.provider_id,
          r.provider_transaction_id,
          r.amount_minor,
          r.currency_code,
          r.status,
          r.paid_at,
          r.verified_by_user_id,
          r.verification_source,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("payment_transactions", idWhere(1), [r.id]);
    },
  };

  const verificationLogSpec: SyncSpec<PaymentVerificationLogRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "payment_verification_logs",
        [
          "id",
          "payment_submission_id",
          "actor_user_id",
          "decision",
          "reason_code",
          "customer_message",
          "notes",
          "created_at",
        ],
        [
          r.id,
          r.payment_submission_id,
          r.actor_user_id,
          r.decision,
          r.reason_code,
          r.customer_message,
          r.notes,
          r.created_at,
        ]
      );
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  // F-03: refunds are MUTABLE (status requested -> pending ->
  // succeeded/failed/cancelled, processed_by_user_id set on
  // processing), so a full insert/update/remove spec — unlike the
  // immutable verification logs above.
  const refundSpec: SyncSpec<PaymentRefundRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "payment_refunds",
        [
          "id",
          "payment_transaction_id",
          "amount_minor",
          "currency_code",
          "status",
          "reason",
          "provider_refund_id",
          "requested_by_user_id",
          "processed_by_user_id",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.payment_transaction_id,
          r.amount_minor,
          r.currency_code,
          r.status,
          r.reason,
          r.provider_refund_id,
          r.requested_by_user_id,
          r.processed_by_user_id,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "payment_transaction_id",
        "amount_minor",
        "currency_code",
        "status",
        "reason",
        "provider_refund_id",
        "requested_by_user_id",
        "processed_by_user_id",
      ];
      await upd(
        "payment_refunds",
        cols,
        [
          r.payment_transaction_id,
          r.amount_minor,
          r.currency_code,
          r.status,
          r.reason,
          r.provider_refund_id,
          r.requested_by_user_id,
          r.processed_by_user_id,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("payment_refunds", idWhere(1), [r.id]);
    },
  };

  // Expense module (migration 0018) — same SyncSpec shape as refunds.
  // Categories are parents (expenses.category_id RESTRICT), expenses
  // are children: deletes run expenses-first, upserts categories-first
  // (see the sync passes below).
  const expenseCategorySpec: SyncSpec<ExpenseCategoryRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "expense_categories",
        [
          "id",
          "name",
          "description",
          "color",
          "icon",
          "parent_id",
          "is_active",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.name,
          r.description,
          r.color,
          r.icon,
          r.parent_id,
          r.is_active,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      // NOTE: "updated_at" is NOT in cols — upd(..., touch=true) appends
      // `"updated_at" = now()`. Listing it in cols as well makes Postgres
      // reject the UPDATE ("multiple assignments to same column
      // updated_at") — the refundSpec had exactly that latent bug until
      // the expense update test caught the same shape here (refunds are
      // insert-only in practice, so it never fired).
      const cols = [
        "name",
        "description",
        "color",
        "icon",
        "parent_id",
        "is_active",
      ];
      await upd(
        "expense_categories",
        cols,
        [
          r.name,
          r.description,
          r.color,
          r.icon,
          r.parent_id,
          r.is_active,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("expense_categories", idWhere(1), [r.id]);
    },
  };

  const expenseSpec: SyncSpec<ExpenseRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "expenses",
        [
          "id",
          "amount_minor",
          "currency",
          "expense_date",
          "category_id",
          "product_id",
          "payment_method_id",
          "vendor",
          "notes",
          "receipt_media_id",
          "recorded_by",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.amount_minor,
          r.currency,
          r.expense_date,
          r.category_id,
          r.product_id,
          r.payment_method_id,
          r.vendor,
          r.notes,
          r.receipt_media_id,
          r.recorded_by,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      // Same "updated_at" note as expenseCategorySpec: touch=true sets
      // it, so it must not also be in cols.
      const cols = [
        "amount_minor",
        "currency",
        "expense_date",
        "category_id",
        "product_id",
        "payment_method_id",
        "vendor",
        "notes",
        "receipt_media_id",
        "recorded_by",
      ];
      await upd(
        "expenses",
        cols,
        [
          r.amount_minor,
          r.currency,
          r.expense_date,
          r.category_id,
          r.product_id,
          r.payment_method_id,
          r.vendor,
          r.notes,
          r.receipt_media_id,
          r.recorded_by,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("expenses", idWhere(1), [r.id]);
    },
  };

  const licenseSpec: SyncSpec<LicenseRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, snapshots: [], activations: [] }),
    insert: async (c, r) => {
      if (!caps.licensesIntegrationProfileNullable) {
        throw new Error(
          "DrizzleStore: cannot persist a license on this database: licenses.integration_profile_id is still NOT NULL (migration 0000) and the service model never supplies an integration profile. Apply migration 0002 (db/migrations/0002_sequence_counters.sql), which relaxes the column to nullable."
        );
      }
      await ins(
        "licenses",
        [
          "id",
          "license_number",
          "product_id",
          "customer_id",
          "source_order_item_id",
          "subscription_id",
          "license_key_hash",
          "license_key_hint",
          "status",
          "activation_limit",
          "valid_from",
          "expires_at",
          "grace_until",
          "current_entitlement_snapshot_id",
          "issued_at",
          "created_at",
          "updated_at",
        ],
        [
          r.id,
          r.license_number,
          r.product_id,
          r.customer_id,
          r.source_order_item_id,
          r.subscription_id,
          r.license_key_hash,
          r.license_key_hint,
          r.status,
          r.activation_limit,
          r.valid_from,
          r.expires_at,
          r.grace_until,
          r.current_entitlement_snapshot_id,
          r.issued_at,
          r.created_at,
          r.updated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "license_number",
        "product_id",
        "customer_id",
        "source_order_item_id",
        "subscription_id",
        "license_key_hash",
        "license_key_hint",
        "status",
        "activation_limit",
        "valid_from",
        "expires_at",
        "grace_until",
        "current_entitlement_snapshot_id",
        "issued_at",
        "updated_at",
      ];
      await upd(
        "licenses",
        cols,
        [
          r.license_number,
          r.product_id,
          r.customer_id,
          r.source_order_item_id,
          r.subscription_id,
          r.license_key_hash,
          r.license_key_hint,
          r.status,
          r.activation_limit,
          r.valid_from,
          r.expires_at,
          r.grace_until,
          r.current_entitlement_snapshot_id,
          r.issued_at,
          r.updated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("licenses", idWhere(1), [r.id]);
    },
  };

  const licenseSnapshotSpec: SyncSpec<LicenseEntitlementSnapshotRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => ({ ...r, items: [] }),
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "license_entitlement_snapshots",
        [
          "id",
          "license_id",
          "version_number",
          "source_type",
          "effective_at",
          "reason",
          "snapshot_hash",
          "created_by_user_id",
          "created_at",
        ],
        [
          r.id,
          r.license_id,
          r.version_number,
          r.source_type,
          r.effective_at,
          r.reason,
          r.snapshot_hash,
          r.created_by_user_id,
          r.created_at,
        ]
      );
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  const licenseSnapshotItemSpec: SyncSpec<LicenseSnapshotItemRow> = {
    keyOf: (r) => `${r.snapshot_id}|${r.feature_key_snapshot}`,
    scalarOf: (r) => r,
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "license_entitlement_snapshot_items",
        [
          "id",
          "snapshot_id",
          "feature_key_snapshot",
          "value_type_snapshot",
          "entitlement_value",
          "unit_snapshot",
        ],
        [
          randomUUID(),
          r.snapshot_id,
          r.feature_key_snapshot,
          r.value_type_snapshot,
          json(r.entitlement_value),
          r.unit_snapshot,
        ]
      );
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  const licenseActivationSpec: SyncSpec<LicenseActivationRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "license_activations",
        [
          "id",
          "license_id",
          "installation_id_hash",
          "domain_normalized",
          "environment",
          "status",
          "activated_at",
          "last_seen_at",
          "deactivated_at",
          "metadata",
          "created_at",
        ],
        [
          r.id,
          r.license_id,
          r.installation_id_hash,
          r.domain_normalized,
          r.environment,
          r.status,
          r.activated_at,
          r.last_seen_at,
          r.deactivated_at,
          json(r.metadata),
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "installation_id_hash",
        "domain_normalized",
        "environment",
        "status",
        "activated_at",
        "last_seen_at",
        "deactivated_at",
        "metadata",
      ];
      await upd(
        "license_activations",
        cols,
        [
          r.installation_id_hash,
          r.domain_normalized,
          r.environment,
          r.status,
          r.activated_at,
          r.last_seen_at,
          r.deactivated_at,
          json(r.metadata),
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("license_activations", idWhere(1), [r.id]);
    },
  };

  const licenseEventSpec: SyncSpec<LicenseEventRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "license_events",
        [
          "id",
          "license_id",
          "event_type",
          "actor_type",
          "actor_user_id",
          "activation_id",
          "metadata",
          "created_at",
        ],
        [
          r.id,
          r.license_id,
          r.event_type,
          r.actor_type,
          r.actor_user_id,
          r.activation_id,
          json(r.metadata),
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["event_type", "actor_type", "actor_user_id", "activation_id", "metadata"];
      await upd(
        "license_events",
        cols,
        [r.event_type, r.actor_type, r.actor_user_id, r.activation_id, json(r.metadata), r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("license_events", idWhere(1), [r.id]);
    },
  };

  const trackingConfigSpec: SyncSpec<TrackingConfigRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "tracking_configurations",
        [
          "id",
          "integrated_site_id",
          "provider",
          "label",
          "pixel_id",
          "access_token_ciphertext",
          "encryption_key_version",
          "test_event_code",
          "enabled_events",
          "status",
          "created_at",
          "updated_at",
          "rotated_at",
        ],
        [
          r.id,
          r.integrated_site_id,
          r.provider,
          r.label,
          r.pixel_id,
          r.access_token_ciphertext,
          r.encryption_key_version,
          r.test_event_code,
          json(r.enabled_events),
          r.status,
          r.created_at,
          r.updated_at,
          r.rotated_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = [
        "integrated_site_id",
        "provider",
        "label",
        "pixel_id",
        "access_token_ciphertext",
        "encryption_key_version",
        "test_event_code",
        "enabled_events",
        "status",
        "updated_at",
        "rotated_at",
      ];
      await upd(
        "tracking_configurations",
        cols,
        [
          r.integrated_site_id,
          r.provider,
          r.label,
          r.pixel_id,
          r.access_token_ciphertext,
          r.encryption_key_version,
          r.test_event_code,
          json(r.enabled_events),
          r.status,
          r.updated_at,
          r.rotated_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("tracking_configurations", idWhere(1), [r.id]);
    },
  };

  const trackingEventSpec: SyncSpec<TrackingEventRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      const cols = [
        "id",
        "integrated_site_id",
        "event_name",
        "event_id",
        "event_time",
        "event_source_url",
        "order_id",
        "consent_state",
        "consent_policy_version",
        "sanitized_payload",
        "status",
        "created_at",
      ];
      const vals: unknown[] = [
        r.id,
        r.integrated_site_id,
        r.event_name,
        r.event_id,
        r.event_time,
        r.event_source_url,
        r.order_id,
        r.consent_state,
        r.consent_policy_version,
        json(r.sanitized_payload),
        r.status,
        r.created_at,
      ];
      if (caps.trackingEventsDelivery) {
        cols.push("delivery_attempts", "delivered_at");
        vals.push(r.delivery_attempts, r.delivered_at);
      }
      await ins("tracking_events", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = [
        "integrated_site_id",
        "event_name",
        "event_id",
        "event_time",
        "event_source_url",
        "order_id",
        "consent_state",
        "consent_policy_version",
        "sanitized_payload",
        "status",
      ];
      const vals: unknown[] = [
        r.integrated_site_id,
        r.event_name,
        r.event_id,
        r.event_time,
        r.event_source_url,
        r.order_id,
        r.consent_state,
        r.consent_policy_version,
        json(r.sanitized_payload),
        r.status,
      ];
      if (caps.trackingEventsDelivery) {
        cols.push("delivery_attempts", "delivered_at");
        vals.push(r.delivery_attempts, r.delivered_at);
      }
      await upd(
        "tracking_events",
        cols,
        [...vals, r.id],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("tracking_events", idWhere(1), [r.id]);
    },
  };

  const webhookEndpointSpec: SyncSpec<WebhookEndpointRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "webhook_endpoints",
        ["id", "integrated_site_id", "url", "description", "subscribed_events", "status", "created_at"],
        [
          r.id,
          r.integrated_site_id,
          r.url,
          r.description,
          json(r.subscribed_events),
          r.status,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      const cols = ["integrated_site_id", "url", "description", "subscribed_events", "status"];
      await upd(
        "webhook_endpoints",
        cols,
        [r.integrated_site_id, r.url, r.description, json(r.subscribed_events), r.status, r.id],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("webhook_endpoints", idWhere(1), [r.id]);
    },
  };

  const webhookDeliverySpec: SyncSpec<WebhookDeliveryRow> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "webhook_deliveries",
        [
          "id",
          "webhook_endpoint_id",
          "event_id",
          "delivery_id",
          "status",
          "attempt_count",
          "last_http_status",
          "delivered_at",
          "created_at",
        ],
        [
          r.id,
          r.webhook_endpoint_id,
          r.event_id,
          r.delivery_id,
          r.status,
          r.attempt_count,
          r.last_http_status,
          r.delivered_at,
          new Date().toISOString(),
        ]
      );
    },
    // B-04: batch insert for the cron drain (one delivery row per
    // endpoint per event — N rows in one statement).
    insertMany: async (c, rows) => {
      const cols = [
        "id",
        "webhook_endpoint_id",
        "event_id",
        "delivery_id",
        "status",
        "attempt_count",
        "last_http_status",
        "delivered_at",
        "created_at",
      ];
      const { text, values } = insertManySql(
        "webhook_deliveries",
        cols,
        rows.map((r) => [
          r.id,
          r.webhook_endpoint_id,
          r.event_id,
          r.delivery_id,
          r.status,
          r.attempt_count,
          r.last_http_status,
          r.delivered_at,
          new Date().toISOString(),
        ])
      );
      await execSql(c, text, values);
    },
    update: async (c, _b, r) => {
      const cols = [
        "webhook_endpoint_id",
        "event_id",
        "delivery_id",
        "status",
        "attempt_count",
        "last_http_status",
        "delivered_at",
      ];
      await upd(
        "webhook_deliveries",
        cols,
        [
          r.webhook_endpoint_id,
          r.event_id,
          r.delivery_id,
          r.status,
          r.attempt_count,
          r.last_http_status,
          r.delivered_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("webhook_deliveries", idWhere(1), [r.id]);
    },
  };

  const outboxSpec: SyncSpec<OutboxEventRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      await ins(
        "outbox_events",
        [
          "id",
          "event_key",
          "aggregate_type",
          "aggregate_id",
          "event_type",
          "payload",
          "status",
          "attempt_count",
          "available_at",
          "locked_until",
          "locked_by",
          "last_error_code",
          "created_at",
          "processed_at",
        ],
        [
          r.id,
          r.event_key,
          r.aggregate_type,
          r.aggregate_id,
          r.event_type,
          json(r.payload),
          r.status,
          r.attempt_count,
          r.available_at,
          r.locked_until,
          r.locked_by,
          r.last_error_code,
          r.created_at,
          r.processed_at,
        ]
      );
    },
    // B-04: batch insert (outbox rows are created in bursts — one per
    // order/payment/tracking event — so N rows go in one statement).
    insertMany: async (c, rows) => {
      const cols = [
        "id",
        "event_key",
        "aggregate_type",
        "aggregate_id",
        "event_type",
        "payload",
        "status",
        "attempt_count",
        "available_at",
        "locked_until",
        "locked_by",
        "last_error_code",
        "created_at",
        "processed_at",
      ];
      const { text, values } = insertManySql(
        "outbox_events",
        cols,
        rows.map((r) => [
          r.id,
          r.event_key,
          r.aggregate_type,
          r.aggregate_id,
          r.event_type,
          json(r.payload),
          r.status,
          r.attempt_count,
          r.available_at,
          r.locked_until,
          r.locked_by,
          r.last_error_code,
          r.created_at,
          r.processed_at,
        ])
      );
      await execSql(c, text, values);
    },
    update: async (c, _b, r) => {
      const cols = [
        "event_key",
        "aggregate_type",
        "aggregate_id",
        "event_type",
        "payload",
        "status",
        "attempt_count",
        "available_at",
        "locked_until",
        "locked_by",
        "last_error_code",
        "processed_at",
      ];
      await upd(
        "outbox_events",
        cols,
        [
          r.event_key,
          r.aggregate_type,
          r.aggregate_id,
          r.event_type,
          json(r.payload),
          r.status,
          r.attempt_count,
          r.available_at,
          r.locked_until,
          r.locked_by,
          r.last_error_code,
          r.processed_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        false
      );
    },
    remove: async (c, r) => {
      await del("outbox_events", idWhere(1), [r.id]);
    },
  };

  const idempotencySpec: SyncSpec<IdempotencyRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    insert: async (c, r) => {
      if (caps.idempotencyResponseBody) {
        await ins(
          "idempotency_records",
          [
            "id",
            "scope_key",
            "idempotency_key",
            "request_hash",
            "status",
            "response_status",
            "response_body",
            "expires_at",
            "created_at",
          ],
          [
            r.id,
            r.scope_key,
            r.idempotency_key,
            r.request_hash,
            r.status,
            r.response_status,
            json(r.response_body),
            r.expires_at,
            r.created_at,
          ]
        );
        return;
      }
      // Migration-0002-less fallback: reuse the legacy response_reference
      // (varchar 160) for small JSON-encoded bodies. Anything larger cannot
      // be replayed losslessly — fail closed, do not truncate.
      const bodyJson = JSON.stringify(r.response_body ?? null);
      if (bodyJson.length > 160) {
        throw new Error(
          "DrizzleStore: cannot persist an idempotency response body larger than 160 characters on this database: idempotency_records.response_body (migration 0002) is missing. Apply migration 0002 (db/migrations/0002_sequence_counters.sql) — truncating the replay body would silently corrupt idempotent replays."
        );
      }
      await ins(
        "idempotency_records",
        [
          "id",
          "scope_key",
          "idempotency_key",
          "request_hash",
          "status",
          "response_status",
          "response_reference",
          "expires_at",
          "created_at",
        ],
        [
          r.id,
          r.scope_key,
          r.idempotency_key,
          r.request_hash,
          r.status,
          r.response_status,
          bodyJson,
          r.expires_at,
          r.created_at,
        ]
      );
    },
    update: async (c, _b, r) => {
      if (caps.idempotencyResponseBody) {
        const cols = ["scope_key", "idempotency_key", "request_hash", "status", "response_status", "response_body", "expires_at"];
        await upd(
          "idempotency_records",
          cols,
          [
            r.scope_key,
            r.idempotency_key,
            r.request_hash,
            r.status,
            r.response_status,
            json(r.response_body),
            r.expires_at,
            r.id,
          ],
          idWhere(cols.length + 1),
          true
        );
        return;
      }
      const bodyJson = JSON.stringify(r.response_body ?? null);
      if (bodyJson.length > 160) {
        throw new Error(
          "DrizzleStore: cannot persist an idempotency response body larger than 160 characters on this database: idempotency_records.response_body (migration 0002) is missing. Apply migration 0002 (db/migrations/0002_sequence_counters.sql)."
        );
      }
      const cols = ["scope_key", "idempotency_key", "request_hash", "status", "response_status", "response_reference", "expires_at"];
      await upd(
        "idempotency_records",
        cols,
        [
          r.scope_key,
          r.idempotency_key,
          r.request_hash,
          r.status,
          r.response_status,
          bodyJson,
          r.expires_at,
          r.id,
        ],
        idWhere(cols.length + 1),
        true
      );
    },
    remove: async (c, r) => {
      await del("idempotency_records", idWhere(1), [r.id]);
    },
  };

  const auditLogSpec: SyncSpec<AuditLogRecord> = {
    keyOf: (r) => r.id,
    scalarOf: (r) => r,
    immutable: true,
    insert: async (c, r) => {
      await ins(
        "audit_logs",
        [
          "id",
          "actor_type",
          "actor_user_id",
          "integrated_site_id",
          "action",
          "resource_type",
          "resource_id",
          "outcome",
          "request_id",
          "changes",
          "created_at",
        ],
        [
          r.id,
          r.actor_type,
          r.actor_user_id,
          r.integrated_site_id,
          r.action,
          r.resource_type,
          r.resource_id,
          r.outcome,
          r.request_id,
          json(r.changes),
          r.created_at,
        ]
      );
    },
    // B-04: batch insert (nearly every transaction appends audit rows).
    insertMany: async (c, rows) => {
      const cols = [
        "id",
        "actor_type",
        "actor_user_id",
        "integrated_site_id",
        "action",
        "resource_type",
        "resource_id",
        "outcome",
        "request_id",
        "changes",
        "created_at",
      ];
      const { text, values } = insertManySql(
        "audit_logs",
        cols,
        rows.map((r) => [
          r.id,
          r.actor_type,
          r.actor_user_id,
          r.integrated_site_id,
          r.action,
          r.resource_type,
          r.resource_id,
          r.outcome,
          r.request_id,
          json(r.changes),
          r.created_at,
        ])
      );
      await execSql(c, text, values);
    },
    update: immutableStub(),
    remove: immutableStub(),
  };

  // -- Derived-row deletes for parents removed in this transaction ----------
  // (Derived rows for surviving parents are synced in the upsert pass below;
  // rows for deleted parents must go before the parent row itself, because
  // e.g. product_distribution_channels references products ON DELETE
  // RESTRICT. Several of these would also cascade, but explicit deletes
  // keep the differ correct regardless of the ON DELETE action.)
  const deleteDerivedForMissing = async (
    table: string,
    parentColumn: string,
    beforeIds: string[],
    afterIds: Set<string>
  ): Promise<void> => {
    for (const id of beforeIds) {
      if (!afterIds.has(id)) {
        await del(table, `"${parentColumn}" = $1`, [id]);
      }
    }
  };

  // -- Delete pass: children before parents ----------------------------------
  await syncDeletes(client, before.audit_logs, after.audit_logs, auditLogSpec, "audit_logs");
  await syncDeletes(client, before.sent_reminders, after.sent_reminders, sentReminderSpec, "sent_reminders");
  await syncDeletes(client, before.payment_verification_logs, after.payment_verification_logs, verificationLogSpec, "payment_verification_logs");
  await syncDeletes(client, before.payment_refunds, after.payment_refunds, refundSpec, "payment_refunds");
  await syncDeletes(client, before.expenses, after.expenses, expenseSpec, "expenses");
  await syncDeletes(client, before.expense_categories, after.expense_categories, expenseCategorySpec, "expense_categories");
  await syncDeletes(client, fb.licenseSnapshotItems, fa.licenseSnapshotItems, licenseSnapshotItemSpec, "license_entitlement_snapshot_items");
  await syncDeletes(client, fb.licenseSnapshots, fa.licenseSnapshots, licenseSnapshotSpec, "license_entitlement_snapshots");
  await syncDeletes(client, fb.licenseActivations, fa.licenseActivations, licenseActivationSpec, "license_activations");
  await syncDeletes(client, before.license_events, after.license_events, licenseEventSpec, "license_events");
  await syncDeletes(client, fb.invoiceItems, fa.invoiceItems, invoiceItemSpec, "invoice_items");
  await syncDeletes(client, before.invoices, after.invoices, invoiceSpec, "invoices");
  await syncDeletes(client, fb.periods, fa.periods, periodSpec, "subscription_periods");
  await syncDeletes(client, before.licenses, after.licenses, licenseSpec, "licenses");
  await syncDeletes(client, before.subscriptions, after.subscriptions, subscriptionSpec, "subscriptions");
  await syncDeletes(client, fb.orderSnapshotItems, fa.orderSnapshotItems, orderSnapshotItemSpec, "order_item_entitlement_snapshot_items");
  await syncDeletes(client, fb.orderSnapshots, fa.orderSnapshots, orderSnapshotSpec, "order_item_entitlement_snapshots");
  await syncDeletes(client, fb.orderItems, fa.orderItems, orderItemSpec, "order_items");
  await syncDeletes(client, before.order_installments, after.order_installments, orderInstallmentSpec, "order_installments");
  await syncDeletes(client, before.payment_transactions, after.payment_transactions, transactionSpec, "payment_transactions");
  await syncDeletes(client, before.payment_submissions, after.payment_submissions, submissionSpec, "payment_submissions");
  await syncDeletes(client, before.webhook_deliveries, after.webhook_deliveries, webhookDeliverySpec, "webhook_deliveries");
  await syncDeletes(client, before.outbox_events, after.outbox_events, outboxSpec, "outbox_events");
  await syncDeletes(client, before.webhook_endpoints, after.webhook_endpoints, webhookEndpointSpec, "webhook_endpoints");
  await syncDeletes(client, before.tracking_events, after.tracking_events, trackingEventSpec, "tracking_events");
  await syncDeletes(client, before.tracking_configurations, after.tracking_configurations, trackingConfigSpec, "tracking_configurations");
  await syncDeletes(client, before.request_nonces, after.request_nonces, nonceSpec, "request_nonces");
  await syncDeletes(client, before.site_credentials, after.site_credentials, credentialSpec, "site_credentials");
  await syncDeletes(client, fb.domains, fa.domains, domainSpec, "site_domains");
  await deleteDerivedForMissing("site_products", "integrated_site_id", before.integrated_sites.map((s) => s.id), new Set(after.integrated_sites.map((s) => s.id)));
  await syncDeletes(client, before.integrated_sites, after.integrated_sites, siteSpec, "integrated_sites");
  await syncDeletes(client, before.package_prices, after.package_prices, priceSpec, "package_prices");
  await syncDeletes(client, fb.versionFeatures, fa.versionFeatures, versionFeatureSpec, "package_version_features");
  await syncDeletes(client, before.package_versions, after.package_versions, versionSpec, "package_versions");
  await syncDeletes(client, before.product_packages, after.product_packages, packageSpec, "product_packages");
  await syncDeletes(client, before.product_features, after.product_features, featureSpec, "product_features");
  await deleteDerivedForMissing("product_distribution_channels", "product_id", before.products.map((p) => p.id), new Set(after.products.map((p) => p.id)));
  await syncDeletes(client, before.products, after.products, productSpec, "products");
  await syncDeletes(client, before.uploaded_assets, after.uploaded_assets, assetSpec, "uploaded_assets");
  await syncDeletes(client, before.media_assets, after.media_assets, mediaSpec, "media_assets");
  await syncDeletes(client, before.sessions, after.sessions, sessionSpec, "sessions");
  await syncDeletes(client, before.user_roles, after.user_roles, userRoleSpec, "user_roles");
  await deleteDerivedForMissing("role_permissions", "role_id", before.roles.map((r) => r.id), new Set(after.roles.map((r) => r.id)));
  await syncDeletes(client, before.roles, after.roles, roleSpec, "roles");
  await syncDeletes(client, before.staff_invitations, after.staff_invitations, invitationSpec, "staff_invitations");
  await deleteDerivedForMissing("staff_profiles", "user_id", before.users.map((u) => u.id), new Set(after.users.map((u) => u.id)));
  await syncDeletes(client, before.users, after.users, userSpec, "users");
  await syncDeletes(client, before.orders, after.orders, orderSpec, "orders");
  await syncDeletes(client, before.ticket_comments, after.ticket_comments, ticketCommentSpec, "ticket_comments");
  await syncDeletes(client, before.support_tickets, after.support_tickets, supportTicketSpec, "support_tickets");
  await syncDeletes(client, before.leads, after.leads, leadSpec, "leads");
  await syncDeletes(client, before.customer_contacts, after.customer_contacts, customerContactSpec, "customer_contacts");
  await syncDeletes(client, before.customer_addresses, after.customer_addresses, customerAddressSpec, "customer_addresses");
  await syncDeletes(client, before.customer_reports, after.customer_reports, customerReportSpec, "customer_reports");
  await syncDeletes(client, before.customers, after.customers, customerSpec, "customers");
  await syncDeletes(client, before.idempotency_records, after.idempotency_records, idempotencySpec, "idempotency_records");

  // -- Upsert pass: parents before children ----------------------------------
  await syncUpserts(client, before.users, after.users, userSpec, "users");
  await syncUpserts(client, before.roles, after.roles, roleSpec, "roles");
  await syncUpserts(client, before.staff_invitations, after.staff_invitations, invitationSpec, "staff_invitations");
  await syncUpserts(client, before.user_roles, after.user_roles, userRoleSpec, "user_roles");
  await syncUpserts(client, before.sessions, after.sessions, sessionSpec, "sessions");
  await syncUpserts(client, before.customers, after.customers, customerSpec, "customers");
  await syncUpserts(client, before.customer_contacts, after.customer_contacts, customerContactSpec, "customer_contacts");
  await syncUpserts(client, before.customer_addresses, after.customer_addresses, customerAddressSpec, "customer_addresses");
  await syncUpserts(client, before.customer_reports, after.customer_reports, customerReportSpec, "customer_reports");
  await syncUpserts(client, before.uploaded_assets, after.uploaded_assets, assetSpec, "uploaded_assets");
  await syncUpserts(client, before.media_assets, after.media_assets, mediaSpec, "media_assets");
  await syncUpserts(client, before.products, after.products, productSpec, "products");
  await syncUpserts(client, before.product_features, after.product_features, featureSpec, "product_features");
  const touchedPackages = await syncUpserts(client, before.product_packages, after.product_packages, packageSpec, "product_packages");
  await syncUpserts(client, before.package_versions, after.package_versions, versionSpec, "package_versions");
  await syncUpserts(client, fb.versionFeatures, fa.versionFeatures, versionFeatureSpec, "package_version_features");
  await syncUpserts(client, before.package_prices, after.package_prices, priceSpec, "package_prices");
  await syncUpserts(client, before.integrated_sites, after.integrated_sites, siteSpec, "integrated_sites");
  await syncUpserts(client, fb.domains, fa.domains, domainSpec, "site_domains");
  await syncUpserts(client, before.site_credentials, after.site_credentials, credentialSpec, "site_credentials");
  await syncUpserts(client, before.request_nonces, after.request_nonces, nonceSpec, "request_nonces");
  await syncUpserts(client, before.orders, after.orders, orderSpec, "orders");
  await syncUpserts(client, fb.orderItems, fa.orderItems, orderItemSpec, "order_items");
  await syncUpserts(client, fb.orderSnapshots, fa.orderSnapshots, orderSnapshotSpec, "order_item_entitlement_snapshots");
  await syncUpserts(client, fb.orderSnapshotItems, fa.orderSnapshotItems, orderSnapshotItemSpec, "order_item_entitlement_snapshot_items");
  await syncUpserts(client, before.order_installments, after.order_installments, orderInstallmentSpec, "order_installments");
  await syncUpserts(client, before.subscriptions, after.subscriptions, subscriptionSpec, "subscriptions");
  await syncUpserts(client, before.invoices, after.invoices, invoiceSpec, "invoices");
  await syncUpserts(client, fb.invoiceItems, fa.invoiceItems, invoiceItemSpec, "invoice_items");
  await syncUpserts(client, before.payment_providers, after.payment_providers, providerSpec, "payment_providers");
  await syncUpserts(client, before.payment_methods, after.payment_methods, methodSpec, "payment_methods");
  await syncUpserts(client, before.payment_submissions, after.payment_submissions, submissionSpec, "payment_submissions");
  await syncUpserts(client, before.payment_transactions, after.payment_transactions, transactionSpec, "payment_transactions");
  // C-04/0023 follow-up: subscription_periods references invoices(id)
  // AND payment_transactions(id) (FKs added by migration 0023), so
  // periods MUST sync after both — syncing them before invoices (the
  // old order) made every renewal-invoice sweep fail with
  // subscription_periods_invoice_id_fkey. Delete order already
  // handles this (ON DELETE SET NULL), only the insert order broke.
  await syncUpserts(client, fb.periods, fa.periods, periodSpec, "subscription_periods");
  await syncUpserts(client, before.payment_verification_logs, after.payment_verification_logs, verificationLogSpec, "payment_verification_logs");
  await syncUpserts(client, before.payment_refunds, after.payment_refunds, refundSpec, "payment_refunds");
  await syncUpserts(client, before.expense_categories, after.expense_categories, expenseCategorySpec, "expense_categories");
  await syncUpserts(client, before.expenses, after.expenses, expenseSpec, "expenses");
  await syncUpserts(client, before.licenses, after.licenses, licenseSpec, "licenses");
  await syncUpserts(client, fb.licenseSnapshots, fa.licenseSnapshots, licenseSnapshotSpec, "license_entitlement_snapshots");
  await syncUpserts(client, fb.licenseSnapshotItems, fa.licenseSnapshotItems, licenseSnapshotItemSpec, "license_entitlement_snapshot_items");
  await syncUpserts(client, fb.licenseActivations, fa.licenseActivations, licenseActivationSpec, "license_activations");
  await syncUpserts(client, before.license_events, after.license_events, licenseEventSpec, "license_events");
  await syncUpserts(client, before.support_tickets, after.support_tickets, supportTicketSpec, "support_tickets");
  await syncUpserts(client, before.ticket_comments, after.ticket_comments, ticketCommentSpec, "ticket_comments");
  await syncUpserts(client, before.leads, after.leads, leadSpec, "leads");
  await syncUpserts(client, before.tracking_configurations, after.tracking_configurations, trackingConfigSpec, "tracking_configurations");
  await syncUpserts(client, before.tracking_events, after.tracking_events, trackingEventSpec, "tracking_events");
  await syncUpserts(client, before.webhook_endpoints, after.webhook_endpoints, webhookEndpointSpec, "webhook_endpoints");
  await syncUpserts(client, before.webhook_deliveries, after.webhook_deliveries, webhookDeliverySpec, "webhook_deliveries");
  await syncUpserts(client, before.outbox_events, after.outbox_events, outboxSpec, "outbox_events");
  await syncUpserts(client, before.idempotency_records, after.idempotency_records, idempotencySpec, "idempotency_records");
  await syncUpserts(client, before.audit_logs, after.audit_logs, auditLogSpec, "audit_logs");
  await syncUpserts(client, before.sent_reminders, after.sent_reminders, sentReminderSpec, "sent_reminders");

  // -- Derived rows for surviving parents --------------------------------------
  // Staff status lives in staff_profiles (the store model has no such table).
  for (const user of after.users) {
    const prev = beforeUsers.get(user.id);
    if (prev === undefined || prev.status !== user.status) {
      await execSql(
        client,
        `INSERT INTO staff_profiles (user_id, display_name, status) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status`,
        [user.id, user.name, user.status]
      );
    }
  }

  // Role permission_keys live in role_permissions → permissions.
  let permissionIds: Map<string, string> | null = null;
  const loadPermissionIds = async (): Promise<Map<string, string>> => {
    if (permissionIds) return permissionIds;
    const rows = await queryRows(client, `SELECT id, "key" FROM permissions`);
    permissionIds = new Map(rows.map((r) => [String(r["key"]), String(r["id"])]));
    return permissionIds;
  };
  for (const role of after.roles) {
    const prev = beforeRoles.get(role.id);
    if (
      prev === undefined ||
      JSON.stringify(prev.permission_keys) !== JSON.stringify(role.permission_keys)
    ) {
      const ids = await loadPermissionIds();
      await del("role_permissions", `"role_id" = $1`, [role.id]);
      for (const key of role.permission_keys) {
        const pid = ids.get(key);
        if (!pid) {
          throw new Error(
            `DrizzleStore: role '${role.key}' references permission '${key}' which does not exist in the permissions table (migration 0001 seed).`
          );
        }
        await ins("role_permissions", ["role_id", "permission_id"], [role.id, pid]);
      }
    }
  }

  // Product distribution channels live in product_distribution_channels.
  for (const product of after.products) {
    const prev = beforeProducts.get(product.id);
    if (
      prev === undefined ||
      JSON.stringify(prev.distribution_channels) !==
        JSON.stringify(product.distribution_channels)
    ) {
      await del("product_distribution_channels", `"product_id" = $1`, [product.id]);
      for (const channel of product.distribution_channels) {
        await ins(
          "product_distribution_channels",
          ["id", "product_id", "channel_key", "status"],
          [randomUUID(), product.id, channel, "active"]
        );
      }
    }
  }

  // Site product_ids live in site_products.
  for (const site of after.integrated_sites) {
    const prev = beforeSites.get(site.id);
    if (
      prev === undefined ||
      JSON.stringify(prev.product_ids) !== JSON.stringify(site.product_ids)
    ) {
      await del("site_products", `"integrated_site_id" = $1`, [site.id]);
      for (const pid of site.product_ids) {
        await ins("site_products", ["integrated_site_id", "product_id"], [site.id, pid]);
      }
    }
  }

  // Payment method transfer rails live in payment_method_transfer_rails.
  // display_label has no store-model source; the rail key is the label.
  for (const method of after.payment_methods) {
    const prev = beforeMethods.get(method.id);
    if (
      prev === undefined ||
      JSON.stringify(prev.transfer_rails) !== JSON.stringify(method.transfer_rails)
    ) {
      await del("payment_method_transfer_rails", `"payment_method_id" = $1`, [method.id]);
      for (const rail of method.transfer_rails) {
        await ins(
          "payment_method_transfer_rails",
          ["id", "payment_method_id", "rail_key", "display_label"],
          [randomUUID(), method.id, rail, rail]
        );
      }
    }
  }

  // Order attributions live in order_attributions (1:1 by order_id).
  const attributionCols = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbp",
    "fbc",
  ] as const;
  for (const order of after.orders) {
    const prev = beforeOrders.get(order.id);
    if (
      prev === undefined ||
      JSON.stringify(prev.attribution ?? null) !==
        JSON.stringify(order.attribution ?? null)
    ) {
      if (order.attribution === null) {
        await del("order_attributions", `"order_id" = $1`, [order.id]);
      } else {
        const vals = attributionCols.map(
          (k) => order.attribution?.[k] ?? null
        );
        await execSql(
          client,
          `INSERT INTO order_attributions (id, order_id, ${attributionCols.map((c) => `"${c}"`).join(", ")})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (order_id) DO UPDATE SET ${attributionCols.map((c, i) => `"${c}" = $${i + 3}`).join(", ")}`,
          [randomUUID(), order.id, ...vals]
        );
      }
    }
  }

  // Webhook secrets live in webhook_endpoint_secrets (keyed by key_id).
  for (const endpoint of after.webhook_endpoints) {
    const prev = beforeEndpoints.get(endpoint.id);
    const changed =
      prev === undefined ||
      prev.secret_key_id !== endpoint.secret_key_id ||
      prev.secret_ciphertext !== endpoint.secret_ciphertext ||
      prev.key_version !== endpoint.key_version;
    if (changed) {
      await execSql(
        client,
        `UPDATE webhook_endpoint_secrets SET status = 'revoked'
          WHERE webhook_endpoint_id = $1 AND key_id <> $2 AND status = 'active'`,
        [endpoint.id, endpoint.secret_key_id]
      );
      await execSql(
        client,
        `INSERT INTO webhook_endpoint_secrets (id, webhook_endpoint_id, key_id, secret_ciphertext, key_version, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (key_id) DO UPDATE SET
           webhook_endpoint_id = EXCLUDED.webhook_endpoint_id,
           secret_ciphertext = EXCLUDED.secret_ciphertext,
           key_version = EXCLUDED.key_version,
           status = 'active'`,
        [
          randomUUID(),
          endpoint.id,
          endpoint.secret_key_id,
          endpoint.secret_ciphertext,
          endpoint.key_version,
        ]
      );
    }
  }

  // -- Package current_version_id fix-up ---------------------------------------
  // packageSpec deliberately writes NULL on insert / skips the column on
  // update (same-tx package ↔ version cycle). Now that the version rows
  // exist, backfill the real value for every package touched this tx.
  if (caps.packagesCurrentVersion) {
    for (const pkgId of touchedPackages) {
      const pkg = after.product_packages.find((p) => p.id === pkgId);
      if (pkg) {
        await execSql(
          client,
          `UPDATE product_packages SET current_version_id = $2 WHERE id = $1`,
          [pkg.id, pkg.current_version_id]
        );
      }
    }
  }

  // -- Sequence counters ---------------------------------------------------------
  if (caps.sequenceCounters) {
    const keys = ["customer", "order", "invoice", "subscription", "license", "ticket", "lead"] as const;
    for (const key of keys) {
      if (before.sequence_counters[key] !== after.sequence_counters[key]) {
        await execSql(
          client,
          `INSERT INTO sequence_counters (counter_key, counter_value) VALUES ($1, $2)
           ON CONFLICT (counter_key) DO UPDATE SET counter_value = EXCLUDED.counter_value, updated_at = now()`,
          [key, after.sequence_counters[key]]
        );
      }
    }
  }
  // Without migration 0002 the counters stay in memory only (derived from
  // the data on load); see loadStateInternalImpl.
}
