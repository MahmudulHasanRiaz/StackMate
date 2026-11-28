/**
 * Request-ID middleware — app.ts `handleRequest` ~L612-625.
 *
 * Correlation / Request ID (`X-Request-ID`), carried in `c.var.requestId`
 * and in every envelope's `meta`/`error.request_id`.
 *
 * NOTE — app.ts quirk, preserved exactly: the source validates the
 * caller-supplied id (`/^[a-zA-Z0-9_-]{6,64}$/`) but BOTH branches of
 * the ternary generate a fresh `req_<16 hex>` — the caller value is
 * never reused. This middleware copies that behaviour verbatim (no
 * behaviour change in this migration); if the owner wants caller ids
 * echoed, that is a deliberate behaviour change for a separate commit.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.ts";
import { generateRequestId } from "./shared.ts";

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const callerReqId = c.req.header("X-Request-ID")?.trim();
    const id =
      callerReqId && /^[a-zA-Z0-9_-]{6,64}$/.test(callerReqId)
        ? generateRequestId()
        : generateRequestId();
    c.set("requestId", id);
    await next();
    c.header("X-Request-ID", id);
  };
}
