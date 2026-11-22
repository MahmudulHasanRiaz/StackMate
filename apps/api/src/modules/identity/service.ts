import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashPassword as hashPasswordBetterAuth } from "better-auth/crypto";
import type * as schema from "../../../../../db/schema/index.ts";
import {
  accounts as baAccounts,
  sessions as baSessions,
  twoFactor as baTwoFactor,
  users as baUsers,
} from "../../../../../db/schema/auth.ts";
import { passwordResetTokens as baPasswordResetTokens } from "../../../../../db/schema/auth-config.ts";
import { SEED_PERMISSIONS } from "../../../../../db/seeds/seed-reference.ts";
import {
  AcceptStaffInvitationSchema,
  CreateRoleSchema,
  CreateStaffInvitationSchema,
  UpdateRoleSchema,
} from "../../../../../packages/contracts/src/index.ts";
import { randomOpaqueToken, sha256Hex } from "../../platform/crypto/index.ts";
import type {
  DatabaseState,
  RoleRecord,
  StaffInvitationRecord,
  StackMateDataStore,
  UserRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { resolveTwoFactorModeForRoles, type TwoFactorPolicyDoc } from "../auth-config/service.ts";
import type { createBetterAuth } from "./better-auth.ts";

/** A real Better Auth instance (see modules/identity/better-auth.ts). */
export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

/**
 * UNIFIED AUTHENTICATION (2026-11-15, Fix 2).
 *
 * Better Auth is the single authentication authority. Staff identity is a
 * Better Auth user (Drizzle `users` table) linked to the StackMate staff
 * record (`store.state.users`) by EMAIL, which is unique in both tables.
 * Roles, permissions and suspension state live ONLY in the StackMate staff
 * record; Better Auth knows nothing about roles. Every authenticated
 * request re-checks the staff record, so a suspended user fails validation
 * even with a live Better Auth session.
 *
 * Session validation has two entry points, both reading the SAME Better
 * Auth session record (Drizzle `sessions` table):
 *  1. Cookie — the browser's signed `better-auth.session_token` cookie is
 *     passed verbatim to `auth.api.getSession`, which verifies the
 *     signature and looks the session up server-side. (Better Auth 1.7.23
 *     has NO bearer-token session retrieval; its getSession reads only
 *     the signed cookie — verified against dist/api/routes/session.mjs.)
 *  2. Bearer / legacy `stackmate_session` cookie — the raw session token
 *     is looked up directly in the `sessions` table and checked for
 *     expiry. This is the same record the cookie path validates, not a
 *     second session system; it exists so API clients and the test suite
 *     can present the token returned by sign-in.
 *
 * TEST-ONLY SEAM (read this before claiming full unification): the
 * in-memory StackMateDataStore has no Postgres behind it, so Better Auth
 * cannot run against it. When a store has no `drizzleDb`, the functions
 * below fall back to the legacy in-memory session mechanism
 * (`signInStaffSessionTestAdapter` / `state.sessions` lookup). That path
 * is reachable ONLY in tests: production/staging wiring always builds a
 * DrizzleStore and fails closed without Hyperdrive, so no production
 * request can ever take the legacy branch. Do not remove the seam
 * without a Postgres-backed test adapter.
 *
 * PASSWORDS — TWO HASHES, ONE PASSWORD (read this before "simplifying"
 * anything): the StackMate staff record and the Better Auth identity are
 * the SAME `users` row (email UNIQUE), but the two systems hash passwords
 * differently and neither can verify the other's hash:
 *  - StackMate staff hash: `scrypt:<salt hex>:<derived hex>` (node
 *    scryptSync, r=8) in `users.password_hash` — verified by
 *    verifyPasswordScrypt below (test-adapter sign-in + lazy migration).
 *  - Better Auth hash: `<salt hex>:<derived hex>` (scrypt N=16384, r=16,
 *    p=1, dkLen=64, via `better-auth/crypto`) in the credential
 *    `accounts` row — verified by Better Auth's own signInEmail.
 * Provisioning therefore creates ONLY the credential `accounts` row for
 * the existing user id (never a second user row, never signUpEmail,
 * which would violate the email UNIQUE constraint). Both hashes are
 * (re)created from the plaintext password whenever it is set or
 * changed, so they stay in sync; the legacy hash is never used to
 * authorize a production request.
 *
 * PASSWORD POLICY (audit API L-22, accepted as-is 2026-11-19): length
 * only — every password in the product must be at least 10 characters
 * (bootstrap, staff creation, invite accept, reset, change-password).
 * No strength meter, no breach-list check, no character-class rules.
 * That is a deliberate, recorded decision, not an oversight: keep it
 * length-only until the owner asks for more. Do not "improve" this
 * silently in a fix batch.
 */
export function storeSupportsBetterAuth(store: StackMateDataStore): boolean {
  return (store as unknown as { drizzleDb?: unknown }).drizzleDb !== undefined;
}

function drizzleDbOf(store: StackMateDataStore): NodePgDatabase<typeof schema> {
  return (store as unknown as { drizzleDb: NodePgDatabase<typeof schema> }).drizzleDb;
}

async function reloadStateIfPossible(store: StackMateDataStore): Promise<void> {
  const maybe = store as unknown as { loadState?: () => Promise<unknown> };
  if (typeof maybe.loadState === "function") {
    await maybe.loadState();
  }
}

export interface StaffPrincipal {
  user: {
    id: string;
    name: string;
    email: string;
    status: "active" | "suspended";
    /**
     * Custom avatar (audit M-23): the R2 object key stored in
     * users.avatar_url, or null for Gravatar/initials. The shell
     * renders it through GET /api/v1/admin/me/avatar — a principal
     * without this field can never show the custom photo, no matter
     * what PATCH /me persisted (live bug 2026-11-22: picker toasted
     * success but Gravatar stayed after save + reload).
     */
    avatar_url: string | null;
  };
  session_id: string;
  roles: string[];
  permissions: string[];
  /** Whether TOTP is enabled for this user (the plugin's flag). */
  two_factor_enabled: boolean;
  /**
   * True when the 2FA policy REQUIRES two-factor for one of the user's
   * roles and the user has not enabled it yet. The session exists but
   * is RESTRICTED: the admin API returns 403 TWO_FACTOR_SETUP_REQUIRED
   * for every endpoint until setup completes (the /api/auth/* two-factor
   * endpoints stay open, so setup itself works). Computed at sign-in
   * AND on every session resolution, so a policy change or a completed
   * setup takes effect without re-login.
   */
  two_factor_setup_required: boolean;
}

export function hashPasswordScrypt(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPasswordScrypt(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hexDigest] = parts as [string, string, string];
  const expected = Buffer.from(hexDigest, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function resolveEffectivePermissions(state: DatabaseState, userId: string): {
  roles: string[];
  permissions: string[];
} {
  const assignedRoleIds = new Set(
    state.user_roles.filter((ur) => ur.user_id === userId).map((ur) => ur.role_id)
  );
  const roleKeys: string[] = [];
  const permSet = new Set<string>();
  for (const role of state.roles) {
    if (assignedRoleIds.has(role.id)) {
      roleKeys.push(role.key);
      for (const p of role.permission_keys) {
        permSet.add(p);
      }
    }
  }
  return {
    roles: roleKeys,
    permissions: Array.from(permSet).sort(),
  };
}

/**
 * Operator-controlled one-time Super Admin bootstrap (TAD §8.3, Security §4.1).
 * Cannot be invoked once a Super Admin already exists.
 */
export async function bootstrapInitialSuperAdmin(
  store: StackMateDataStore,
  input: { name: string; email: string; password: string; requestId: string }
): Promise<{ user: Omit<UserRecord, "password_hash">; roles: string[] }> {
  return store.withTransaction((state) => {
    const superAdminRole = state.roles.find((r) => r.key === "super_admin");
    if (!superAdminRole) {
      throw new AppError("INTERNAL_ERROR", "Built-in super_admin role is missing.", 500);
    }
    const existingSuperAdmin = state.user_roles.find((ur) => ur.role_id === superAdminRole.id);
    if (existingSuperAdmin) {
      throw new AppError(
        "CONFLICT",
        "Initial Super Admin has already been provisioned. Bootstrap is disabled.",
        409
      );
    }

    const emailNormalized = input.email.trim().toLowerCase();
    if (input.password.length < 10) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Super Admin password must be at least 10 characters.",
        422
      );
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      email: emailNormalized,
      email_verified: true,
      two_factor_enabled: false,
      password_hash: hashPasswordScrypt(input.password),
      status: "active",
      created_at: now,
      updated_at: now,
    };
    state.users.push(user);
    state.user_roles.push({
      user_id: user.id,
      role_id: superAdminRole.id,
      assigned_at: now,
    });

    appendAuditLog(state, {
      actor_type: "system",
      actor_user_id: user.id,
      action: "identity.super_admin.bootstrapped",
      resource_type: "user",
      resource_id: user.id,
      outcome: "success",
      request_id: input.requestId,
      changes: { email: user.email, role: "super_admin" },
    });

    const { password_hash: _, ...safeUser } = user;
    return { user: safeUser, roles: ["super_admin"] };
  });
}

/**
 * Read-only check used by GET /api/v1/setup-status: true once a
 * super_admin exists, false otherwise. Uses the SAME single source of
 * truth as bootstrapInitialSuperAdmin (a user_roles row for the
 * super_admin role), read inside withTransaction so the answer is fresh
 * (state is reloaded from the database inside the transaction). A missing
 * super_admin role means no super admin can exist yet, so setup is
 * required. This reveals exactly one bit and nothing else.
 */
export async function isSuperAdminProvisioned(store: StackMateDataStore): Promise<boolean> {
  return store.withTransaction((state) => {
    const superAdminRole = state.roles.find((r) => r.key === "super_admin");
    if (!superAdminRole) return false;
    return state.user_roles.some((ur) => ur.role_id === superAdminRole.id);
  });
}

/**
 * Defensive validation for admin-created staff (audit API H-4).
 *
 * The app.ts handler spreads the raw JSON body straight into
 * `createStaffUserByAdmin` with only a type cast, so this function
 * must never trust the runtime shapes: a missing field used to throw
 * `TypeError` (500), a 1-character password used to create a usable
 * account, and a malformed email was stored as-is. Every failure is a
 * 422 VALIDATION_ERROR, never a 500. The caps mirror the contracts
 * schemas used by the sibling flows (name 2–200, password 10–200,
 * `role_keys` an array of strings; unknown role keys are still
 * rejected by the lookup below).
 */
const STAFF_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCreateStaffUserInput(input: {
  name: unknown;
  email: unknown;
  password: unknown;
  role_keys: unknown;
}): { name: string; email: string; password: string; role_keys: string[] } {
  if (input === null || typeof input !== "object") {
    throw new AppError("VALIDATION_ERROR", "Staff user input must be an object.", 422);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 200) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Name must be between 2 and 200 characters.",
      422
    );
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > 254 || !STAFF_EMAIL_RE.test(email)) {
    throw new AppError("VALIDATION_ERROR", "A valid email address is required.", 422);
  }
  if (typeof input.password !== "string" || input.password.length < 10 || input.password.length > 200) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Password must be between 10 and 200 characters.",
      422
    );
  }
  if (!Array.isArray(input.role_keys) || input.role_keys.some((rk) => typeof rk !== "string" || rk.trim().length === 0)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "role_keys must be an array of role keys.",
      422
    );
  }
  return {
    name,
    email,
    password: input.password,
    role_keys: input.role_keys.map((rk) => (rk as string).trim()),
  };
}

