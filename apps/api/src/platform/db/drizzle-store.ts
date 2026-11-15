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
 * 1. ONE pg Client, serialized writers. The store holds a single `pg`
 *    Client (per the Hyperdrive design: one pinned connection). A pg
 *    Client cannot run concurrent queries, so ALL database access is
 *    serialized through an internal promise queue (`txQueue`): one
 *    withTransaction — or one loadState — at a time, across all callers.
 *    `SELECT pg_advisory_xact_lock(727271)` additionally serializes
 *    writers across SEPARATE store instances / processes hitting the same
 *    database (mirrors the in-memory mutex semantics). Nested
 *    withTransaction calls deadlock exactly like the base class — don't.
 *    `drizzleDb` shares this same client, so Better Auth queries issued
 *    through it must not run concurrently with a withTransaction either.
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
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
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
  StackMateDataStore,
  type AuditLogRecord,
  type CustomerRecord,
  type DatabaseState,
  type IdempotencyRecord,
  type IntegratedSiteRecord,
  type InvoiceRecord,
  type LicenseActivationRecord,
  type LicenseEntitlementSnapshotRecord,
  type LicenseRecord,
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
  type PaymentTransactionRecord,
  type PaymentVerificationLogRecord,
  type ProductFeatureRecord,
  type ProductPackageRecord,
  type ProductRecord,
  type RoleRecord,
  type SessionRecord,
  type SiteCredentialRecord,
  type SubscriptionPeriodRecord,
  type SubscriptionRecord,
  type TrackingConfigRecord,
  type TrackingEventRecord,
  type UploadedAssetRecord,
  type UserRecord,
  type WebhookEndpointRecord,
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
  if (typeof v === "string") return v;
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
 * Tables that MUST exist (migrations 0000/0001). sequence_counters is
 * deliberately excluded — it is migration 0002 and handled as a capability.
 */
const REQUIRED_TABLES: readonly string[] = [
  "users",
  "sessions",
  "roles",
  "permissions",
  "user_roles",
  "role_permissions",
  "staff_profiles",
  "customers",
  "uploaded_assets",
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
];

