/**
 * Authentication + email configuration service (Auth + Email batch,
 * ADR-0008).
 *
 * DB-driven auth config: OAuth providers, the 2FA policy and the SMTP
 * settings all live in Postgres and are edited from Settings, so a save
 * takes effect without a redeploy. Tables are read with direct Drizzle
 * queries (the identity-service pattern — these tables are NOT in
 * store.state, exactly like the Better Auth `users`/`sessions`/
 * `accounts` tables).
 *
 * Secrets (OAuth client secrets, the SMTP password) are encrypted at
 * rest with AES-256-GCM under ENCRYPTION_KEY_V1 via `encryptSecretAtRest`
 * and are NEVER returned to clients — read endpoints expose only
 * `has_client_secret` / `has_password` flags. Audit entries record what
 * changed, never a secret value.
 *
 * Caching: the resolved config is cached module-level, keyed by a
 * caller-provided cache key (the Hyperdrive connection string in
 * production — the established Bug-B pattern). TTL 30s; a Settings save
 * invalidates the key in the isolate that served it, and other isolates
 * converge within the TTL. Tests use distinct DATABASE_URLs, so distinct
 * keys — no cross-test leakage.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import * as schema from "../../../../../db/schema/index.ts";
import { decryptSecretAtRest, encryptSecretAtRest } from "../../platform/crypto/index.ts";
import { AppError } from "../../shared/errors.ts";

export type TwoFactorMode = "off" | "optional" | "required";

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

/** The 8 roles seeded by migration 0001 — the only valid policy scopes besides `global`. */
export const KNOWN_ROLE_KEYS = [
  "super_admin",
  "admin",
  "finance_manager",
  "license_manager",
  "marketing_manager",
  "product_manager",
  "support_staff",
  "read_only",
] as const;

export const SMTP_TLS_MODES = ["starttls", "ssl", "none"] as const;
export type SmtpTlsMode = (typeof SMTP_TLS_MODES)[number];

export interface AuthConfigDeps {
  encryptionKey: string;
  keyVersion: string;
}

type Db = NodePgDatabase<typeof schema>;

export interface OAuthProviderView {
  provider: OAuthProviderId;
  enabled: boolean;
  client_id: string | null;
  has_client_secret: boolean;
  updated_at: string | null;
}

export interface ResolvedOAuthProvider {
  provider: OAuthProviderId;
  enabled: boolean;
  clientId: string | null;
  /** Decrypted secret — server-only, never serialized to a client. */
  clientSecret: string | null;
}

export interface TwoFactorPolicyDoc {
  global: TwoFactorMode;
  roles: Record<string, TwoFactorMode>;
}

export interface SmtpSettingsView {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  tls_mode: SmtpTlsMode;
  from_address: string;
  from_name: string;
  enabled: boolean;
  updated_at: string | null;
}

export interface ResolvedSmtpSettings extends SmtpSettingsView {
  /** Decrypted password — server-only, never serialized to a client. */
  password: string | null;
}

export interface ResolvedAuthConfig {
  oauth: ResolvedOAuthProvider[];
  twoFactorPolicy: TwoFactorPolicyDoc;
  smtp: ResolvedSmtpSettings;
}

const CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { config: ResolvedAuthConfig; at: number }>();

export function invalidateAuthConfigCache(cacheKey?: string): void {
  if (cacheKey === undefined) {
    configCache.clear();
    return;
  }
  configCache.delete(cacheKey);
}

function isOAuthProvider(value: unknown): value is OAuthProviderId {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

function isTwoFactorMode(value: unknown): value is TwoFactorMode {
  return value === "off" || value === "optional" || value === "required";
}

function isTlsMode(value: unknown): value is SmtpTlsMode {
  return typeof value === "string" && (SMTP_TLS_MODES as readonly string[]).includes(value);
}

async function loadOAuthProviders(db: Db, deps: AuthConfigDeps): Promise<ResolvedOAuthProvider[]> {
  const rows = await db.select().from(schema.authOAuthProviders);
  return OAUTH_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    let clientSecret: string | null = null;
    if (row?.clientSecretCiphertext) {
      try {
        clientSecret = decryptSecretAtRest(
          row.clientSecretCiphertext,
          deps.encryptionKey,
          `auth:oauth:${provider}`
        );
      } catch {
        // A corrupted/rotated ciphertext fails closed: the provider is
        // treated as unconfigured rather than crashing auth for everyone.
        clientSecret = null;
      }
    }
    return {
      provider,
      enabled: row?.enabled ?? false,
      clientId: row?.clientId ?? null,
      clientSecret,
    };
  });
}