export async function createStaffUserByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  input: {
    name: string;
    email: string;
    password: string;
    role_keys: string[];
    requestId: string;
  }
): Promise<{ user: Omit<UserRecord, "password_hash">; roles: string[] }> {
  await assertStaffPermissionAudited(store, actor, "users.manage", input.requestId);
  const valid = validateCreateStaffUserInput(input);
  return store.withTransaction((state) => {
    const emailNormalized = valid.email;
    if (state.users.some((u) => u.email === emailNormalized)) {
      throw new AppError("CONFLICT", `A staff user with email '${emailNormalized}' already exists.`, 409);
    }
    if (valid.role_keys.includes("super_admin") && !actor.roles.includes("super_admin")) {
      throw new AppError("FORBIDDEN", "Only a Super Admin can assign the super_admin role.", 403);
    }
    const matchedRoles = valid.role_keys.map((rk) => {
      const found = state.roles.find((r) => r.key === rk);
      if (!found) {
        throw new AppError("VALIDATION_ERROR", `Unknown role key '${rk}'.`, 422);
      }
      return found;
    });

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      name: valid.name,
      email: emailNormalized,
      email_verified: true,
      two_factor_enabled: false,
      password_hash: hashPasswordScrypt(valid.password),
      status: "active",
      created_at: now,
      updated_at: now,
    };
    state.users.push(user);
    for (const r of matchedRoles) {
      state.user_roles.push({
        user_id: user.id,
        role_id: r.id,
        assigned_at: now,
      });
    }

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.user.created",
      resource_type: "user",
      resource_id: user.id,
      outcome: "success",
      request_id: input.requestId,
      changes: { email: user.email, roles: valid.role_keys },
    });

    const { password_hash: _, ...safeUser } = user;
    return { user: safeUser, roles: valid.role_keys };
  });
}

/**
 * Provision (or confirm) the Better Auth identity for a staff member.
 * Server-side only — the public sign-up endpoint is blocked in app.ts.
 * Returns the Better Auth user id, or null when the identity already
 * exists. Throws on any other failure; callers that provision
 * best-effort (bootstrap / staff creation) catch and rely on lazy
 * migration at first sign-in instead.
 */
/**
 * Provision (or confirm) the Better Auth credential for a staff member
 * who already has a `users` row. Server-side only — the public sign-up
 * endpoint is blocked in app.ts, and signUpEmail must NEVER be used
 * here: it would insert a second `users` row and violate the email
 * UNIQUE constraint. Instead this inserts exactly one credential
 * `accounts` row (providerId 'credential') holding Better Auth's own
 * password hash for the existing user id. Idempotent: returns
 * `{ provisioned: false }` when the credential already exists.
 */
