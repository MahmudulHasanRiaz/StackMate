import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseState, StackMateDataStore, UserRecord } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";

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

export async function signInStaffSession(
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

    const { roles, permissions } = resolveEffectivePermissions(state, user.id);
    const principal: StaffPrincipal = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
      },
      session_id: sessionId,
      roles,
      permissions,
    };

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
    };
  });
}

export function resolveStaffPrincipalFromToken(
  store: StackMateDataStore,
  rawToken: string | undefined | null,
  nowMs = Date.now()
): StaffPrincipal | null {
  if (!rawToken) return null;
  store.queryMetrics.uncachedQueries += 1;
  const session = store.state.sessions.find((s) => s.token === rawToken.trim());
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= nowMs) {
    return null;
  }
  const user = store.state.users.find((u) => u.id === session.user_id);
  if (!user || user.status !== "active") return null;

  const { roles, permissions } = resolveEffectivePermissions(store.state, user.id);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
    },
    session_id: session.id,
    roles,
    permissions,
  };
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

    // Security & Threat Model §4.1: Revoke active sessions immediately after role changes
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
