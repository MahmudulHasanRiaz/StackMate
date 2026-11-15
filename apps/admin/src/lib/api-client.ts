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

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
  });

  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details: Record<string, unknown> | null; request_id: string } }
    | null;

  if (!res.ok || !json || json.error) {
    const err = json?.error;
    throw new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `Request failed with status ${res.status}`,
      err?.request_id ?? "unknown",
      res.status,
      err?.details ?? null
    );
  }

  return json.data as T;
}
