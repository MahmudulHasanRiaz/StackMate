/**
 * StackMate API — Hono route module (Hono migration, Phase 1).
 *
 * Converted mechanically from apps/api/src/app.ts (baseline feat e382d65):
 * same paths, methods, service calls, validation, RBAC and JSON shapes.
 * Only the HTTP plumbing changed: handlers read store/env/principal/
 * requestId from c.var (set by the Hono app middleware) and answer with
 * the same success/error envelopes. Shared HTTP plumbing lives in
 * apps/api/src/shared/http.ts.
 *
 * Middleware the Hono app MUST provide (was app.ts handleRequest/admin
 * preamble, not per-route code): request-id + standard/security headers,
 * CORS, CSRF gate, admin principal resolution, the 2FA-setup gate, the
 * admin 600/min bucket, and the AppError/SchemaValidationError ->
 * envelope mapping.
 */

import { formatDisplayDateDDMMYYYY } from "../../../../../packages/contracts/src/index.ts";
import { and } from "drizzle-orm";
import { buildInvitationEmail } from "../../modules/email/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import type { StackMateBindings } from "../../env.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited, createStaffInvitationByAdmin, createStaffUserByAdmin, ensureBetterAuthIdentity, revokeStaffInvitationByAdmin, storeSupportsBetterAuth, suspendStaffUser, unsuspendStaffUser, updateStaffUserRoles } from "../../modules/identity/service.ts";
import { requestVerificationEmail, type VerificationEmailResult } from "../../modules/identity/email-verification.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, includesQuery, readJsonBody, sendEmailViaSmtp, getBetterAuth } from "../../shared/http.ts";

/**
 * OD-06: best-effort verification-email send for the admin flows.
 * Never throws: without a Drizzle-backed store (the in-memory test
 * adapter) there is no SMTP / Better Auth to send through, so the
 * honest answer is "not configured". Delivery failures are reported
 * via the returned `{ sent, error }` — never by throwing — so a
 * failed send can never fail the admin mutation it follows.
 * (The public resend route in routes/auth.ts carries a twin of this
 * helper; hoisting it to shared/http.ts is a later cleanup, not
 * this slice.)
 */