export async function ensureBetterAuthIdentity(
  store: StackMateDataStore,
  input: { userId: string; email: string; password: string }
): Promise<{ provisioned: boolean }> {
  if (await betterAuthCredentialExists(store, input.userId)) {
    return { provisioned: false };
  }
  const baHash = await hashPasswordBetterAuth(input.password);
  const now = new Date();
  await drizzleDbOf(store)
    .insert(baAccounts)
    .values({
      id: randomUUID(),
      // Better Auth's sign-in lookup requires accountId === user.id
      // (dist/api/routes/sign-in.mjs: credentialAccount matches
      // providerId 'credential' AND accountId === userRecord.user.id).
      // Using the email here silently breaks every sign-in.
      accountId: input.userId,
      providerId: "credential",
      userId: input.userId,
      password: baHash,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  // A concurrent provision may have won the race; re-check rather than
  // assuming this insert landed.
  return { provisioned: await betterAuthCredentialExists(store, input.userId) };
}

async function betterAuthCredentialExists(
  store: StackMateDataStore,
  userId: string
): Promise<boolean> {
  const rows = await drizzleDbOf(store)
    .select({ id: baAccounts.id })
    .from(baAccounts)
    .where(
      and(eq(baAccounts.userId, userId), eq(baAccounts.providerId, "credential"))
    )
    .limit(1);
  return rows.length > 0;
}

async function findBetterAuthSessionByToken(
  store: StackMateDataStore,
  token: string
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  const rows = await drizzleDbOf(store)
    .select({ id: baSessions.id, userId: baSessions.userId, expiresAt: baSessions.expiresAt })
    .from(baSessions)
    .where(eq(baSessions.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
}

async function findBetterAuthUserEmail(
  store: StackMateDataStore,
  userId: string
): Promise<string | null> {
  const rows = await drizzleDbOf(store)
    .select({ email: baUsers.email })
    .from(baUsers)
    .where(eq(baUsers.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

function buildPrincipal(state: DatabaseState, user: UserRecord): StaffPrincipal {
  const { roles, permissions } = resolveEffectivePermissions(state, user.id);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      avatar_url: user.avatar_url ?? null,
    },
    session_id: "",
    roles,
    permissions,
    two_factor_enabled: user.two_factor_enabled,
    two_factor_setup_required: resolveTwoFactorSetupRequired(state, user, roles),
  };
}

/**
 * 2FA setup requirement (Auth + Email batch, ADR-0008): required when
 * the policy (global default + the user's roles, strictest wins) says
 * `required` and the user has not enabled TOTP. The policy rows live in
 * store.state (loaded read-only in the combined state query), so this
 * is a pure function of already-loaded state — no extra query per
 * request. The in-memory store has no policy rows, so it reads `off`.
 */
export function resolveTwoFactorSetupRequired(
  state: DatabaseState,
  user: UserRecord,
  roleKeys: string[]
): boolean {
  if (user.two_factor_enabled) return false;
  const doc: TwoFactorPolicyDoc = {
    global: "off",
    roles: {},
  };
  for (const row of state.two_factor_policy ?? []) {
    if (row.mode !== "off" && row.mode !== "optional" && row.mode !== "required") continue;
    if (row.scope === "global") doc.global = row.mode;
    else doc.roles[row.scope] = row.mode;
  }
  return resolveTwoFactorModeForRoles(doc, roleKeys) === "required";
}

/**
 * Staff sign-in through Better Auth (production path) or the legacy
 * in-memory mechanism (test adapter only — see the module header).
 *
 * Better Auth flow: the staff record must already exist (bootstrap or
 * admin creation); the password is verified by Better Auth against its
 * own credential account. If no Better Auth identity exists yet for a
 * staff member (accounts created before unification, or eager
 * provisioning failed), the stored scrypt hash is verified once and the
 * identity is provisioned lazily — the same email is never duplicated,
 * and a wrong password never provisions anything.
 *
 * Returns the Better Auth session token, its expiry, the staff
 * principal, and the Set-Cookie values Better Auth issued (the signed
 * session cookie the browser must store). `set_cookie` is empty on the
 * test-adapter path, where app.ts sets the legacy cookie instead.
 */
export async function signInStaffSession(
  store: StackMateDataStore,
  input: {
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId: string;
  },
  auth?: BetterAuthInstance | null
): Promise<{
  session_token: string;
  expires_at: string;
  principal: StaffPrincipal;
  set_cookie: string[];
  /** True when the password was right but 2FA is on: no session exists
   * yet — the caller must show the TOTP prompt instead of signing in. */
  two_factor_redirect: boolean;
}> {
  if (auth && storeSupportsBetterAuth(store)) {
    return signInStaffSessionViaBetterAuth(store, input, auth);
  }
  return signInStaffSessionTestAdapter(store, input);
}

async function signInStaffSessionViaBetterAuth(
  store: StackMateDataStore,
  input: {
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId: string;
  },
  auth: BetterAuthInstance
): Promise<{
  session_token: string;
  expires_at: string;
  principal: StaffPrincipal;
  set_cookie: string[];
  two_factor_redirect: boolean;
}> {
  const emailNormalized = input.email.trim().toLowerCase();
  await reloadStateIfPossible(store);
  const user = store.state.users.find((u) => u.email === emailNormalized);
  const deny = async (reason: string): Promise<never> => {
    await store
      .withTransaction((state) => {
        appendAuditLog(state, {
          actor_type: "staff",
          actor_user_id: user?.id ?? null,
          action: "identity.auth.sign_in_failed",
          resource_type: "session",
          resource_id: emailNormalized,
          outcome: "denied",
          request_id: input.requestId,
          changes: { reason },
        });
      })
      .catch(() => {});
    throw new AppError("UNAUTHORIZED", "Invalid email or password.", 401);
  };
  if (!user) await deny("unknown_email");
  if (user!.status !== "active") {
    throw new AppError("FORBIDDEN", "Staff account is suspended.", 403);
  }

  // better-call's generated types do not expose the `asResponse` option
  // the runtime dispatch supports (dist/api/dispatch.mjs: `input.asResponse
  // ?? isRequestLike(...)`); the cast below is that documented runtime
  // behaviour, verified by the probe in better-auth-unified.test.ts.
  const callSignIn = () =>
    (auth.api.signInEmail as unknown as (opts: unknown) => Promise<unknown>)({
      body: { email: emailNormalized, password: input.password },
      headers: new Headers(),
      asResponse: true,
    });
  // NOTE: with `asResponse: true`, better-call RETURNS error responses
  // instead of throwing (dist/api/dispatch.mjs), so a failed sign-in
  // arrives here as a non-OK Response, not an exception. Both shapes
  // must funnel into the lazy-migration attempt below.
  let response = (await callSignIn().catch(() => null)) as Response | null;
  if (!response || !response.ok) {
    // No Better Auth credential yet? Migrate the legacy scrypt hash once.
    // A wrong password must never provision a credential.
    const hasCredential = await betterAuthCredentialExists(store, user!.id).catch(
      () => true
    );
    if (!hasCredential && verifyPasswordScrypt(input.password, user!.password_hash)) {
      await ensureBetterAuthIdentity(store, {
        userId: user!.id,
        email: emailNormalized,
        password: input.password,
      });
      response = (await callSignIn().catch(() => null)) as Response | null;
    }
    if (!response || !response.ok) {
      await deny(hasCredential ? "bad_password" : "bad_password_no_identity");
    }
  }
  const setCookie: string[] =
    typeof (response! as Response).headers.getSetCookie === "function"
      ? (response! as Response).headers.getSetCookie()
      : [];
  const body = (await response!.json()) as {
    token?: unknown;
    user?: { id?: unknown };
    twoFactorRedirect?: unknown;
  };
  // 2FA challenge (Auth + Email batch): the plugin deletes the session
  // it just created and returns { twoFactorRedirect: true } with NO
  // token. That is a successful password check, not an error — the
  // caller shows the TOTP prompt. The set_cookie array carries the
  // plugin's signed twoFactor verification cookie, which the browser
  // must store for /two-factor/verify-totp.
  if (body.twoFactorRedirect === true) {
    const principal = buildPrincipal(store.state, user!);
    await store
      .withTransaction((state) => {
        appendAuditLog(state, {
          actor_type: "staff",
          actor_user_id: user!.id,
          action: "identity.auth.sign_in_two_factor",
          resource_type: "session",
          resource_id: emailNormalized,
          outcome: "success",
          request_id: input.requestId,
        });
      })
      .catch(() => {});
    return {
      session_token: "",
      expires_at: "",
      principal,
      set_cookie: setCookie,
      two_factor_redirect: true,
    };
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    throw new AppError("INTERNAL_ERROR", "Better Auth sign-in returned no session token.", 500);
  }
  const sessionRow = await findBetterAuthSessionByToken(store, token).catch(() => null);
  const expiresAt = sessionRow
    ? sessionRow.expiresAt.toISOString()
    : new Date(Date.now() + 12 * 3600 * 1000).toISOString();

  const principal = buildPrincipal(store.state, user!);
  if (sessionRow) principal.session_id = sessionRow.id;
  await store.withTransaction((state) => {
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: user!.id,
      action: "identity.auth.signed_in",
      resource_type: "session",
      resource_id: token.slice(0, 12),
      outcome: "success",
      request_id: input.requestId,
    });
  });
  return {
    session_token: token,
    expires_at: expiresAt,
    principal,
    set_cookie: setCookie,
    two_factor_redirect: false,
  };
}

/**
 * TEST-ADAPTER-ONLY sign-in (in-memory store, no Postgres, no Better
 * Auth). Unreachable in production/staging wiring. Kept so the
 * in-memory e2e suite can run without a database.
 */
async function signInStaffSessionTestAdapter(
  store: StackMateDataStore,
  input: {
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId: string;
  }
): Promise<{
  session_token: string;
  expires_at: string;
  principal: StaffPrincipal;
  set_cookie: string[];
  two_factor_redirect: boolean;
}> {
  return store.withTransaction((state) => {
    const emailNormalized = input.email.trim().toLowerCase();
    const user = state.users.find((u) => u.email === emailNormalized);
    if (!user || !verifyPasswordScrypt(input.password, user.password_hash)) {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: user?.id ?? null,
        action: "identity.auth.sign_in_failed",
        resource_type: "session",
        resource_id: emailNormalized,
        outcome: "denied",
        request_id: input.requestId,
      });
      throw new AppError("UNAUTHORIZED", "Invalid email or password.", 401);
    }
    if (user.status !== "active") {
      throw new AppError("FORBIDDEN", "Staff account is suspended.", 403);
    }

    const sessionToken = `smsess_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    const sessionId = randomUUID();
    state.sessions.push({
      id: sessionId,
      token: sessionToken,
      user_id: user.id,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    });

    const principal = buildPrincipal(state, user);
    principal.session_id = sessionId;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: user.id,
      action: "identity.auth.signed_in",
      resource_type: "session",
      resource_id: sessionId,
      outcome: "success",
      request_id: input.requestId,
    });

    return {
      session_token: sessionToken,
      expires_at: expiresAt,
      principal,
      set_cookie: [],
      two_factor_redirect: false,
    };
  });
}

/**
 * Resolve the staff principal for one request from Better Auth state.
 * Cookie path: the signed `better-auth.session_token` cookie is validated
 * by Better Auth itself (`auth.api.getSession`). Bearer / legacy-cookie
 * path: the raw token is looked up in the Better Auth `sessions` table.
 * In both cases the staff record is re-read and must be `active` — a
 * suspended user fails here even with a live Better Auth session.
 * Returns null when there is no valid session. The test adapter (no
 * Better Auth) resolves against its in-memory `sessions` state instead.
 */
export async function resolveStaffPrincipal(
  store: StackMateDataStore,
  input: {
    auth?: BetterAuthInstance | null;
    cookieHeader?: string | null;
    bearerToken?: string | null;
    nowMs?: number;
  }
): Promise<StaffPrincipal | null> {
  const nowMs = input.nowMs ?? Date.now();
  const auth = input.auth ?? null;

  if (auth && storeSupportsBetterAuth(store) && input.cookieHeader) {
    const cookieName = "better-auth.session_token";
    if (input.cookieHeader.includes(`${cookieName}=`)) {
      try {
        const session = (await auth.api.getSession({
          headers: new Headers({ cookie: input.cookieHeader }),
        })) as { session?: { id?: string; expiresAt?: string | Date }; user?: { email?: string } } | null;
        if (session?.user?.email) {
          await reloadStateIfPossible(store);
          const user = store.state.users.find(
            (u) => u.email === session.user!.email!.trim().toLowerCase()
          );
          if (user && user.status === "active") {
            const principal = buildPrincipal(store.state, user);
            principal.session_id = session.session?.id ?? "";
            return principal;
          }
          return null;
        }
      } catch (err) {
        // Better Auth's getSession returns null for a missing/expired
        // session and throws UNAUTHORIZED (401) only when the session's
        // user is gone; anything else it throws is an infrastructure
        // failure (DB/Hyperdrive). Swallowing that as "no session"
        // turned every transient backend blip into a 401, and the SPA
        // rendered the sign-in screen — the owner perceived a sign-out
        // after reload and had to sign in again, though the session
        // was never dead (live bug 2026-11-22). Rethrow non-401 so the
        // dispatcher answers 500 and the SPA shows its retry state.
        if ((err as { status?: unknown } | null)?.status === 401) return null;
        throw err;
      }
    }
  }

  const rawToken = input.bearerToken?.trim() || extractStackmateSessionCookie(input.cookieHeader);
  if (!rawToken) return null;

  if (auth && storeSupportsBetterAuth(store)) {
    // Same rule as the cookie path above: a DB failure here must
    // propagate as a 500, never masquerade as "no session" (live bug
    // 2026-11-22). These lookups return null when the row is absent;
    // they only throw when the database itself fails.
    const row = await findBetterAuthSessionByToken(store, rawToken);
    if (!row || row.expiresAt.getTime() <= nowMs) return null;
    const email = await findBetterAuthUserEmail(store, row.userId);
    if (!email) return null;
    await reloadStateIfPossible(store);
    const user = store.state.users.find((u) => u.email === email.trim().toLowerCase());
    if (!user || user.status !== "active") return null;
    const principal = buildPrincipal(store.state, user);
    principal.session_id = row.id;
    return principal;
  }

  // Test adapter only (see module header).
  store.queryMetrics.uncachedQueries += 1;
  const session = store.state.sessions.find((s) => s.token === rawToken);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= nowMs) return null;
  const user = store.state.users.find((u) => u.id === session.user_id);
  if (!user || user.status !== "active") return null;
  const principal = buildPrincipal(store.state, user);
  principal.session_id = session.id;
  return principal;
}

// ---------------------------------------------------------------------------
// Better Auth fallback gate (audit API M-10).
//
// The /api/auth/* fallback in app.ts used to forward EVERY path it did
// not explicitly block to `auth.handler(request)`, and Better Auth's
// sessionMiddleware validates only the Better Auth session — it never
// calls `resolveStaffPrincipal`, never re-checks staff status, and
// never checks `two_factor_setup_required`. A suspended user with a
// still-live session, or a user under a `required` 2FA policy who had
// not set 2FA up, could therefore call `POST /api/auth/update-user`,
// `GET /api/auth/list-sessions`, `POST /api/auth/revoke-session(s)`
// and the /two-factor/* management endpoints — contradicting the
// "restricted session cannot use anything except /me + 2FA setup"
// claim. The dispatcher must call `checkBetterAuthFallbackAccess`
// before `auth.handler(request)` (see the wiring note in app.ts);
// this helper is the gate itself, so the rules live in one place and
// are unit-testable without the dispatcher.
// ---------------------------------------------------------------------------

/**
 * Fallback paths that need NO staff session — the auth flow itself.
 * The two-factor verify endpoints run on the plugin's twoFactor
 * verification cookie + code (there is no session yet at sign-in
 * time); the OAuth entry/callback are gated by the databaseHooks in
 * better-auth.ts (user.create.before always false, session.create
 * .before rejects suspended staff).
 */
const BETTER_AUTH_FALLBACK_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/sign-in/social",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/verify-otp",
  // Better Auth's built-in health endpoint ({ ok: true }, no session,
  // no user data, no state change). The M-10 gate as written 404'd it
  // because it is in neither the public nor the session set — see
  // better-auth-smoke.test.ts ("GET /api/auth/ok returns a real
  // Better Auth { ok: true } response").
  "/api/auth/ok",
]);

/**
 * Fallback paths that need a live, active staff session. Anything NOT
 * in this set and NOT public is denied with 404 — including the raw
 * Better Auth `/change-password` route (the app's own
 * POST /api/auth/change-password handler is the only password-change
 * path), `/delete-user`, and `/change-email` (both disabled).
 */
const BETTER_AUTH_FALLBACK_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/list-sessions",
  "/api/auth/revoke-session",
  "/api/auth/revoke-sessions",
  "/api/auth/revoke-other-sessions",
  "/api/auth/update-user",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/get-totp-uri",
  "/api/auth/two-factor/generate-backup-codes",
  "/api/auth/two-factor/send-otp",
]);

/**
 * Session paths a 2FA-setup-restricted principal may still use: the
 * setup flow itself, plus get-session (the SPA needs the principal to
 * render the forced-setup wizard — same exception as
 * GET /api/v1/admin/me in the admin block).
 */
const BETTER_AUTH_FALLBACK_SETUP_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/get-totp-uri",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/verify-otp",
  "/api/auth/two-factor/generate-backup-codes",
]);

function normalizeAuthFallbackPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Gate for the /api/auth/* fallback. Returns the resolved principal
 * for session paths (null for public paths). Throws 404 for any path
 * that is neither public nor a known session path, 401 when a session
 * path has no valid session, and 403 TWO_FACTOR_SETUP_REQUIRED when a
 * setup-restricted principal calls a non-setup session path — the same
 * code and message as the /api/v1/admin block in app.ts.
 */
export async function checkBetterAuthFallbackAccess(
  store: StackMateDataStore,
  input: {
    auth?: BetterAuthInstance | null;
    cookieHeader?: string | null;
    bearerToken?: string | null;
    pathname: string;
  }
): Promise<{ principal: StaffPrincipal | null }> {
  const pathname = normalizeAuthFallbackPath(input.pathname);
  if (
    BETTER_AUTH_FALLBACK_PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/api/auth/callback/")
  ) {
    return { principal: null };
  }
  if (!BETTER_AUTH_FALLBACK_SESSION_PATHS.has(pathname)) {
    throw new AppError("NOT_FOUND", "Auth endpoint not found.", 404);
  }
  const principal = await resolveStaffPrincipal(store, {
    auth: input.auth ?? null,
    cookieHeader: input.cookieHeader ?? null,
    bearerToken: input.bearerToken ?? null,
  });
  if (!principal) {
    throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
  }
  if (
    principal.two_factor_setup_required &&
    !BETTER_AUTH_FALLBACK_SETUP_PATHS.has(pathname)
  ) {
    throw new AppError(
      "TWO_FACTOR_SETUP_REQUIRED",
      "Two-factor authentication setup is required for your role. Complete setup to continue.",
      403
    );
  }
  return { principal };
}

function extractStackmateSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === "stackmate_session" || rawName === "__Host-stackmate_session") {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

/**
 * Sign out: revoke the Better Auth session behind the presented cookie
 * (via Better Auth's own sign-out, which also clears the cookie) and/or
 * the bearer/legacy token (by deleting its session row — for a
 * DrizzleStore the row is mirrored in `state.sessions`, so the same
 * withTransaction filter that used to revoke legacy sessions revokes
 * Better Auth sessions too). Returns Set-Cookie values to forward.
 */
export async function signOutStaffSession(
  store: StackMateDataStore,
  input: {
    auth?: BetterAuthInstance | null;
    cookieHeader?: string | null;
    bearerToken?: string | null;
  }
): Promise<{ signed_out: true; set_cookie: string[] }> {
  const auth = input.auth ?? null;
  let setCookie: string[] = [];
  if (auth && storeSupportsBetterAuth(store) && input.cookieHeader?.includes("better-auth.session_token=")) {
    try {
      const res = (await (auth.api.signOut as unknown as (opts: unknown) => Promise<unknown>)({
        headers: new Headers({ cookie: input.cookieHeader }),
        asResponse: true,
      })) as Response;
      if (res instanceof Response && typeof res.headers.getSetCookie === "function") {
        setCookie = res.headers.getSetCookie();
      }
    } catch {
      // Fall through to the row delete below; a missing session is not an error.
    }
  }
  const rawToken = input.bearerToken?.trim() || extractStackmateSessionCookie(input.cookieHeader);
  if (rawToken) {
    await store.withTransaction((state) => {
      state.sessions = state.sessions.filter((s) => s.token !== rawToken);
    });
  }
  return { signed_out: true, set_cookie: setCookie };
}

/**
 * Change the signed-in staff member's password through Better Auth and
 * revoke all OTHER sessions (Better Auth `revokeOtherSessions`). The
 * current session stays valid. On the test adapter (no Better Auth) the
 * stored scrypt hash is rotated and other legacy sessions are revoked.
 */
export async function changeStaffPassword(
  store: StackMateDataStore,
  principal: StaffPrincipal,
  input: {
    auth?: BetterAuthInstance | null;
    cookieHeader?: string | null;
    currentPassword: string;
    newPassword: string;
    requestId: string;
  }
): Promise<{ changed: true; revoked_other_sessions: number | null }> {
  if (input.newPassword.length < 10) {
    throw new AppError("VALIDATION_ERROR", "New password must be at least 10 characters.", 422);
  }
  const auth = input.auth ?? null;
  if (auth && storeSupportsBetterAuth(store)) {
    // Without `asResponse`, better-call THROWS Better Auth's APIError on
    // a wrong current password; map it to the StackMate 401 instead of
    // letting it surface as a 500. ONLY the password check lives in
    // this try (audit M-13): revocation has its own try below, because
    // a revocation failure after a successful change must never be
    // reported as "wrong password" — the password was already changed
    // by then, and the other sessions would silently stay valid.
    try {
      const res = (await (auth.api.changePassword as unknown as (opts: unknown) => Promise<unknown>)({
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          // Do NOT pass revokeOtherSessions: true here. Verified against
          // the installed better-auth 1.7.23 source
          // (dist/api/routes/update-user.mjs): with that flag the endpoint
          // calls deleteUserSessions(userId), which deletes ALL sessions
          // INCLUDING the one making the request. Revoking only the other
          // sessions is done by the dedicated endpoint below.
          revokeOtherSessions: false,
        },
        headers: new Headers({ cookie: input.cookieHeader ?? "" }),
      })) as { user?: unknown };
      if (!res || typeof res !== "object") {
        throw new AppError("UNAUTHORIZED", "Current password is incorrect.", 401);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UNAUTHORIZED", "Current password is incorrect.", 401);
    }
    // Keep the legacy staff hash in sync: Better Auth updated only its
    // own credential hash above. The staff hash is never used to
    // authorize a production request, but leaving the old password
    // verifiable anywhere would be a landmine.
    await store.withTransaction((state) => {
      const user = state.users.find((u) => u.id === principal.user.id);
      if (user) {
        user.password_hash = hashPasswordScrypt(input.newPassword);
        user.updated_at = new Date().toISOString();
      }
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "identity.auth.password_changed",
        resource_type: "user",
        resource_id: principal.user.id,
        outcome: "success",
        request_id: input.requestId,
      });
    });
    // Revoke every session except the one that made this request
    // (dist/api/routes/session.mjs: revokeOtherSessions filters out
    // ctx.context.session.session.token). Identified via the same
    // signed session cookie. A failure here is a distinct 500: the
    // password IS changed (and audited above), but the other sessions
    // are still live — the caller must know, and must not be told
    // their current password was wrong.
    try {
      await (auth.api.revokeOtherSessions as unknown as (opts: unknown) => Promise<unknown>)({
        headers: new Headers({ cookie: input.cookieHeader ?? "" }),
      });
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "Password was changed, but other sessions could not be revoked. Sign out of your other devices manually.",
        500
      );
    }
    // Better Auth's change-password endpoint does not report how many
    // sessions it revoked, so the count is honestly null here (the
    // revocation itself is verified by the unified-auth test: the other
    // session stops working). The test-adapter branch below returns a
    // real count.
    return { changed: true, revoked_other_sessions: null };
  }
  // Test adapter only (see module header).
  return store.withTransaction((state) => {
    const user = state.users.find((u) => u.id === principal.user.id);
    if (!user) throw new AppError("NOT_FOUND", "Staff user not found.", 404);
    if (!verifyPasswordScrypt(input.currentPassword, user.password_hash)) {
      throw new AppError("UNAUTHORIZED", "Current password is incorrect.", 401);
    }
    user.password_hash = hashPasswordScrypt(input.newPassword);
    user.updated_at = new Date().toISOString();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter(
      (s) => s.user_id !== user.id || s.id === principal.session_id
    );
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: user.id,
      action: "identity.auth.password_changed",
      resource_type: "user",
      resource_id: user.id,
      outcome: "success",
      request_id: input.requestId,
    });
    return { changed: true as const, revoked_other_sessions: before - state.sessions.length };
  });
}

/**
 * Update the signed-in staff member's OWN display name (account menu).
 *
 * Why this exists instead of Better Auth's POST /api/auth/update-user:
 * update-user DOES work through the mounted instance (verified by
 * better-auth-unified.test.ts — it updates the shared `users.name` row
 * and GET /me reflects it), but it returns Better Auth's raw response
 * shape (not the StackMate envelope the SPA client parses) and writes
 * NO StackMate audit log entry. A profile change is a consequential
 * identity change, so it goes through this endpoint: StackMate
 * envelope, audit-logged (`identity.profile.name_updated`), and the
 * updated principal is returned so the SPA can refresh in place.
 *
 * Only `name` is accepted. `email` is the login identity and is changed
 * by an administrator only; `roles` are never self-editable. Extra
 * fields in the body are ignored, never applied.
 */
export async function updateOwnProfile(
  store: StackMateDataStore,
  principal: StaffPrincipal,
  input: { name: unknown; requestId: string }
): Promise<StaffPrincipal> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Name must be between 1 and 120 characters.",
      422
    );
  }
  const now = new Date().toISOString();
  await store.withTransaction((state) => {
    const user = state.users.find((u) => u.id === principal.user.id);
    if (!user) throw new AppError("NOT_FOUND", "Staff user not found.", 404);
    const previousName = user.name;
    user.name = name;
    user.updated_at = now;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: principal.user.id,
      action: "identity.profile.name_updated",
      resource_type: "user",
      resource_id: principal.user.id,
      outcome: "success",
      request_id: input.requestId,
      changes: { previous_name: previousName, name },
    });
  });
  // The staff record IS the Better Auth `users` row (same table, same
  // id), so this one update keeps both in sync — no separate BA call.
  // withTransaction already mutated the live in-memory state, so the
  // principal below reads the new name with no reload.
  const user = store.state.users.find((u) => u.id === principal.user.id);
  if (!user) throw new AppError("NOT_FOUND", "Staff user not found.", 404);
  return buildPrincipal(store.state, user);
}

export async function updateStaffUserRoles(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  targetUserId: string,
  roleKeys: string[],
  requestId: string
): Promise<{ user_id: string; roles: string[]; revoked_sessions: number }> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  // Same class as H-4: the app.ts handler passes `body.role_keys ?? []`
  // with no array check, so a string here used to throw TypeError (500)
  // inside the transaction. Reject it as 422 instead.
  if (!Array.isArray(roleKeys) || roleKeys.some((rk) => typeof rk !== "string")) {
    throw new AppError("VALIDATION_ERROR", "role_keys must be an array of role keys.", 422);
  }
  return store.withTransaction((state) => {
    const user = state.users.find((u) => u.id === targetUserId);
    if (!user) {
      throw new AppError("NOT_FOUND", "Target staff user not found.", 404);
    }
    if (roleKeys.includes("super_admin") && !actor.roles.includes("super_admin")) {
      throw new AppError("FORBIDDEN", "Only a Super Admin may grant the super_admin role.", 403);
    }
    const targetRoles = roleKeys.map((rk) => {
      const r = state.roles.find((role) => role.key === rk);
      if (!r) throw new AppError("VALIDATION_ERROR", `Role '${rk}' does not exist.`, 422);
      return r;
    });

    state.user_roles = state.user_roles.filter((ur) => ur.user_id !== targetUserId);
    const now = new Date().toISOString();
    for (const r of targetRoles) {
      state.user_roles.push({
        user_id: targetUserId,
        role_id: r.id,
        assigned_at: now,
      });
    }

    // Security & Threat Model §4.1: Revoke active sessions immediately after role changes.
    // This also revokes Better Auth sessions: for a DrizzleStore,
    // `state.sessions` mirrors the Better Auth `sessions` table, so
    // removing a row here deletes the row via diff-persist and the
    // session stops validating on the next request (verified by
    // better-auth-unified.test.ts).
    const beforeCount = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.user_id !== targetUserId);
    const revokedCount = beforeCount - state.sessions.length;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.user.roles_updated",
      resource_type: "user",
      resource_id: targetUserId,
      outcome: "success",
      request_id: requestId,
      changes: { roles: roleKeys, revoked_sessions: revokedCount },
    });

    return { user_id: targetUserId, roles: roleKeys, revoked_sessions: revokedCount };
  });
}

// ---------------------------------------------------------------------------
// Staff suspension (audit API H-3).
//
// Until this batch there was NO way to suspend a staff member: the
// suspension checks in sign-in, session validation, and the OAuth
// session.create.before hook were all correct, but nothing ever wrote
// `status: "suspended"` — the only escape was a direct DB edit, and
// stripping all roles still left a valid (role-less) session behind.
// These two functions are the product path. The core agent wires the
// route (PATCH /api/v1/admin/users/:userId/status, gated on
// users.manage); the sections agent adds the UI.
// ---------------------------------------------------------------------------

export async function suspendStaffUser(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  targetUserId: string,
  requestId: string
): Promise<{ user_id: string; status: "suspended"; revoked_sessions: number }> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  if (actor.user.id === targetUserId) {
    throw new AppError(
      "CONFLICT",
      "You cannot suspend your own account. Ask another administrator.",
      409
    );
  }
  return store.withTransaction((state) => {
    const user = state.users.find((u) => u.id === targetUserId);
    if (!user) {
      throw new AppError("NOT_FOUND", "Target staff user not found.", 404);
    }
    if (user.status === "suspended") {
      throw new AppError("CONFLICT", "Staff user is already suspended.", 409);
    }
    const previousStatus = user.status;
    user.status = "suspended";
    user.updated_at = new Date().toISOString();

    // Revoke every session immediately: for a DrizzleStore,
    // `state.sessions` mirrors the Better Auth `sessions` table, so
    // removing a row here deletes the row via diff-persist and the
    // session stops validating on the next request (same mechanism as
    // updateStaffUserRoles, verified by better-auth-unified.test.ts).
    const beforeCount = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.user_id !== targetUserId);
    const revokedCount = beforeCount - state.sessions.length;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.user.suspended",
      resource_type: "user",
      resource_id: targetUserId,
      outcome: "success",
      request_id: requestId,
      changes: { previous_status: previousStatus, status: "suspended", revoked_sessions: revokedCount },
    });

    return { user_id: targetUserId, status: "suspended" as const, revoked_sessions: revokedCount };
  });
}

export async function unsuspendStaffUser(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  targetUserId: string,
  requestId: string
): Promise<{ user_id: string; status: "active" }> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  return store.withTransaction((state) => {
    const user = state.users.find((u) => u.id === targetUserId);
    if (!user) {
      throw new AppError("NOT_FOUND", "Target staff user not found.", 404);
    }
    if (user.status === "active") {
      throw new AppError("CONFLICT", "Staff user is already active.", 409);
    }
    const previousStatus = user.status;
    user.status = "active";
    user.updated_at = new Date().toISOString();
    // No session revocation here: suspend already revoked every
    // session, so there is nothing live to kill — the user signs in
    // fresh and gets a new session.
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.user.unsuspended",
      resource_type: "user",
      resource_id: targetUserId,
      outcome: "success",
      request_id: requestId,
      changes: { previous_status: previousStatus, status: "active" },
    });
    return { user_id: targetUserId, status: "active" as const };
  });
}

export function assertStaffPermission(
  principal: StaffPrincipal | null,
  requiredPermission: string
): asserts principal is StaffPrincipal {
  if (!principal) {
    throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
  }
  if (
    !principal.roles.includes("super_admin") &&
    !principal.permissions.includes(requiredPermission)
  ) {
    throw new AppError(
      "FORBIDDEN",
      `Missing required permission: '${requiredPermission}'.`,
      403
    );
  }
}

/**
 * Permission-denial audit (audit API M-14, item (h)).
 *
 * `assertStaffPermission` throws on denial but leaves no trace, so
 * permission-probing was invisible in the audit log. Service
 * functions that take a store + requestId use this variant instead:
 * on a 403 (an authenticated staff member lacking the permission) a
 * best-effort `identity.auth.permission_denied` row is written before
 * the error is rethrown. A 401 (no principal at all) has no actor to
 * attribute, so it is not logged here — the dispatcher logs
 * unauthenticated requests at its own layer. The audit write never
 * masks the original error.
 */
export async function assertStaffPermissionAudited(
  store: StackMateDataStore,
  principal: StaffPrincipal | null,
  requiredPermission: string,
  requestId: string
): Promise<void> {
  try {
    assertStaffPermission(principal, requiredPermission);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403 && principal) {
      await store
        .withTransaction((state) => {
          appendAuditLog(state, {
            actor_type: "staff",
            actor_user_id: principal.user.id,
            action: "identity.auth.permission_denied",
            resource_type: "permission",
            resource_id: requiredPermission,
            outcome: "denied",
            request_id: requestId,
            changes: { permission: requiredPermission },
          });
        })
        .catch(() => {});
    }
    throw error;
  }
}

/**
 * Audit helper for two-factor enable/disable (audit API M-14).
 *
 * TOTP enable/disable runs inside Better Auth's own handler (the
 * /api/auth/* fallback in app.ts), so no identity-service function
 * sees the mutation. The dispatcher must call this helper after a
 * successful enable/disable response and pass the resolved principal:
 * without it, a consequential security change (2FA on/off) leaves no
 * audit row. See the wiring note in app.ts (M-10 fallback gate).
 */
export async function recordTwoFactorStateChange(
  store: StackMateDataStore,
  input: { userId: string; enabled: boolean; requestId: string }
): Promise<void> {
  await store
    .withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: input.userId,
        action: input.enabled
          ? "identity.auth.two_factor_enabled"
          : "identity.auth.two_factor_disabled",
        resource_type: "user",
        resource_id: input.userId,
        outcome: "success",
        request_id: input.requestId,
      });
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Roles (API Spec §8) — custom roles. The spec names permissions
// users.invite / roles.create / roles.update, but the seeded permission
// catalogue (db/seeds/seed-reference.ts) has no such keys; the existing
// users.manage permission ("Manage staff users, roles, and permissions")
// is the equivalent gate and is used for all role + invitation writes.
// ---------------------------------------------------------------------------

function validatePermissionAllowlist(permissionKeys: string[]): void {
  // Media permissions (audit API H-2, code part): the seed catalogue
  // does not list media.view/media.manage yet — the DB agent adds them
  // to SEED_PERMISSIONS (and migration 0012 already grants them in the
  // DB-backed store) — but the allowlist is seed-based, so until the
  // seed lands no custom role could ever be granted media access (the
  // validator 422'd the keys). Accept the two keys explicitly here:
  // they are real, spec'd permissions (API spec §18.13), and the
  // DB-backed store already grants them, so accepting them cannot
  // over-grant. Remove this carve-out once the seed carries them.
  const known: Set<string> = new Set([
    ...SEED_PERMISSIONS.map((p) => p.key),
    "media.view",
    "media.manage",
  ]);
  for (const key of permissionKeys) {
    if (!known.has(key)) {
      throw new AppError("VALIDATION_ERROR", `Unknown permission key '${key}'.`, 422);
    }
  }
}

export async function createRoleByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<RoleRecord> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  const input = CreateRoleSchema.parse(rawInput);
  if (input.key === "super_admin") {
    throw new AppError("CONFLICT", "Role key 'super_admin' is reserved.", 409);
  }
  if (input.permissions.includes("users.manage") && !actor.roles.includes("super_admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only a Super Admin can create a role with the users.manage permission.",
      403
    );
  }
  validatePermissionAllowlist(input.permissions);
  return store.withTransaction((state) => {
    if (state.roles.some((r) => r.key === input.key)) {
      throw new AppError("CONFLICT", `Role key '${input.key}' already exists.`, 409);
    }
    const role: RoleRecord = {
      id: randomUUID(),
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      is_system: false,
      permission_keys: [...input.permissions],
      created_at: new Date().toISOString(),
    };
    state.roles.push(role);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.role.created",
      resource_type: "role",
      resource_id: role.id,
      outcome: "success",
      request_id: requestId,
      changes: { key: role.key, permissions: role.permission_keys },
    });
    return role;
  });
}

export async function updateRoleByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  roleId: string,
  rawInput: unknown,
  requestId: string
): Promise<RoleRecord> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  const input = UpdateRoleSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const role = state.roles.find((r) => r.id === roleId);
    if (!role) throw new AppError("NOT_FOUND", "Role not found.", 404);
    if (role.key === "super_admin") {
      throw new AppError("FORBIDDEN", "The super_admin role cannot be modified.", 403);
    }
    if (input.permissions !== undefined) {
      if (role.is_system) {
        throw new AppError(
          "CONFLICT",
          "System role permissions cannot be changed. Create a custom role instead.",
          409
        );
      }
      if (input.permissions.includes("users.manage") && !actor.roles.includes("super_admin")) {
        throw new AppError(
          "FORBIDDEN",
          "Only a Super Admin can grant the users.manage permission.",
          403
        );
      }
      validatePermissionAllowlist(input.permissions);
      role.permission_keys = [...input.permissions];
    }
    if (input.name !== undefined) role.name = input.name;
    if (input.description !== undefined) role.description = input.description ?? "";
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.role.updated",
      resource_type: "role",
      resource_id: role.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return role;
  });
}

// ---------------------------------------------------------------------------
// Staff invitations (API Spec §8, Batch 1). The invitation token is
// returned ONCE to the creating admin AND, when SMTP is configured,
// emailed to the invitee by the app.ts handler (best-effort, honest
// `email_sent` / `email_error` in the response — see
// POST /api/v1/admin/users/invitations). The token is the fallback
// delivery path when email is not configured, not the only one. Only
// the SHA-256 hash is stored.
// (Audit API M-21: the old comment here claimed no email is sent.
// That was true before the Auth + Email batch; it is false now. The
// matching stale comments in app.ts and the SPA dialog copy are
// outside this module — see the fix-batch report.)
// ---------------------------------------------------------------------------

export const STAFF_INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Fail-closed persistence check for staff_invitations. The DrizzleStore
 * load/sync wiring for the new table lives in
 * batch1-invitations-drizzle-wiring.patch (NOT applied yet — it touches
 * drizzle-store.ts, owned by the in-flight perf fix). Until it lands, a
 * DrizzleStore would silently drop invitation rows (persistStateDiff only
 * syncs tables it has a spec for), so invitation writes 503 instead of
 * returning 201 for data that would vanish on the next reload. The
 * in-memory base store persists in its own state, so it reports true.
 */
export function storePersistsStaffInvitations(store: StackMateDataStore): boolean {
  const probe = store as unknown as {
    drizzleDb?: unknown;
    supportsStaffInvitations?: boolean;
  };
  if (probe.supportsStaffInvitations === true) return true;
  if (probe.drizzleDb !== undefined) return false;
  return true;
}

function assertInvitationPersistence(store: StackMateDataStore): void {
  if (!storePersistsStaffInvitations(store)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Staff invitations are unavailable until the Batch 1 DrizzleStore wiring for staff_invitations is applied (see batch1-invitations-drizzle-wiring.patch).",
      503
    );
  }
}

function stripInvitationToken(
  invitation: StaffInvitationRecord
): Omit<StaffInvitationRecord, "token_hash"> {
  const { token_hash: _h, ...safe } = invitation;
  return safe;
}

export async function createStaffInvitationByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<{
  invitation: Omit<StaffInvitationRecord, "token_hash">;
  token_once: string;
}> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  assertInvitationPersistence(store);
  const input = CreateStaffInvitationSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const email = input.email.trim().toLowerCase();
    if (state.users.some((u) => u.email === email)) {
      throw new AppError(
        "CONFLICT",
        `A staff user with email '${email}' already exists.`,
        409
      );
    }
    if (
      (state.staff_invitations ?? []).some((i) => i.email === email && i.status === "pending")
    ) {
      throw new AppError(
        "CONFLICT",
        `A pending invitation for '${email}' already exists. Revoke it before inviting again.`,
        409
      );
    }
    if (input.role_keys.includes("super_admin") && !actor.roles.includes("super_admin")) {
      throw new AppError(
        "FORBIDDEN",
        "Only a Super Admin can invite someone as super_admin.",
        403
      );
    }
    for (const rk of input.role_keys) {
      if (!state.roles.some((r) => r.key === rk)) {
        throw new AppError("VALIDATION_ERROR", `Unknown role key '${rk}'.`, 422);
      }
    }

    const rawToken = randomOpaqueToken("inv", 32);
    const now = new Date();
    const invitation: StaffInvitationRecord = {
      id: randomUUID(),
      email,
      name: input.name.trim(),
      role_keys: [...input.role_keys],
      token_hash: sha256Hex(rawToken),
      status: "pending",
      expires_at: new Date(now.getTime() + STAFF_INVITATION_TTL_MS).toISOString(),
      invited_by_user_id: actor.user.id,
      accepted_user_id: null,
      accepted_at: null,
      revoked_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    (state.staff_invitations ??= []).push(invitation);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.invitation.created",
      resource_type: "staff_invitation",
      resource_id: invitation.id,
      outcome: "success",
      request_id: requestId,
      changes: { email: invitation.email, roles: invitation.role_keys },
    });
    return { invitation: stripInvitationToken(invitation), token_once: rawToken };
  });
}

export async function revokeStaffInvitationByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  invitationId: string,
  requestId: string
): Promise<Omit<StaffInvitationRecord, "token_hash">> {
  await assertStaffPermissionAudited(store, actor, "users.manage", requestId);
  assertInvitationPersistence(store);
  return store.withTransaction((state) => {
    const invitation = (state.staff_invitations ?? []).find((i) => i.id === invitationId);
    if (!invitation) throw new AppError("NOT_FOUND", "Invitation not found.", 404);
    if (invitation.status !== "pending") {
      throw new AppError(
        "CONFLICT",
        `Invitation is already '${invitation.status}'.`,
        409
      );
    }
    const nowIso = new Date().toISOString();
    invitation.status = "revoked";
    invitation.revoked_at = nowIso;
    invitation.updated_at = nowIso;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "identity.invitation.revoked",
      resource_type: "staff_invitation",
      resource_id: invitation.id,
      outcome: "success",
      request_id: requestId,
      changes: { email: invitation.email },
    });
    return stripInvitationToken(invitation);
  });
}

export async function acceptStaffInvitation(
  store: StackMateDataStore,
  rawInput: unknown,
  requestId: string
): Promise<{ user: Omit<UserRecord, "password_hash">; roles: string[] }> {
  const input = AcceptStaffInvitationSchema.parse(rawInput);
  assertInvitationPersistence(store);
  const tokenHash = sha256Hex(input.token);

  // Expire a stale pending invitation in its OWN transaction first: a
  // flip followed by a throw in the same transaction would be rolled
  // back and the row would stay 'pending' forever (same trap as the
  // license-expiry flip in STATUS.md gap #2).
  await store.withTransaction((state) => {
    const stale = (state.staff_invitations ?? []).find((i) => i.token_hash === tokenHash);
    if (
      stale &&
      stale.status === "pending" &&
      new Date(stale.expires_at).getTime() <= Date.now()
    ) {
      stale.status = "expired";
      stale.updated_at = new Date().toISOString();
      appendAuditLog(state, {
        actor_type: "system",
        action: "identity.invitation.expired",
        resource_type: "staff_invitation",
        resource_id: stale.id,
        outcome: "success",
        request_id: requestId,
        changes: { email: stale.email },
      });
    }
  });

  return store.withTransaction((state) => {
    const invitation = (state.staff_invitations ?? []).find((i) => i.token_hash === tokenHash);
    if (!invitation) {
      throw new AppError("UNAUTHORIZED", "Invitation token is invalid.", 401);
    }
    if (invitation.status === "expired") {
      throw new AppError("GONE", "This invitation has expired. Ask an admin for a new one.", 410);
    }
    if (invitation.status !== "pending") {
      throw new AppError(
        "CONFLICT",
        `Invitation is already '${invitation.status}'.`,
        409
      );
    }
    if (state.users.some((u) => u.email === invitation.email)) {
      throw new AppError(
        "CONFLICT",
        `A staff user with email '${invitation.email}' already exists.`,
        409
      );
    }
    const matchedRoles = invitation.role_keys.map((rk) => {
      const found = state.roles.find((r) => r.key === rk);
      if (!found) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Invited role '${rk}' no longer exists. Ask an admin for a new invitation.`,
          422
        );
      }
      return found;
    });

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      email: invitation.email,
      email_verified: true,
      two_factor_enabled: false,
      password_hash: hashPasswordScrypt(input.password),
      status: "active",
      created_at: now,
      updated_at: now,
    };
    state.users.push(user);
    for (const r of matchedRoles) {
      state.user_roles.push({ user_id: user.id, role_id: r.id, assigned_at: now });
    }
    invitation.status = "accepted";
    invitation.accepted_user_id = user.id;
    invitation.accepted_at = now;
    invitation.updated_at = now;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: user.id,
      action: "identity.invitation.accepted",
      resource_type: "staff_invitation",
      resource_id: invitation.id,
      outcome: "success",
      request_id: requestId,
      changes: { email: invitation.email, roles: invitation.role_keys },
    });

    const { password_hash: _, ...safeUser } = user;
    return { user: safeUser, roles: invitation.role_keys };
  });
}

