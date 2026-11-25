/**
 * RBAC guard factory — `assertStaffPermissionAudited` from
 * `modules/identity/service.ts`.
 *
 * Route-handler guard: `app.get("/x", rbac("orders.read"), handler)`.
 * Reuses the existing permission check — `assertStaffPermissionAudited`
 * (the variant every admin route in app.ts uses, e.g. ~L3233): 401 when
 * there is no principal at all, 403 `FORBIDDEN` when the principal
 * lacks the permission (`super_admin` bypasses the permission list),
 * and a best-effort `identity.auth.permission_denied` audit row on a
 * 403 (never masking the original error). Falls back to the plain
 * `assertStaffPermission` when no store/requestId is on the context
 * (e.g. the guard is used outside the chain — the audit write is
 * skipped then, the 401/403 behaviour is identical).
 */
import type { MiddlewareHandler } from "hono";
import {
  assertStaffPermission,
  assertStaffPermissionAudited,
} from "../modules/identity/service.ts";
import type { AppEnv } from "../types/context.ts";

export function rbac(permission: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const vars = c.var as Partial<AppEnv["Variables"]>;
    const principal = vars.principal ?? null;
    if (vars.store && vars.requestId) {
      await assertStaffPermissionAudited(vars.store, principal, permission, vars.requestId);
    } else {
      assertStaffPermission(principal, permission);
    }
    await next();
  };
}