async function detectCapabilities(client: Client): Promise<StoreCapabilities> {
  const rows = await queryRows(
    client,
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'sequence_counters')
          OR (table_name = 'users' AND column_name = 'password_hash')
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

  private closed = false;
  /** Serializes ALL database access on the shared client (see header 1). */
  private txQueue: Promise<void> = Promise.resolve();
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

  private constructor(pgClient: Client, drizzleDb: NodePgDatabase<typeof schema>) {
    super(DEFAULT_SIGNING_KEY_ID);
    this.pgClient = pgClient;
    this.drizzleDb = drizzleDb;
  }

  public static async create(
    opts: DrizzleStoreCreateOptions
  ): Promise<DrizzleStore> {
    if (!opts.connectionString || opts.connectionString.trim().length === 0) {
      throw new Error(
        "DrizzleStore.create: connectionString is empty. Pass the PostgreSQL connection string (in production, HYPERDRIVE_NO_CACHE.connectionString)."
      );
    }
    const pgClient = new Client({ connectionString: opts.connectionString });
    try {
      await pgClient.connect();
    } catch (error) {
      throw new Error(
        `DrizzleStore.create: could not connect to PostgreSQL: ${(error as Error).message}`
      );
    }
    const drizzleDb = drizzle(pgClient, { schema });
    const store = new DrizzleStore(pgClient, drizzleDb);
    try {
      store.capabilities = await detectCapabilities(pgClient);
      // Throws a clear error naming the missing table when migrations
      // 0000/0001 have not been applied. Reference rows come from
      // migration 0001 — this store never auto-seeds them.
      await assertRequiredTables(pgClient);
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
      await pgClient.end().catch(() => {});
      throw error;
    }
    return store;
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
    opts: DrizzleStoreCreateOptions
  ): Promise<void> {
    const secret = this.resolveEncryptionSecret(opts);
    this.encryptionSecret = secret;
    if (!this.capabilities.signingKeys) {
      throw new Error(
        "DrizzleStore: signing_keys table is missing. Apply migration 0004 (db/migrations/0004_signing_keys.sql) before starting the API — license signing keys are durable-only and a per-process key is no longer generated."
      );
    }
    const client = this.pgClient;
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
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
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
    const release = await this.acquireQueue();
    const client = this.pgClient;
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
    const release = await this.acquireQueue();
    const client = this.pgClient;
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
    } finally {
      release();
    }
  }

  /**
   * Reload all tables into this.state (per-request refresh). Serialized
   * against withTransaction through the same queue so two callers never
   * interleave queries on the shared client.
   */
  public async loadState(): Promise<DatabaseState> {
    this.assertOpen();
    const release = await this.acquireQueue();
    try {
      this.queryMetrics.uncachedQueries += 1;
      await this.loadStateInternal(this.pgClient);
      return this.state;
    } finally {
      release();
    }
  }

  private async loadStateInternal(client: Client): Promise<void> {
    this.state = await loadStateInternalImpl(client, this.capabilities);
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
    const release = await this.acquireQueue();
    const client = this.pgClient;
    let begun = false;
    let snapshotJson: string | null = null;
    try {
      this.queryMetrics.uncachedQueries += 1;
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITER_ADVISORY_LOCK_KEY]);
      await this.loadStateInternal(client);
      snapshotJson = JSON.stringify(this.state);
      const result = await fn(this.state);
      const before = JSON.parse(snapshotJson) as DatabaseState;
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
      if (snapshotJson !== null) {
        this.state = JSON.parse(snapshotJson) as DatabaseState;
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

  /** End the pg client. Idempotent; the store must not be used afterwards. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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

  private async acquireQueue(): Promise<() => void> {
    let release!: () => void;
    const prev = this.txQueue;
    this.txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
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
  };
}

async function loadStateInternalImpl(
  client: Client,
  caps: StoreCapabilities
): Promise<DatabaseState> {

  // -- Identity -------------------------------------------------------------
  const userRows = await queryRows(
    client,
    `SELECT u.id, u.name, u.email, u.email_verified, u.created_at, u.updated_at,
            sp.status AS staff_status
            ${caps.usersPasswordHash ? ", u.password_hash" : ""}
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
      ORDER BY u.created_at ASC, u.id ASC`
  );
  const users: UserRecord[] = userRows.map((row) => ({
    id: reqStr(row, "id", "users"),
    name: reqStr(row, "name", "users"),
    email: reqStr(row, "email", "users"),
    email_verified: bool(row, "email_verified"),
    // Users created by Better Auth have no password_hash (NULL) and cannot
    // use staff password sign-in; verifyPasswordScrypt fails closed on "".
    password_hash: caps.usersPasswordHash ? (str(row, "password_hash") ?? "") : "",
    status: asEnum(str(row, "staff_status"), ["active", "suspended"] as const, "active"),
    created_at: reqIso(row, "created_at", "users"),
    updated_at: reqIso(row, "updated_at", "users"),
  }));

  const sessionRows = await queryRows(
    client,
    `SELECT id, token, user_id, ip_address, user_agent, expires_at, created_at
       FROM sessions ORDER BY created_at ASC, id ASC`
  );
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
  const roleRows = await queryRows(
    client,
    `SELECT id, "key", name, description, is_system, created_at
       FROM roles ORDER BY created_at ASC, id ASC`
  );
  const rolePermRows = await queryRows(
    client,
    `SELECT rp.role_id, p."key" AS permission_key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id`
  );
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

  const userRoleRows = await queryRows(
    client,
    `SELECT user_id, role_id, created_at FROM user_roles
      ORDER BY created_at ASC, user_id ASC, role_id ASC`
  );
  const user_roles = userRoleRows.map((row) => ({
    user_id: reqStr(row, "user_id", "user_roles"),
    role_id: reqStr(row, "role_id", "user_roles"),
    assigned_at: reqIso(row, "created_at", "user_roles"),
  }));

  // Reference data must come from migration 0001 — never auto-seeded here.
  const currencyRows = await queryRows(client, `SELECT code FROM currencies`);
  if (roles.length === 0 || currencyRows.length === 0) {
    throw new Error(
      "DrizzleStore: reference data is missing (roles or currencies table is empty). Migration 0001 (db/migrations/0001_seed_reference_catalog.sql) has not been applied."
    );
  }

  // -- Assets / customers ----------------------------------------------------
  const assetRows = await queryRows(
    client,
    `SELECT id, object_key, bucket_name, original_filename, content_type,
            byte_size, checksum_sha256, visibility, uploaded_by_user_id,
            owner_customer_id, created_at
       FROM uploaded_assets ORDER BY created_at ASC, id ASC`
  );
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

  const customerRows = await queryRows(
    client,
    `SELECT id, customer_number, customer_type, name, email, normalized_email,
            phone, normalized_phone, company_name, country_code, status,
            registration_source, notes, created_at, updated_at
       FROM customers ORDER BY created_at ASC, id ASC`
  );
  const customers: CustomerRecord[] = customerRows.map((row) => ({
    id: reqStr(row, "id", "customers"),
    customer_number: reqStr(row, "customer_number", "customers"),
    customer_type: asEnum(str(row, "customer_type"), ["person", "business"] as const, "person"),
    name: reqStr(row, "name", "customers"),
    email: str(row, "email"),
    normalized_email: str(row, "normalized_email"),
    phone: str(row, "phone"),
    normalized_phone: str(row, "normalized_phone"),
    company_name: str(row, "company_name"),
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

  // -- Catalog ---------------------------------------------------------------
  const channelRows = await queryRows(
    client,
    `SELECT product_id, channel_key FROM product_distribution_channels
      ORDER BY product_id, channel_key`
  );
  const channelsByProduct = groupBy(channelRows, (r) => String(r["product_id"]));
  const productRows = await queryRows(
    client,
    `SELECT id, code, slug, name, description, product_type, fulfillment_type,
            status, website_url, documentation_url, created_by_user_id,
            created_at, updated_at
            ${caps.productsDefaults ? ", default_activation_limit, offline_grace_hours" : ""}
       FROM products ORDER BY created_at ASC, id ASC`
  );
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
      created_by_user_id: str(row, "created_by_user_id"),
      created_at: reqIso(row, "created_at", "products"),
      updated_at: reqIso(row, "updated_at", "products"),
    };
  });

  const featureRows = await queryRows(
    client,
    `SELECT id, product_id, feature_key, name, description, value_type, unit,
            default_value, status, created_at, updated_at
       FROM product_features ORDER BY created_at ASC, id ASC`
  );
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

  const packageRows = await queryRows(
    client,
    `SELECT id, product_id, package_key, name, description, status,
            created_at, updated_at
            ${caps.packagesCurrentVersion ? ", current_version_id" : ""}
       FROM product_packages ORDER BY created_at ASC, id ASC`
  );
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

  const versionFeatureRows = await queryRows(
    client,
    `SELECT id, package_version_id, product_id, product_feature_id,
            feature_key_snapshot, value_type_snapshot, entitlement_value
            ${caps.packageVersionFeaturesUnit ? ", unit_snapshot" : ""}
       FROM package_version_features
      ORDER BY package_version_id, feature_key_snapshot`
  );
  const grantsByVersion = groupBy(versionFeatureRows, (r) =>
    String(r["package_version_id"])
  );
  const versionRows = await queryRows(
    client,
    `SELECT id, package_id, product_id, version_number, status,
            change_summary, published_at, created_at
       FROM package_versions ORDER BY created_at ASC, id ASC`
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

  const priceRows = await queryRows(
    client,
    `SELECT id, package_version_id, price_key, price_kind, amount_minor,
            currency_code, interval_unit, interval_count, trial_days,
            setup_fee_minor, status, created_at
            ${caps.packagePricesUsedInOrders ? ", used_in_orders" : ""}
       FROM package_prices ORDER BY created_at ASC, id ASC`
  );
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
  const siteProductRows = await queryRows(
    client,
    `SELECT integrated_site_id, product_id FROM site_products
      ORDER BY integrated_site_id, product_id`
  );
  const productsBySite = groupBy(siteProductRows, (r) =>
    String(r["integrated_site_id"])
  );
  const domainRows = await queryRows(
    client,
    `SELECT id, integrated_site_id, domain, verification_method,
            verification_challenge, verification_status, verified_at, is_primary
       FROM site_domains ORDER BY integrated_site_id, created_at ASC, id ASC`
  );
  const domainsBySite = groupBy(domainRows, (r) => String(r["integrated_site_id"]));
  const siteRows = await queryRows(
    client,
    `SELECT id, site_key, name, environment, status, api_version,
            allowed_capabilities, created_at, updated_at
       FROM integrated_sites ORDER BY created_at ASC, id ASC`
  );
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

  const credentialRows = await queryRows(
    client,
    `SELECT id, integrated_site_id, key_id, credential_type, secret_hash,
            secret_ciphertext, encryption_key_version, scopes, status,
            created_at, revoked_at, last_used_at
       FROM site_credentials ORDER BY created_at ASC, id ASC`
  );
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

  const nonceRows = await queryRows(
    client,
    `SELECT credential_id, nonce, expires_at FROM request_nonces
      ORDER BY created_at ASC, credential_id ASC, nonce ASC`
  );
  const request_nonces = nonceRows.map((row) => ({
    credential_id: reqStr(row, "credential_id", "request_nonces"),
    nonce: reqStr(row, "nonce", "request_nonces"),
    expires_at: reqIso(row, "expires_at", "request_nonces"),
  }));

  // -- Orders (items + entitlement snapshots + attributions) -----------------
  const attributionRows = await queryRows(
    client,
    `SELECT order_id, utm_source, utm_medium, utm_campaign, utm_content,
            utm_term, fbp, fbc FROM order_attributions`
  );
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

  const orderSnapshotItemRows = await queryRows(
    client,
    `SELECT id, snapshot_id, feature_key_snapshot, value_type_snapshot,
            entitlement_value, unit_snapshot
       FROM order_item_entitlement_snapshot_items
      ORDER BY snapshot_id, feature_key_snapshot`
  );
  const orderSnapshotItemsBySnapshot = groupBy(orderSnapshotItemRows, (r) =>
    String(r["snapshot_id"])
  );
  const orderSnapshotRows = await queryRows(
    client,
    `SELECT id, order_item_id, source_type, source_package_version_id,
            schema_version, snapshot_hash, created_at
       FROM order_item_entitlement_snapshots`
  );
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

  const orderItemRows = await queryRows(
    client,
    `SELECT id, order_id, product_id, package_id, package_version_id,
            package_price_id, item_kind, fulfillment_type_snapshot,
            product_name_snapshot, package_name_snapshot,
            package_version_snapshot, price_kind_snapshot,
            interval_unit_snapshot, interval_count_snapshot,
            activation_limit_snapshot, quantity, unit_amount_minor,
            line_subtotal_minor, line_discount_minor, line_tax_minor,
            line_total_minor, currency_code, created_at
       FROM order_items ORDER BY order_id, created_at ASC, id ASC`
  );
  const orderItemsByOrder = groupBy(orderItemRows, (r) => String(r["order_id"]));
  const orderRows = await queryRows(
    client,
    `SELECT id, order_number, public_reference, customer_id, source,
            integrated_site_id, status, payment_status, currency_code,
            subtotal_minor, discount_minor, tax_minor, total_minor,
            customer_note, internal_note, created_by_user_id, created_at,
            updated_at, completed_at, cancelled_at
       FROM orders ORDER BY created_at ASC, id ASC`
  );
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
        ["unpaid", "pending_verification", "paid", "partially_refunded", "refunded"] as const,
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
      created_at: reqIso(row, "created_at", "orders"),
      updated_at: reqIso(row, "updated_at", "orders"),
      completed_at: iso(row, "completed_at"),
      cancelled_at: iso(row, "cancelled_at"),
    };
  });

  // -- Subscriptions (periods) + invoices (items) -----------------------------
  const periodRows = await queryRows(
    client,
    `SELECT id, subscription_id, period_number, period_start, period_end,
            status, renewal_order_id, invoice_id, payment_transaction_id,
            activated_at, created_at
       FROM subscription_periods
      ORDER BY subscription_id, period_number ASC`
  );
  const periodsBySubscription = groupBy(periodRows, (r) =>
    String(r["subscription_id"])
  );
  const subscriptionRows = await queryRows(
    client,
    `SELECT id, subscription_number, customer_id, product_id,
            source_order_item_id, source_package_version_id, status,
            billing_kind, interval_unit, interval_count, currency_code,
            current_period_start, current_period_end, next_renewal_at,
            cancel_at_period_end, cancelled_at, created_at, updated_at
            ${caps.subscriptionsUnitAmount ? ", unit_amount_minor" : ""}
       FROM subscriptions ORDER BY created_at ASC, id ASC`
  );
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

  const invoiceItemRows = await queryRows(
    client,
    `SELECT id, invoice_id, description_snapshot, quantity,
            unit_amount_minor, line_amount_minor, currency_code
       FROM invoice_items ORDER BY invoice_id, created_at ASC, id ASC`
  );
  const invoiceItemsByInvoice = groupBy(invoiceItemRows, (r) =>
    String(r["invoice_id"])
  );
  const invoiceRows = await queryRows(
    client,
    `SELECT id, invoice_number, customer_id, order_id, subscription_id,
            invoice_type, status, currency_code, subtotal_minor,
            discount_minor, tax_minor, total_minor, amount_paid_minor,
            amount_due_minor, issued_at, paid_at, created_at
       FROM invoices ORDER BY created_at ASC, id ASC`
  );
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
  const providerRows = await queryRows(
    client,
    `SELECT id, provider_key, display_name, provider_type, adapter_key, status
       FROM payment_providers ORDER BY created_at ASC, id ASC`
  );
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

  const railRows = await queryRows(
    client,
    `SELECT payment_method_id, rail_key FROM payment_method_transfer_rails
      ORDER BY payment_method_id, rail_key`
  );
  const railsByMethod = groupBy(railRows, (r) => String(r["payment_method_id"]));
  const methodRows = await queryRows(
    client,
    `SELECT id, provider_id, method_key, display_name, method_kind,
            account_type, account_label, instructions, configuration,
            is_enabled, sort_order, created_at
       FROM payment_methods ORDER BY created_at ASC, id ASC`
  );
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

  const submissionRows = await queryRows(
    client,
    `SELECT id, order_id, customer_id, payment_method_id, amount_minor,
            currency_code, sender_name, sender_phone, sender_bank_name,
            sender_account_reference, transfer_rail_key,
            transaction_reference, normalized_transaction_reference,
            payment_date, proof_asset_id, status, customer_note,
            submitted_at, reviewed_at, reviewed_by_user_id
            ${caps.paymentSubmissionsDuplicateWarning ? ", duplicate_risk_warning" : ""}
       FROM payment_submissions ORDER BY submitted_at ASC, id ASC`
  );
  const payment_submissions: PaymentSubmissionRecord[] = submissionRows.map((row) => ({
    id: reqStr(row, "id", "payment_submissions"),
    order_id: reqStr(row, "order_id", "payment_submissions"),
    customer_id: reqStr(row, "customer_id", "payment_submissions"),
    payment_method_id: reqStr(row, "payment_method_id", "payment_submissions"),
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

  const transactionRows = await queryRows(
    client,
    `SELECT id, order_id, payment_method_id, payment_submission_id,
            provider_id, provider_transaction_id, amount_minor, currency_code,
            status, paid_at, verified_by_user_id, verification_source,
            created_at
       FROM payment_transactions ORDER BY created_at ASC, id ASC`
  );
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

  const verificationLogRows = await queryRows(
    client,
    `SELECT id, payment_submission_id, actor_user_id, decision, reason_code,
            customer_message, notes, created_at
       FROM payment_verification_logs ORDER BY created_at ASC, id ASC`
  );
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

  // -- Licenses (snapshots + items + activations) -----------------------------
  const licenseSnapshotItemRows = await queryRows(
    client,
    `SELECT id, snapshot_id, feature_key_snapshot, value_type_snapshot,
            entitlement_value, unit_snapshot
       FROM license_entitlement_snapshot_items
      ORDER BY snapshot_id, feature_key_snapshot`
  );
  const licenseSnapshotItemsBySnapshot = groupBy(licenseSnapshotItemRows, (r) =>
    String(r["snapshot_id"])
  );
  const licenseSnapshotRows = await queryRows(
    client,
    `SELECT id, license_id, version_number, source_type, effective_at,
            reason, snapshot_hash, created_by_user_id, created_at
       FROM license_entitlement_snapshots
      ORDER BY license_id, version_number ASC`
  );
  const licenseSnapshotsByLicense = groupBy(licenseSnapshotRows, (r) =>
    String(r["license_id"])
  );
  const activationRows = await queryRows(
    client,
    `SELECT id, license_id, installation_id_hash, domain_normalized,
            environment, status, activated_at, last_seen_at, deactivated_at,
            metadata, created_at
       FROM license_activations
      ORDER BY license_id, activated_at ASC, id ASC`
  );
  const activationsByLicense = groupBy(activationRows, (r) => String(r["license_id"]));
  const licenseRows = await queryRows(
    client,
    `SELECT id, license_number, product_id, customer_id, source_order_item_id,
            subscription_id, license_key_hash, license_key_hint, status,
            activation_limit, valid_from, expires_at, grace_until,
            current_entitlement_snapshot_id, issued_at, created_at, updated_at
       FROM licenses ORDER BY created_at ASC, id ASC`
  );
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
  const trackingConfigRows = await queryRows(
    client,
    `SELECT id, integrated_site_id, provider, pixel_id,
            access_token_ciphertext, encryption_key_version, test_event_code,
            enabled_events, status, created_at, updated_at, rotated_at
       FROM tracking_configurations ORDER BY created_at ASC, id ASC`
  );
  const tracking_configurations: TrackingConfigRecord[] = trackingConfigRows.map(
    (row) => ({
      id: reqStr(row, "id", "tracking_configurations"),
      integrated_site_id: reqStr(row, "integrated_site_id", "tracking_configurations"),
      provider: asEnum(str(row, "provider"), ["meta"] as const, "meta"),
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

  const trackingEventRows = await queryRows(
    client,
    `SELECT id, integrated_site_id, event_name, event_id, event_time,
            event_source_url, order_id, consent_state,
            consent_policy_version, sanitized_payload, status, created_at
            ${caps.trackingEventsDelivery ? ", delivery_attempts, delivered_at" : ""}
       FROM tracking_events ORDER BY created_at ASC, id ASC`
  );
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
      ["received", "queued", "processed", "rejected"] as const,
      "received"
    ),
    delivery_attempts: caps.trackingEventsDelivery
      ? reqNum(row, "delivery_attempts", "tracking_events")
      : 0,
    delivered_at: caps.trackingEventsDelivery ? iso(row, "delivered_at") : null,
    created_at: reqIso(row, "created_at", "tracking_events"),
  }));

  // -- Webhooks / outbox / idempotency / audit ----------------------------------
  const endpointSecretRows = await queryRows(
    client,
    `SELECT webhook_endpoint_id, key_id, secret_ciphertext, key_version, status
       FROM webhook_endpoint_secrets ORDER BY webhook_endpoint_id, created_at ASC`
  );
  const secretsByEndpoint = groupBy(endpointSecretRows, (r) =>
    String(r["webhook_endpoint_id"])
  );
  const endpointRows = await queryRows(
    client,
    `SELECT id, integrated_site_id, url, description, subscribed_events,
            status, created_at
       FROM webhook_endpoints ORDER BY created_at ASC, id ASC`
  );
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

  const deliveryRows = await queryRows(
    client,
    `SELECT id, webhook_endpoint_id, event_id, delivery_id, status,
            attempt_count, last_http_status, delivered_at
       FROM webhook_deliveries ORDER BY created_at ASC, id ASC`
  );
  const webhook_deliveries = deliveryRows.map((row) => ({
    id: reqStr(row, "id", "webhook_deliveries"),
    webhook_endpoint_id: reqStr(row, "webhook_endpoint_id", "webhook_deliveries"),
    event_id: reqStr(row, "event_id", "webhook_deliveries"),
    delivery_id: reqStr(row, "delivery_id", "webhook_deliveries"),
    status: asEnum(
      str(row, "status"),
      ["pending", "delivered", "retrying", "failed"] as const,
      "pending"
    ),
    attempt_count: reqNum(row, "attempt_count", "webhook_deliveries"),
    last_http_status: num(row, "last_http_status"),
    delivered_at: iso(row, "delivered_at"),
  }));

  const outboxRows = await queryRows(
    client,
    `SELECT id, event_key, aggregate_type, aggregate_id, event_type, payload,
            status, attempt_count, available_at, locked_until, locked_by,
            last_error_code, created_at, processed_at
       FROM outbox_events ORDER BY created_at ASC, id ASC`
  );
  const outbox_events: OutboxEventRecord[] = outboxRows.map((row) => ({
    id: reqStr(row, "id", "outbox_events"),
    event_key: reqStr(row, "event_key", "outbox_events"),
    aggregate_type: reqStr(row, "aggregate_type", "outbox_events"),
    aggregate_id: reqStr(row, "aggregate_id", "outbox_events"),
    event_type: reqStr(row, "event_type", "outbox_events"),
    payload: asJsonObject(row, "payload"),
    status: asEnum(
      str(row, "status"),
      ["pending", "processing", "delivered", "dead_letter"] as const,
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

  const idempotencyRows = await queryRows(
    client,
    `SELECT id, scope_key, idempotency_key, request_hash, status,
            response_status, expires_at, created_at
            ${caps.idempotencyResponseBody ? ", response_body" : ", response_reference"}
       FROM idempotency_records ORDER BY created_at ASC, id ASC`
  );
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

  const auditRows = await queryRows(
    client,
    `SELECT id, actor_type, actor_user_id, integrated_site_id, action,
            resource_type, resource_id, outcome, request_id, changes, created_at
       FROM audit_logs ORDER BY created_at DESC, id DESC`
  );
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

  // -- Sequence counters --------------------------------------------------------
  const state: DatabaseState = {
    users,
    sessions,
    roles,
    user_roles,
    uploaded_assets,
    products,
    product_features,
    product_packages,
    package_versions,
    package_prices,
    customers,
    orders,
    invoices,
    payment_providers,
    payment_methods,
    payment_submissions,
    payment_transactions,
    payment_verification_logs,
    subscriptions,
    licenses,
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
    sequence_counters: { ...COUNTER_BASE_VALUES },
  };

  if (caps.sequenceCounters) {
    const counterRows = await queryRows(
      client,
      `SELECT counter_key, counter_value FROM sequence_counters`
    );
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
          key === "license")
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
  for (const row of after) {
    const key = spec.keyOf(row);
    const prev = beforeByKey.get(key);
    if (prev === undefined) {
      await spec.insert(client, row);
      touched.add(key);
    } else if (
      JSON.stringify(spec.scalarOf(prev)) !== JSON.stringify(spec.scalarOf(row))
    ) {
      if (spec.immutable) throw immutableError(table, key, "update");
      await spec.update(client, prev, row);
      touched.add(key);
    }
  }
  return touched;
}

function insertSql(table: string, columns: string[]): string {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const params = columns.map((_, i) => `$${i + 1}`).join(", ");
  return `INSERT INTO "${table}" (${cols}) VALUES (${params})`;
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
      await ins("users", cols, vals);
    },
    update: async (c, _b, r) => {
      const cols = ["name", "email", "email_verified", "updated_at"];
      const vals: unknown[] = [r.name, r.email, r.email_verified, r.updated_at];
      if (caps.usersPasswordHash) {
        cols.push("password_hash");
        vals.push(r.password_hash);
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
          "company_name",
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
          r.company_name,
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
        "company_name",
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
          r.company_name,
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
  await syncDeletes(client, before.payment_verification_logs, after.payment_verification_logs, verificationLogSpec, "payment_verification_logs");
  await syncDeletes(client, fb.licenseSnapshotItems, fa.licenseSnapshotItems, licenseSnapshotItemSpec, "license_entitlement_snapshot_items");
  await syncDeletes(client, fb.licenseSnapshots, fa.licenseSnapshots, licenseSnapshotSpec, "license_entitlement_snapshots");
  await syncDeletes(client, fb.licenseActivations, fa.licenseActivations, licenseActivationSpec, "license_activations");
  await syncDeletes(client, fb.invoiceItems, fa.invoiceItems, invoiceItemSpec, "invoice_items");
  await syncDeletes(client, before.invoices, after.invoices, invoiceSpec, "invoices");
  await syncDeletes(client, fb.periods, fa.periods, periodSpec, "subscription_periods");
  await syncDeletes(client, before.licenses, after.licenses, licenseSpec, "licenses");
  await syncDeletes(client, before.subscriptions, after.subscriptions, subscriptionSpec, "subscriptions");
  await syncDeletes(client, fb.orderSnapshotItems, fa.orderSnapshotItems, orderSnapshotItemSpec, "order_item_entitlement_snapshot_items");
  await syncDeletes(client, fb.orderSnapshots, fa.orderSnapshots, orderSnapshotSpec, "order_item_entitlement_snapshots");
  await syncDeletes(client, fb.orderItems, fa.orderItems, orderItemSpec, "order_items");
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
  await syncDeletes(client, before.sessions, after.sessions, sessionSpec, "sessions");
  await syncDeletes(client, before.user_roles, after.user_roles, userRoleSpec, "user_roles");
  await deleteDerivedForMissing("role_permissions", "role_id", before.roles.map((r) => r.id), new Set(after.roles.map((r) => r.id)));
  await syncDeletes(client, before.roles, after.roles, roleSpec, "roles");
  await deleteDerivedForMissing("staff_profiles", "user_id", before.users.map((u) => u.id), new Set(after.users.map((u) => u.id)));
  await syncDeletes(client, before.users, after.users, userSpec, "users");
  await syncDeletes(client, before.orders, after.orders, orderSpec, "orders");
  await syncDeletes(client, before.customers, after.customers, customerSpec, "customers");
  await syncDeletes(client, before.idempotency_records, after.idempotency_records, idempotencySpec, "idempotency_records");

  // -- Upsert pass: parents before children ----------------------------------
  await syncUpserts(client, before.users, after.users, userSpec, "users");
  await syncUpserts(client, before.roles, after.roles, roleSpec, "roles");
  await syncUpserts(client, before.user_roles, after.user_roles, userRoleSpec, "user_roles");
  await syncUpserts(client, before.sessions, after.sessions, sessionSpec, "sessions");
  await syncUpserts(client, before.customers, after.customers, customerSpec, "customers");
  await syncUpserts(client, before.uploaded_assets, after.uploaded_assets, assetSpec, "uploaded_assets");
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
  await syncUpserts(client, before.subscriptions, after.subscriptions, subscriptionSpec, "subscriptions");
  await syncUpserts(client, fb.periods, fa.periods, periodSpec, "subscription_periods");
  await syncUpserts(client, before.invoices, after.invoices, invoiceSpec, "invoices");
  await syncUpserts(client, fb.invoiceItems, fa.invoiceItems, invoiceItemSpec, "invoice_items");
  await syncUpserts(client, before.payment_providers, after.payment_providers, providerSpec, "payment_providers");
  await syncUpserts(client, before.payment_methods, after.payment_methods, methodSpec, "payment_methods");
  await syncUpserts(client, before.payment_submissions, after.payment_submissions, submissionSpec, "payment_submissions");
  await syncUpserts(client, before.payment_transactions, after.payment_transactions, transactionSpec, "payment_transactions");
  await syncUpserts(client, before.payment_verification_logs, after.payment_verification_logs, verificationLogSpec, "payment_verification_logs");
  await syncUpserts(client, before.licenses, after.licenses, licenseSpec, "licenses");
  await syncUpserts(client, fb.licenseSnapshots, fa.licenseSnapshots, licenseSnapshotSpec, "license_entitlement_snapshots");
  await syncUpserts(client, fb.licenseSnapshotItems, fa.licenseSnapshotItems, licenseSnapshotItemSpec, "license_entitlement_snapshot_items");
  await syncUpserts(client, fb.licenseActivations, fa.licenseActivations, licenseActivationSpec, "license_activations");
  await syncUpserts(client, before.tracking_configurations, after.tracking_configurations, trackingConfigSpec, "tracking_configurations");
  await syncUpserts(client, before.tracking_events, after.tracking_events, trackingEventSpec, "tracking_events");
  await syncUpserts(client, before.webhook_endpoints, after.webhook_endpoints, webhookEndpointSpec, "webhook_endpoints");
  await syncUpserts(client, before.webhook_deliveries, after.webhook_deliveries, webhookDeliverySpec, "webhook_deliveries");
  await syncUpserts(client, before.outbox_events, after.outbox_events, outboxSpec, "outbox_events");
  await syncUpserts(client, before.idempotency_records, after.idempotency_records, idempotencySpec, "idempotency_records");
  await syncUpserts(client, before.audit_logs, after.audit_logs, auditLogSpec, "audit_logs");

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
    const keys = ["customer", "order", "invoice", "subscription", "license"] as const;
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