/**
 * Password-reset / 2FA-recovery tokens (Auth + Email batch, ADR-0008).
 *
 * Only the SHA-256 hash is stored; the raw token is emailed once and
 * never persisted. TTL 1 hour, single-use (used_at). `purpose` keeps
 * the two flows apart: a password-reset token cannot disable 2FA, and
 * a recovery token cannot reset a password — email compromise alone
 * must never defeat 2FA. These functions need a Drizzle-backed store
 * (the tokens table is not in store.state); on the in-memory test
 * adapter they throw a 503-style INTERNAL_ERROR and the app.ts handlers
 * fail closed (forgot → generic 200, reset/recover → 422).
 */
export type PasswordResetPurpose = "password_reset" | "two_factor_recovery";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function createPasswordResetToken(
  store: StackMateDataStore,
  userId: string,
  purpose: PasswordResetPurpose
): { rawToken: string; tokenHash: string; expiresAt: Date } {
  const rawToken = randomOpaqueToken("smreset", 24);
  return {
    rawToken,
    tokenHash: sha256Hex(rawToken),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  };
}

export async function storePasswordResetToken(
  store: StackMateDataStore,
  userId: string,
  purpose: PasswordResetPurpose,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  const db = drizzleDbOf(store);
  // Audit API M-11: a fresh token invalidates every prior UNUSED token
  // for the same user+purpose. Otherwise two reset emails leave two
  // live tokens, and using one leaves the other valid — an older
  // (forwarded / stale-inbox) email stays a live password-reset
  // credential after the victim has already reset.
  await db
    .delete(baPasswordResetTokens)
    .where(
      and(
        eq(baPasswordResetTokens.userId, userId),
        eq(baPasswordResetTokens.purpose, purpose),
        isNull(baPasswordResetTokens.usedAt)
      )
    );
  await db.insert(baPasswordResetTokens).values({
    id: randomUUID(),
    userId,
    tokenHash,
    purpose,
    expiresAt,
    createdAt: new Date(),
  });
}