async function sendVerificationEmailBestEffort(
  store: StackMateDataStore,
  env: StackMateBindings,
  email: string
): Promise<VerificationEmailResult> {
  try {
    const db = (
      store as unknown as {
        drizzleDb?: Parameters<typeof requestVerificationEmail>[0]["db"];
      }
    ).drizzleDb;
    if (!db || !storeSupportsBetterAuth(store)) {
      return {
        sent: false,
        error: "Email is not configured. Set up SMTP in Settings → Email.",
      };
    }
    const auth = await getBetterAuth(env, store);
    return await requestVerificationEmail({ db, env, auth, email });
  } catch (err) {
    return {
      sent: false,
      error:
        err instanceof Error
          ? err.message
          : "Verification email could not be sent.",
    };
  }
}
export function registerAdminUsersRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/users", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const { q, limit, page } = parseListQuery(url.searchParams);
    // H-03: ?status=active narrows the combobox/server list to
    // active staff (unknown values match nothing, unknown params
    // are ignored).
    const statusFilter = url.searchParams.get("status");
    const users = store.state.users
        .filter((u) => (!statusFilter ? true : u.status === statusFilter))
        .filter((u) => includesQuery(u.name, q) || includesQuery(u.email, q))
        .map((u) => {
          const roleIds = new Set(
            store.state.user_roles.filter((ur) => ur.user_id === u.id).map((ur) => ur.role_id)
          );
          const roleKeys = store.state.roles
            .filter((r) => roleIds.has(r.id))
            .map((r) => r.key);
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            email_verified: u.email_verified,
            status: u.status,
            roles: roleKeys,
            created_at: u.created_at,
            created_date_display: formatDisplayDateDDMMYYYY(u.created_at, env.DEFAULT_TIMEZONE),
          };
        });
    return pagedCollectionResponse(c, users, limit, page);
  });
  app.post("/api/v1/admin/users", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBody(c)) as {
      name: string;
      email: string;
      password: string;
      role_keys: string[];
    };
    const created = await createStaffUserByAdmin(store, principal, {
      ...body,
      requestId,
    });
    // Provision the Better Auth identity for the same email (best
    // effort — first sign-in lazily migrates if this fails).
    if (storeSupportsBetterAuth(store)) {
      await ensureBetterAuthIdentity(store, {
        userId: created.user.id,
        email: body.email,
        password: body.password,
      }).catch(() => {});
    }
    // OD-06: verification email, best-effort — a failed send never
    // fails the creation; the honest result rides in the response so
    // the admin UI can show "created, verification email sent" or
    // "created, email failed — resend available".
    const verificationEmail = await sendVerificationEmailBestEffort(
      store,
      env,
      created.user.email
    );
    return jsonResponse(c, { ...created, verification_email: verificationEmail }, 201);
  });
  app.post("/api/v1/admin/users/:userId/resend-verification", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const userId = c.req.param("userId")!;
    const user = store.state.users.find((u) => u.id === userId);
    if (!user) throw new AppError("NOT_FOUND", "User not found.", 404);
    if (user.email_verified) {
      throw new AppError("CONFLICT", "Email is already verified.", 409);
    }
    // OD-06: 1/min per user — probe first so a limited resend never
    // mints a token, then count the attempt once it has been made.
    const resendBucketKey = `resend-verification:${userId}`;
    if (await store.isRateLimited(resendBucketKey, 1, 60_000)) {
      throw new AppError(
        "RATE_LIMIT_EXCEEDED",
        "A verification email was already sent for this user recently. Try again in a minute.",
        429
      );
    }
    const result = await sendVerificationEmailBestEffort(store, env, user.email);
    await store.checkRateLimit(resendBucketKey, 1, 60_000).catch(() => {});
    // Audit the resend like the other user mutations (outcome
    // follows the honest send result; a failed audit write must not
    // rewrite it).
    await store
      .withTransaction((state) => {
        appendAuditLog(state, {
          actor_type: "staff",
          actor_user_id: principal.user.id,
          action: "identity.user.verification_email_resent",
          resource_type: "user",
          resource_id: user.id,
          outcome: result.sent ? "success" : "failed",
          request_id: requestId,
          changes: { email: user.email },
        });
      })
      .catch(() => {});
    return jsonResponse(c, {
      sent: result.sent,
      ...(result.error ? { error: result.error } : {}),
    });
  });
  app.put("/api/v1/admin/users/:userId/roles", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBody(c)) as { role_keys: string[] };
    // L-13: role_keys must be an array — a string used to reach
    // updateStaffUserRoles and throw a bare TypeError (500).
    if (!body || typeof body !== "object" || !Array.isArray(body.role_keys)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "role_keys must be an array of role keys.",
        422
      );
    }
    const updated = await updateStaffUserRoles(
      store,
      principal,
      c.req.param("userId")!,
      body.role_keys ?? [],
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.get("/api/v1/admin/users/invitations", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const { limit, page } = parseListQuery(url.searchParams);
    const items = (store.state.staff_invitations ?? []).map((inv) => {
      const { token_hash: _h, ...safe } = inv;
      return safe;
    });
    return pagedCollectionResponse(c, items, limit, page);
  });
  app.post("/api/v1/admin/users/invitations", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createStaffInvitationByAdmin(store, principal, body, requestId);
    // Invitation email (Auth + Email batch): best-effort — the
    // token_once return is unchanged and stays the delivery path
    // when email is not configured. `email_sent` / `email_error`
    // are honest: a failed send is reported, never hidden.
    let emailSent = false;
    let emailError: string | undefined;
    try {
      const result = await sendEmailViaSmtp(store, env, {
        to: created.invitation.email,
        ...buildInvitationEmail(env.APP_URL, created.token_once, created.invitation.role_keys),
      });
      emailSent = result.sent;
      emailError = result.error;
    } catch {
      emailError = "Email is not configured. Copy the invitation link manually.";
    }
    return jsonResponse(c, 
      { ...created, email_sent: emailSent, email_error: emailError },
      201
    );
  });
  app.post("/api/v1/admin/users/invitations/:invitationId/revoke", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const revoked = await revokeStaffInvitationByAdmin(
      store,
      principal,
      c.req.param("invitationId")!,
      requestId
    );
    return jsonResponse(c, revoked);
  });
  app.get("/api/v1/admin/users/:userId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const user = store.state.users.find((u) => u.id === c.req.param("userId"));
    if (!user) throw new AppError("NOT_FOUND", "User not found.", 404);
    const roleIds = new Set(
      store.state.user_roles.filter((ur) => ur.user_id === user.id).map((ur) => ur.role_id)
    );
    const roleKeys = store.state.roles
      .filter((r) => roleIds.has(r.id))
      .map((r) => r.key);
    return jsonResponse(c, {
      id: user.id,
      name: user.name,
      email: user.email,
      email_verified: user.email_verified,
      status: user.status,
      roles: roleKeys,
      created_at: user.created_at,
      created_date_display: formatDisplayDateDDMMYYYY(user.created_at, env.DEFAULT_TIMEZONE),
    });
  });
  app.patch("/api/v1/admin/users/:userId/suspend", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    const result = await suspendStaffUser(
      store,
      principal,
      c.req.param("userId")!,
      requestId
    );
    return jsonResponse(c, result);
  });
  app.patch("/api/v1/admin/users/:userId/unsuspend", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    const result = await unsuspendStaffUser(
      store,
      principal,
      c.req.param("userId")!,
      requestId
    );
    return jsonResponse(c, result);
  });
}