async function loadTwoFactorPolicy(db: Db): Promise<TwoFactorPolicyDoc> {
  const rows = await db.select().from(schema.authTwoFactorPolicy);
  const doc: TwoFactorPolicyDoc = { global: "off", roles: {} };
  for (const row of rows) {
    if (!isTwoFactorMode(row.mode)) continue;
    if (row.scope === "global") doc.global = row.mode;
    else doc.roles[row.scope] = row.mode;
  }
  return doc;
}

export async function loadSmtpSettings(db: Db, deps: AuthConfigDeps): Promise<ResolvedSmtpSettings> {
  const rows = await db
    .select()
    .from(schema.smtpSettings)
    .where(eq(schema.smtpSettings.id, "default"))
    .limit(1);
  const row = rows[0];
  let password: string | null = null;
  if (row?.passwordCiphertext) {
    try {
      password = decryptSecretAtRest(row.passwordCiphertext, deps.encryptionKey, "auth:smtp");
    } catch {
      password = null;
    }
  }
  return {
    host: row?.host ?? "",
    port: row?.port ?? 587,
    username: row?.username ?? "",
    has_password: Boolean(row?.passwordCiphertext),
    password,
    tls_mode: isTlsMode(row?.tlsMode) ? row.tlsMode : "starttls",
    from_address: row?.fromAddress ?? "",
    from_name: row?.fromName ?? "StackMate",
    enabled: row?.enabled ?? false,
    updated_at: row?.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Load the whole resolved config (cached per cacheKey, 30s TTL).
 * Pass the Hyperdrive connection string as the cache key in production;
 * omit it (or pass a per-test key) in tests.
 */
export async function loadAuthConfig(
  db: Db,
  deps: AuthConfigDeps,
  cacheKey?: string
): Promise<ResolvedAuthConfig> {
  if (cacheKey !== undefined) {
    const hit = configCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.config;
  }
  const config: ResolvedAuthConfig = {
    oauth: await loadOAuthProviders(db, deps),
    twoFactorPolicy: await loadTwoFactorPolicy(db),
    smtp: await loadSmtpSettings(db, deps),
  };
  if (cacheKey !== undefined) configCache.set(cacheKey, { config, at: Date.now() });
  return config;
}

/** Safe (secret-free) views for the Settings UI. */
export function toOAuthProviderView(p: ResolvedOAuthProvider): OAuthProviderView {
  return {
    provider: p.provider,
    enabled: p.enabled,
    client_id: p.clientId,
    has_client_secret: p.clientSecret !== null,
    updated_at: null,
  };
}

/**
 * The full admin auth-config view (Auth + Email fix batch): the exact
 * snake_case shape the Settings → Authentication page reads
 * (`oauth[]`, `two_factor_policy`) and the Settings → Email page reads
 * (`smtp`). The GET endpoint used to
 * return the raw ResolvedAuthConfig — camelCase `twoFactorPolicy`
 * (which crashed the page: `config.two_factor_policy` was undefined)
 * and, worse, the DECRYPTED `clientSecret` / SMTP `password`. Always
 * serialize through this mapper; never return a Resolved* object to
 * a client.
 */
export interface AuthConfigView {
  oauth: OAuthProviderView[];
  two_factor_policy: TwoFactorPolicyDoc;
  smtp: SmtpSettingsView;
}

export function toAuthConfigView(config: ResolvedAuthConfig): AuthConfigView {
  return {
    oauth: config.oauth.map(toOAuthProviderView),
    two_factor_policy: config.twoFactorPolicy,
    smtp: toSmtpSettingsView(config.smtp),
  };
}

export function toSmtpSettingsView(s: ResolvedSmtpSettings): SmtpSettingsView {
  const { password: _password, ...view } = s;
  return view;
}

/**
 * Strictest-wins resolution across the global default and the user's
 * roles: required > optional > off. A role with no row inherits the
 * global mode; a missing global row means `off`.
 */
export function resolveTwoFactorModeForRoles(
  policy: TwoFactorPolicyDoc,
  roleKeys: string[]
): TwoFactorMode {
  const modes: TwoFactorMode[] = [policy.global];
  for (const key of roleKeys) {
    const mode = policy.roles[key];
    if (mode) modes.push(mode);
  }
  if (modes.includes("required")) return "required";
  if (modes.includes("optional")) return "optional";
  return "off";
}

export async function saveOAuthProvider(
  db: Db,
  deps: AuthConfigDeps,
  input: {
    provider: string;
    enabled: boolean;
    client_id?: string | null;
    client_secret?: string | null;
  },
  cacheKey?: string
): Promise<OAuthProviderView> {
  if (!isOAuthProvider(input.provider)) {
    throw new AppError("VALIDATION_ERROR", `Unknown OAuth provider '${input.provider}'.`, 422);
  }
  if (typeof input.enabled !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "enabled must be a boolean.", 422);
  }
  if (input.enabled && !input.client_id?.trim()) {
    throw new AppError(
      "VALIDATION_ERROR",
      "client_id is required to enable an OAuth provider.",
      422
    );
  }
  const existing = await db
    .select()
    .from(schema.authOAuthProviders)
    .where(eq(schema.authOAuthProviders.provider, input.provider))
    .limit(1);
  const row = existing[0];
  // A secret is required to enable when none is stored yet; omitting
  // client_secret keeps the stored one (the UI sends it only on change).
  if (input.enabled && !input.client_secret?.trim() && !row?.clientSecretCiphertext) {
    throw new AppError(
      "VALIDATION_ERROR",
      "client_secret is required to enable an OAuth provider.",
      422
    );
  }
  const now = new Date();
  const values: typeof schema.authOAuthProviders.$inferInsert = {
    id: row?.id ?? randomUUID(),
    provider: input.provider,
    enabled: input.enabled,
    clientId: input.client_id?.trim() ? input.client_id.trim() : (row?.clientId ?? null),
    clientSecretCiphertext:
      input.client_secret?.trim()
        ? encryptSecretAtRest(input.client_secret.trim(), deps.encryptionKey, deps.keyVersion, `auth:oauth:${input.provider}`)
        : (row?.clientSecretCiphertext ?? null),
    encryptionKeyVersion: deps.keyVersion,
    createdAt: row?.createdAt ?? now,
    updatedAt: now,
  };
  await db
    .insert(schema.authOAuthProviders)
    .values(values)
    .onConflictDoUpdate({
      target: schema.authOAuthProviders.provider,
      set: {
        enabled: values.enabled,
        clientId: values.clientId,
        clientSecretCiphertext: values.clientSecretCiphertext,
        encryptionKeyVersion: values.encryptionKeyVersion,
        updatedAt: now,
      },
    });
  invalidateAuthConfigCache(cacheKey);
  const resolved = (await loadOAuthProviders(db, deps)).find((p) => p.provider === input.provider)!;
  return { ...toOAuthProviderView(resolved), updated_at: now.toISOString() };
}

export async function saveTwoFactorPolicy(
  db: Db,
  input: { scope: string; mode: string },
  cacheKey?: string
): Promise<TwoFactorPolicyDoc> {
  if (!isTwoFactorMode(input.mode)) {
    throw new AppError("VALIDATION_ERROR", "mode must be off, optional, or required.", 422);
  }
  if (
    input.scope !== "global" &&
    !(KNOWN_ROLE_KEYS as readonly string[]).includes(input.scope)
  ) {
    throw new AppError("VALIDATION_ERROR", `Unknown policy scope '${input.scope}'.`, 422);
  }
  const existing = await db
    .select()
    .from(schema.authTwoFactorPolicy)
    .where(eq(schema.authTwoFactorPolicy.scope, input.scope))
    .limit(1);
  const row = existing[0];
  const now = new Date();
  await db
    .insert(schema.authTwoFactorPolicy)
    .values({
      id: row?.id ?? randomUUID(),
      scope: input.scope,
      mode: input.mode,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.authTwoFactorPolicy.scope,
      set: { mode: input.mode, updatedAt: now },
    });
  invalidateAuthConfigCache(cacheKey);
  return loadTwoFactorPolicy(db);
}

export async function saveSmtpSettings(
  db: Db,
  deps: AuthConfigDeps,
  input: {
    host?: string;
    port?: number;
    username?: string;
    password?: string | null;
    tls_mode?: string;
    from_address?: string;
    from_name?: string;
    enabled?: boolean;
  },
  cacheKey?: string
): Promise<SmtpSettingsView> {
  const existing = await db
    .select()
    .from(schema.smtpSettings)
    .where(eq(schema.smtpSettings.id, "default"))
    .limit(1);
  const row = existing[0];
  const host = (input.host ?? row?.host ?? "").trim();
  const port = input.port ?? row?.port ?? 587;
  const tlsMode = input.tls_mode ?? row?.tlsMode ?? "starttls";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError("VALIDATION_ERROR", "port must be an integer between 1 and 65535.", 422);
  }
  if (port === 25) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Port 25 is blocked by Cloudflare Workers. Use 465 for implicit TLS or 587 for STARTTLS.",
      422
    );
  }
  if (!isTlsMode(tlsMode)) {
    throw new AppError("VALIDATION_ERROR", "tls_mode must be starttls, ssl, or none.", 422);
  }
  const enabled = input.enabled ?? row?.enabled ?? false;
  const fromAddress = (input.from_address ?? row?.fromAddress ?? "").trim();
  if (enabled && !host) {
    throw new AppError("VALIDATION_ERROR", "host is required to enable SMTP.", 422);
  }
  if (enabled && !fromAddress) {
    throw new AppError("VALIDATION_ERROR", "from_address is required to enable SMTP.", 422);
  }
  if (fromAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) {
    throw new AppError("VALIDATION_ERROR", "from_address must be a valid email address.", 422);
  }
  // Length caps (audit follow-up): the smtp_settings columns are
  // unbounded `text`, so without caps an absurd value sailed past
  // validation into the DB/encryption layer and 500d instead of
  // 422ing. Caps sit at the real-world maxima: host is a DNS name
  // (≤253), username and from_address are email-shaped (≤254),
  // from_name is a display name (≤160), password is an app
  // password/token (≤512). Lengths are checked on the trimmed
  // values — the same values that get stored.
  const username = (input.username ?? row?.username ?? "").trim();
  const password = input.password?.trim() ?? "";
  const fromName = (input.from_name ?? row?.fromName ?? "StackMate").trim() || "StackMate";
  if (host.length > 253) {
    throw new AppError("VALIDATION_ERROR", "host must be at most 253 characters.", 422);
  }
  if (username.length > 254) {
    throw new AppError("VALIDATION_ERROR", "username must be at most 254 characters.", 422);
  }
  if (password.length > 512) {
    throw new AppError("VALIDATION_ERROR", "password must be at most 512 characters.", 422);
  }
  if (fromAddress.length > 254) {
    throw new AppError("VALIDATION_ERROR", "from_address must be at most 254 characters.", 422);
  }
  if (fromName.length > 160) {
    throw new AppError("VALIDATION_ERROR", "from_name must be at most 160 characters.", 422);
  }
  const now = new Date();
  await db
    .insert(schema.smtpSettings)
    .values({
      id: "default",
      host,
      port,
      username: (input.username ?? row?.username ?? "").trim(),
      passwordCiphertext:
        input.password?.trim()
          ? encryptSecretAtRest(input.password.trim(), deps.encryptionKey, deps.keyVersion, "auth:smtp")
          : (row?.passwordCiphertext ?? null),
      encryptionKeyVersion: deps.keyVersion,
      tlsMode,
      fromAddress,
      fromName: (input.from_name ?? row?.fromName ?? "StackMate").trim() || "StackMate",
      enabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.smtpSettings.id,
      set: {
        host,
        port,
        username: (input.username ?? row?.username ?? "").trim(),
        passwordCiphertext:
          input.password?.trim()
            ? encryptSecretAtRest(input.password.trim(), deps.encryptionKey, deps.keyVersion, "auth:smtp")
            : (row?.passwordCiphertext ?? null),
        encryptionKeyVersion: deps.keyVersion,
        tlsMode,
        fromAddress,
        fromName: (input.from_name ?? row?.fromName ?? "StackMate").trim() || "StackMate",
        enabled,
        updatedAt: now,
      },
    });
  invalidateAuthConfigCache(cacheKey);
  const resolved = await loadSmtpSettings(db, deps);
  return toSmtpSettingsView(resolved);
}

/** Whether the user has TOTP enabled (the plugin's `users.two_factor_enabled`). */
export async function getTwoFactorEnabled(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ twoFactorEnabled: schema.users.twoFactorEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows[0]?.twoFactorEnabled ?? false;
}

/**
 * Does the user have an ACTIVE staff record? Used by the Better Auth
 * databaseHooks (OAuth user/session creation). The staff record is the
 * `users` row (email) + `staff_profiles.status`.
 */
export async function findStaffRecordByEmail(
  db: Db,
  email: string
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: schema.users.id, status: schema.staffProfiles.status })
    .from(schema.users)
    .leftJoin(schema.staffProfiles, eq(schema.staffProfiles.userId, schema.users.id))
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, status: row.status ?? "active" };
}

export async function findStaffStatusByUserId(
  db: Db,
  userId: string
): Promise<string | null> {
  const rows = await db
    .select({ status: schema.staffProfiles.status })
    .from(schema.staffProfiles)
    .where(eq(schema.staffProfiles.userId, userId))
    .limit(1);
  return rows[0]?.status ?? null;
}