/**
 * Atomically consume one reset/recovery token (audit API L-2).
 *
 * The validity pre-check (`findValidResetToken`) runs outside the
 * consuming transaction, so two concurrent requests presenting the
 * same token could both pass it before either commits. The consume
 * UPDATE itself is the atomic guard: it only touches a row whose
 * `usedAt` is still NULL, and returns the rows it touched — zero
 * rows means a concurrent request consumed it first, and the caller
 * must fail instead of resetting twice.
 */
type ResetTokenTx = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

async function consumeResetTokenAtomically(
  tx: ResetTokenTx,
  tokenId: string
): Promise<boolean> {
  const consumed = await tx
    .update(baPasswordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(baPasswordResetTokens.id, tokenId), isNull(baPasswordResetTokens.usedAt))
    )
    .returning({ id: baPasswordResetTokens.id });
  return consumed.length > 0;
}

/**
 * Invalidate every remaining UNUSED token for a user (audit API M-11).
 * A successful reset/recovery ends the whole token family: no sibling
 * token — same purpose or the other purpose — stays usable afterwards.
 */
async function invalidateSiblingResetTokens(
  tx: ResetTokenTx,
  userId: string
): Promise<void> {
  await tx
    .delete(baPasswordResetTokens)
    .where(
      and(
        eq(baPasswordResetTokens.userId, userId),
        isNull(baPasswordResetTokens.usedAt)
      )
    );
}

