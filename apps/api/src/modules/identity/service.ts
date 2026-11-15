import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashPassword as hashPasswordBetterAuth } from "better-auth/crypto";
import type * as schema from "../../../../../db/schema/index.ts";
import {
  accounts as baAccounts,
  sessions as baSessions,
  users as baUsers,
} from "../../../../../db/schema/auth.ts";
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
  };
  session_id: string;
  roles: string[];
  permissions: string[];
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
  assertStaffPermission(actor, "users.manage");
  return store.withTransaction((state) => {
    const emailNormalized = input.email.trim().toLowerCase();
    if (state.users.some((u) => u.email === emailNormalized)) {
      throw new AppError("CONFLICT", `A staff user with email '${emailNormalized}' already exists.`, 409);
    }
    if (input.role_keys.includes("super_admin") && !actor.roles.includes("super_admin")) {
      throw new AppError("FORBIDDEN", "Only a Super Admin can assign the super_admin role.", 403);
    }
    const matchedRoles = input.role_keys.map((rk) => {
      const found = state.roles.find((r) => r.key === rk);
      if (!found) {
        throw new AppError("VALIDATION_ERROR", `Unknown role key '${rk}'.`, 422);
      }
      return found;
    });

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      email: emailNormalized,
      email_verified: true,
      password_hash: hashPasswordScrypt(input.password),
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
      changes: { email: user.email, roles: input.role_keys },
    });

    const { password_hash: _, ...safeUser } = user;
    return { user: safeUser, roles: input.role_keys };
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
    user: { id: user.id, name: user.name, email: user.email, status: user.status },
    session_id: "",
    roles,
    permissions,
  };
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
  };
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
  return { session_token: token, expires_at: expiresAt, principal, set_cookie: setCookie };
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
      } catch {
        return null;
      }
    }
  }

  const rawToken = input.bearerToken?.trim() || extractStackmateSessionCookie(input.cookieHeader);
  if (!rawToken) return null;

  if (auth && storeSupportsBetterAuth(store)) {
    const row = await findBetterAuthSessionByToken(store, rawToken).catch(() => null);
    if (!row || row.expiresAt.getTime() <= nowMs) return null;
    const email = await findBetterAuthUserEmail(store, row.userId).catch(() => null);
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
    // letting it surface as a 500.
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
      // Revoke every session except the one that made this request
      // (dist/api/routes/session.mjs: revokeOtherSessions filters out
      // ctx.context.session.session.token). Identified via the same
      // signed session cookie.
      await (auth.api.revokeOtherSessions as unknown as (opts: unknown) => Promise<unknown>)({
        headers: new Headers({ cookie: input.cookieHeader ?? "" }),
      });
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
  assertStaffPermission(actor, "users.manage");
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

// ---------------------------------------------------------------------------
// Roles (API Spec §8) — custom roles. The spec names permissions
// users.invite / roles.create / roles.update, but the seeded permission
// catalogue (db/seeds/seed-reference.ts) has no such keys; the existing
// users.manage permission ("Manage staff users, roles, and permissions")
// is the equivalent gate and is used for all role + invitation writes.
// ---------------------------------------------------------------------------

function validatePermissionAllowlist(permissionKeys: string[]): void {
  const known: Set<string> = new Set(SEED_PERMISSIONS.map((p) => p.key));
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
  assertStaffPermission(actor, "users.manage");
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
  assertStaffPermission(actor, "users.manage");
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
// Staff invitations (API Spec §8, Batch 1). No email system exists, so the
// invitation token is returned ONCE to the creating admin, who shares it
// with the invitee out of band. Only the SHA-256 hash is stored.
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
  assertStaffPermission(actor, "users.manage");
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
  assertStaffPermission(actor, "users.manage");
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
