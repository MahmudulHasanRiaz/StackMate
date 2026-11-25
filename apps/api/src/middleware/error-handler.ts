/**
 * Error handler — app.ts `handleRequest` catch block ~L7595-7640.
 *
 * Hono `app.onError` handler (Worker 1: `app.onError(onErrorHandler)`).
 * Maps thrown errors to the EXISTING error envelope + status code,
 * exactly like app.ts's `handleRequest` catch:
 * - `AppError` → its own code/message/details + `statusCode`.
 * - `SchemaValidationError` → `VALIDATION_ERROR` 422 with
 *   `{ fields: error.fieldErrors }`.
 * - Anything else → `INTERNAL_ERROR` 500 with the generic message
 *   (the real error is never leaked to the client).
 * Every error response carries the standard headers (incl.
 * `X-Request-ID`, from `c.var.requestId` when set, else a fresh id —
 * the chain's `requestId()` runs first, so this fallback only binds
 * when the error was thrown before it, e.g. env resolution).
 */
import type { Context } from "hono";
import {
  createErrorEnvelope,
  SchemaValidationError,
} from "../../../../packages/contracts/src/index.ts";
import { AppError } from "../shared/errors.ts";
import type { AppEnv } from "../types/context.ts";
import {
  buildStandardHeaders,
  generateRequestId,
  resolveRequestEnv,
  trustedOriginsOf,
} from "./shared.ts";

export function onErrorHandler(err: Error, c: Context<AppEnv>): Response {
  const requestId =
    (c.var as Partial<AppEnv["Variables"]>).requestId ?? generateRequestId();
  let originHeader: string | null = null;
  let trustedOrigins: string[] = [];
  try {
    const env = resolveRequestEnv(c);
    trustedOrigins = trustedOriginsOf(env);
    originHeader = c.req.header("Origin") ?? null;
  } catch {
    // Env unavailable (e.g. the throw came from env resolution itself):
    // answer without CORS headers rather than failing the error path.
  }
  const headers = buildStandardHeaders(requestId, originHeader, trustedOrigins);

  if (err instanceof AppError) {
    return new Response(
      JSON.stringify(
        createErrorEnvelope(err.code, err.message, requestId, err.details)
      ),
      { status: err.statusCode, headers }
    );
  }
  if (err instanceof SchemaValidationError) {
    return new Response(
      JSON.stringify(
        createErrorEnvelope("VALIDATION_ERROR", err.message, requestId, {
          fields: err.fieldErrors,
        })
      ),
      { status: 422, headers }
    );
  }
  return new Response(
    JSON.stringify(
      createErrorEnvelope(
        "INTERNAL_ERROR",
        "An unexpected internal error occurred.",
        requestId
      )
    ),
    { status: 500, headers }
  );
}
