/**
 * Security-headers middleware — app.ts `buildStandardHeaders` ~L416-444.
 *
 * Security headers on every response. Only the four security headers
 * live here: `X-Request-ID` belongs to `requestId()`
 * (`middleware/request-id.ts`), `Content-Type` belongs to the response
 * builder, and the CORS allow-origin headers belong to `corsHandler()`
 * (`middleware/cors.ts`) — exactly how `buildStandardHeaders` composes
 * them in app.ts. Set after `next()` so they land on the final response
 * (Hono applies post-`next()` `c.header()` calls to the returned
 * Response, including a raw `new Response(...)`).
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.ts";

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  };
}
