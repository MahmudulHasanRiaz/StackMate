/**
 * CORS middleware — app.ts OPTIONS block ~L674-694 + the CORS part of
 * `buildStandardHeaders` (~L416-444).
 *
 * Origin-verified CORS, hand-rolled (Hono's `hono/cors` does NOT match
 * this behaviour: it would advertise the allow-list to any origin).
 * - `OPTIONS` (preflight): L-20 — the method/header allow-list is only
 *   advertised to a trusted origin. Any other origin (or none) gets a
 *   bare 204 — it grants nothing and reveals nothing about the API
 *   surface. The 204 carries the FULL standard header set (incl.
 *   `X-Request-ID` + security headers) because it returns before the
 *   earlier middlewares' post-`next()` header code runs.
 * - Other methods: the response carries `Access-Control-Allow-Origin`
 *   (+ `Allow-Credentials`, `Vary: Origin`) only when the request
 *   `Origin` is trusted — the CORS part of `buildStandardHeaders`.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.ts";
import {
  buildStandardHeaders,
  generateRequestId,
  resolveRequestEnv,
  trustedOriginsOf,
} from "./shared.ts";

export function corsHandler(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = resolveRequestEnv(c);
    const trustedOrigins = trustedOriginsOf(env);
    const originHeader = c.req.header("Origin") ?? null;
    const requestId =
      (c.var as Partial<AppEnv["Variables"]>).requestId ?? generateRequestId();

    if (c.req.method.toUpperCase() === "OPTIONS") {
      // L-20: the method/header allow-list is only advertised to a
      // trusted origin. Any other origin (or none) gets a bare 204 —
      // it grants nothing and reveals nothing about the API surface.
      const isTrustedOrigin =
        originHeader !== null && trustedOrigins.includes(originHeader);
      return new Response(null, {
        status: 204,
        headers: {
          ...buildStandardHeaders(requestId, originHeader, trustedOrigins),
          ...(isTrustedOrigin
            ? {
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers":
                  "Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-StackMate-Site-Key, X-StackMate-Key-Id, X-StackMate-Timestamp, X-StackMate-Nonce, X-StackMate-Content-SHA256, X-StackMate-Signature",
              }
            : {}),
        },
      });
    }

    await next();
    if (originHeader && trustedOrigins.includes(originHeader)) {
      c.header("Access-Control-Allow-Origin", originHeader);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
  };
}

/**
 * Alias: Worker 1 (`hono-app.ts`) imports this middleware as `cors`.
 * Same handler as `corsHandler` — see above for the behaviour note.
 */
export const cors: typeof corsHandler = corsHandler;