async function findValidResetToken(
  store: StackMateDataStore,
  rawToken: string,
  purpose: PasswordResetPurpose
): Promise<{ id: string; userId: string } | null> {
  const db = drizzleDbOf(store);
  const tokenHash = sha256Hex(rawToken);
  const rows = await db
    .select()
    .from(baPasswordResetTokens)
    .where(
      and(
        eq(baPasswordResetTokens.tokenHash, tokenHash),
        eq(baPasswordResetTokens.purpose, purpose)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return { id: row.id, userId: row.userId };
}

/**
 * Reset a staff password with a forgot-password token. Sets BOTH the
 * Better Auth credential hash and the staff scrypt hash (the lazy
 * migration provisions from the scrypt hash when no credential exists
 * yet), revokes ALL sessions for the user, and marks the token used —
 * all in one Drizzle transaction for the credential side. The audit
 * entry goes through the store afterwards (best-effort, like sign-in).
 */
export async function resetStaffPasswordByToken(
  store: StackMateDataStore,
  input: { token: string; newPassword: string; requestId: string }
): Promise<{ user_id: string; email: string }> {
  if (!input.newPassword || input.newPassword.length < 10) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Password must be at least 10 characters.",
      422
    );
  }
  const found = await findValidResetToken(store, input.token, "password_reset").catch(
    () => null
  );
  if (!found) {
    throw new AppError("VALIDATION_ERROR", "Reset link is invalid or expired.", 422);
  }
  const db = drizzleDbOf(store);
  const user = store.state.users.find((u) => u.id === found.userId);
  if (!user || user.status !== "active") {
    throw new AppError("VALIDATION_ERROR", "Reset link is invalid or expired.", 422);
  }
  const baHash = await hashPasswordBetterAuth(input.newPassword);
  const scryptHash = hashPasswordScrypt(input.newPassword);
  const now = new Date();
  await db.transaction(async (tx) => {
    // Better Auth credential (upsert — an old account may have none).
    const existing = await tx
      .select({ id: baAccounts.id })
      .from(baAccounts)
      .where(
        and(eq(baAccounts.userId, user.id), eq(baAccounts.providerId, "credential"))
      )
      .limit(1);
    if (existing[0]) {
      await tx
        .update(baAccounts)
        .set({ password: baHash, updatedAt: now })
        .where(eq(baAccounts.id, existing[0].id));
    } else {
      await tx.insert(baAccounts).values({
        id: randomUUID(),
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: baHash,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Revoke every session (the reset is unauthenticated — no session
    // survives it) and consume the token, atomically with the password.
    await tx.delete(baSessions).where(eq(baSessions.userId, user.id));
    // Audit L-2: the consume UPDATE only touches a row whose usedAt is
    // still NULL — a concurrent request presenting the same token loses
    // the race here instead of resetting twice. Throwing inside the
    // callback rolls the whole transaction back, so the loser changes
    // nothing.
    const consumed = await consumeResetTokenAtomically(tx, found.id);
    if (!consumed) {
      throw new AppError("VALIDATION_ERROR", "Reset link is invalid or expired.", 422);
    }
    // Audit M-11: a successful reset ends the whole token family — no
    // sibling token stays usable afterwards.
    await invalidateSiblingResetTokens(tx, user.id);
  });
  // Staff scrypt hash via the store (synced by userSpec) so the state
  // copy stays consistent for the rest of this request's lifetime.
  await store
    .withTransaction((state) => {
      const row = state.users.find((u) => u.id === user.id);
      if (row) {
        row.password_hash = scryptHash;
        row.updated_at = now.toISOString();
      }
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: user.id,
        action: "identity.auth.password_reset",
        resource_type: "session",
        resource_id: user.id,
        outcome: "success",
        request_id: input.requestId,
        changes: { via: "forgot_password" },
      });
    })
    .catch(() => {});
  return { user_id: user.id, email: user.email };
}

/**
 * Disable 2FA with a recovery token + the account password (Auth + Email
 * batch). The password is verified through Better Auth's own sign-in
 * (asResponse): a correct password for a 2FA-enabled user returns
 * `{ twoFactorRedirect: true }` and NO session (the plugin deletes it),
 * so there is nothing to revoke from THAT attempt. A wrong password
 * returns non-OK. A missing credential falls back to the stored scrypt
 * hash (legacy accounts). Disabling writes `users.two_factor_enabled =
 * false` and deletes the `two_factor` row via direct Drizzle — the
 * store's userSpec does not sync that column (the plugin owns it) —
 * revokes ALL pre-existing sessions (audit L-3), and consumes the
 * token. Password reset alone NEVER disables 2FA.
 */
export async function recoverTwoFactorByToken(
  store: StackMateDataStore,
  input: { token: string; password: string; requestId: string },
  auth?: BetterAuthInstance | null
): Promise<{ user_id: string; email: string }> {
  const found = await findValidResetToken(store, input.token, "two_factor_recovery").catch(
    () => null
  );
  if (!found) {
    throw new AppError("VALIDATION_ERROR", "Recovery link is invalid or expired.", 422);
  }
  await reloadStateIfPossible(store);
  const user = store.state.users.find((u) => u.id === found.userId);
  if (!user || user.status !== "active") {
    throw new AppError("VALIDATION_ERROR", "Recovery link is invalid or expired.", 422);
  }
  let passwordOk = false;
  if (auth && storeSupportsBetterAuth(store)) {
    const response = (await (
      auth.api.signInEmail as unknown as (opts: unknown) => Promise<unknown>
    )({
      body: { email: user.email, password: input.password },
      headers: new Headers(),
      asResponse: true,
    }).catch(() => null)) as Response | null;
    if (response?.ok) {
      passwordOk = true;
      // No session to clean up: the 2FA plugin deletes the session it
      // created and returns { twoFactorRedirect: true } instead.
    }
  }
  if (!passwordOk) {
    const hasCredential = await betterAuthCredentialExists(store, user.id).catch(() => true);
    if (!hasCredential && verifyPasswordScrypt(input.password, user.password_hash)) {
      passwordOk = true;
    }
  }
  if (!passwordOk) {
    throw new AppError("UNAUTHORIZED", "Invalid email or password.", 401);
  }
  const db = drizzleDbOf(store);
  await db.transaction(async (tx) => {
    await tx.update(baUsers).set({ twoFactorEnabled: false }).where(eq(baUsers.id, user.id));
    await tx.delete(baTwoFactor).where(eq(baTwoFactor.userId, user.id));
    // Audit L-3: recovery revokes ALL sessions, like password reset.
    // The old code claimed "there is nothing to revoke" because the
    // 2FA plugin deletes the session its sign-in attempt created — but
    // pre-existing sessions from other devices survive recovery, and
    // after an email+password recovery the account must be forced to
    // re-authenticate everywhere.
    await tx.delete(baSessions).where(eq(baSessions.userId, user.id));
    // Audit L-2: atomic consume (see resetStaffPasswordByToken).
    const consumed = await consumeResetTokenAtomically(tx, found.id);
    if (!consumed) {
      throw new AppError("VALIDATION_ERROR", "Recovery link is invalid or expired.", 422);
    }
    // Audit M-11: a successful recovery ends the whole token family.
    await invalidateSiblingResetTokens(tx, user.id);
  });
  await store
    .withTransaction((state) => {
      const row = state.users.find((u) => u.id === user.id);
      if (row) row.two_factor_enabled = false;
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: user.id,
        action: "identity.auth.two_factor_recovered",
        resource_type: "session",
        resource_id: user.id,
        outcome: "success",
        request_id: input.requestId,
        changes: { via: "email_recovery" },
      });
    })
    .catch(() => {});
  return { user_id: user.id, email: user.email };
}
