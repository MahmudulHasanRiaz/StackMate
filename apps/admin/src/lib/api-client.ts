/**
 * Typed Admin SPA API Client.
 * Uses credentials: 'include' for Better Auth HttpOnly session cookies and parses
 * standard StackMate snake_case success/error envelopes. Never stores secrets in localStorage.
 */
import {
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  formatMinorMoney,
} from "../../../../packages/contracts/src/index.ts";

export { formatDisplayDateDDMMYYYY, formatDisplayDateTimeDDMMYYYY, formatMinorMoney };

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    requestId: string,
    statusCode: number,
    details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.requestId = requestId;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Global 401 handler (live bug 2026-11-22): when a signed-in tab's
 * session dies mid-session (12h expiry, suspension), every section
 * query 401s and each section shows "Something went wrong" instead
 * of the sign-in screen — the user only discovers they are signed
 * out after a reload. A registered handler is called for 401s from
 * /api/v1/admin/* while a principal is held (RootComponent registers
 * it only then), so the app drops to the sign-in screen at once.
 * Auth endpoints are excluded by the path check: a wrong-password
 * 401 from sign-in must never clear a principal.
 */
type UnauthorizedHandler = (error: ApiClientError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
export function onApiUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(error: ApiClientError, path: string): void {
  if (
    error.statusCode === 401 &&
    path.startsWith("/api/v1/admin/") &&
    unauthorizedHandler
  ) {
    unauthorizedHandler(error);
  }
}

/**
 * Client-side request bound (SMTP timeout fix, 2026-11-16): no admin
 * request may hang forever. Live 2026-11-16 21:23 +06: "Send test
 * email" stayed on "Sending…" for 90+s while the Worker recorded no
 * invocation anywhere near 90s — the fetch never settled and the
 * button had no timeout to settle it. Every request now aborts at
 * 30s (generous: live p99 is ~2–3s) and the abort surfaces as an
 * ApiClientError with the real cause, so the caller shows the honest
 * error instead of spinning forever. No caller passes its own signal
 * (verified 2026-11-16), so the timeout signal is applied
 * unconditionally. Applied to BOTH helpers — rawApiRequest serves the
 * 2FA flows and would hang identically.
 */
const API_REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named
    // "TimeoutError" — surface it as the real cause instead of the
    // generic "Request failed" text, so e.g. the test-email button
    // shows why it stopped.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiClientError(
        "REQUEST_TIMEOUT",
        "Request timed out — the server did not respond in time. Please retry.",
        "unknown",
        0
      );
    }
    throw err;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  // FormData bodies must NOT get a JSON content-type — the browser sets
  // multipart/form-data with its own boundary. (Media library uploads,
  // PLAN §31; previously every body was JSON, so this was unreachable.)
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const res = await fetchWithTimeout(path, {
    ...options,
    credentials: "include",
    headers,
  });

  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details: Record<string, unknown> | null; request_id: string } }
    | null;

  if (!res.ok || !json || json.error) {
    const err = json?.error;
    const apiError = new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `Request failed with status ${res.status}`,
      err?.request_id ?? "unknown",
      res.status,
      err?.details ?? null
    );
    notifyUnauthorized(apiError, path);
    throw apiError;
  }

  return json.data as T;
}

/**
 * Raw variant of apiRequest: returns the parsed JSON body as-is, without
 * unwrapping the app's `{ data }` envelope. Use it ONLY for Better Auth's
 * own endpoints (the twoFactor plugin's /two-factor/* calls), which
 * return raw plugin responses — e.g. enable returns `{ totpURI,
 * backupCodes }` with no `data` key, so the enveloped helper returns
 * `undefined` and setup breaks (caught by the headless auth-email audit,
 * 2026-11-16). Error handling is identical to apiRequest.
 */
export async function rawApiRequest<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  // Same FormData rule as apiRequest (PLAN §31) — the browser sets the
  // multipart boundary; a JSON content-type here would break the body.
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const res = await fetchWithTimeout(path, {
    ...options,
    credentials: "include",
    headers,
  });

  const json = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details: Record<string, unknown> | null; request_id: string }; code?: string; message?: string }
    | null;

  if (!res.ok || !json || json.error) {
    const err = json?.error;
    // Better Auth's own endpoints return the error FLAT ({ code,
    // message }) instead of the app envelope — surface that message
    // instead of the generic "Request failed with status …" (the live
    // 2FA 403 hid the real "Invalid origin" message behind the
    // generic text, which is why the failure looked password-related).
    const code =
      err?.code ??
      (typeof json?.code === "string" ? json.code : undefined) ??
      "HTTP_ERROR";
    const message =
      err?.message ??
      (typeof json?.message === "string" ? json.message : undefined) ??
      `Request failed with status ${res.status}`;
    const apiError = new ApiClientError(
      code,
      message,
      err?.request_id ?? "unknown",
      res.status,
      err?.details ?? null
    );
    notifyUnauthorized(apiError, path);
    throw apiError;
  }

  return json as T;
}
