/**
 * Shared HTTP plumbing for Hono route modules (Hono migration, Phase 1).
 *
 * Moved verbatim from apps/api/src/app.ts handleRequest closures: the
 * success/collection envelopes, the 6 MB capped JSON/multipart body
 * readers (400 on malformed JSON, 413 past the cap), the per-token
 * attempt cap, the dispatcher-level idempotency runner, the client-IP
 * rule (cf-connecting-ip authoritative), the session-cookie/bearer
 * helpers, the per-request Better Auth builder, the SMTP sender and
 * the storage-driver deps. No behaviour changed — only the implicit
 * closure variables (store/env/requestId) became explicit arguments.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createCollectionEnvelope, createSuccessEnvelope, decodeCursor, encodeCursor } from "../../../../packages/contracts/src/index.ts";
import { type StackMateBindings } from "../env.ts";
import { and } from "drizzle-orm";
import { StackMateDataStore } from "../platform/db/store.ts";
import { createBetterAuth } from "../modules/identity/better-auth.ts";
import { sendStackMateEmail, type SendResult } from "../modules/email/service.ts";
import { loadAuthConfig, type ResolvedAuthConfig, type ResolvedSmtpSettings } from "../modules/auth-config/service.ts";
import { type DriverDeps } from "../platform/storage/driver.ts";
import { AppError } from "../shared/errors.ts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types/context.ts";

export function jsonResponse<T>(
  c: Context<AppEnv>,
  data: T,
  status: ContentfulStatusCode = 200,
  extraHeaders?: Record<string, string>,
) {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status, extraHeaders);
}

export function jsonResponseWithCookies<T>(
  c: Context<AppEnv>,
  data: T,
  status: ContentfulStatusCode = 200,
  cookies: string[] = [],
  extraHeaders?: Record<string, string>,
) {
  const headers = new Headers(extraHeaders);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(createSuccessEnvelope(data, c.var.requestId)), {
    status,
    headers,
  });
}

export function collectionResponse<T>(
  c: Context<AppEnv>,
  items: T[],
  nextCursor: string | null = null,
  status: ContentfulStatusCode = 200,
  total?: number,
  extraHeaders?: Record<string, string>,
) {
  return c.json(
    createCollectionEnvelope(items, nextCursor, c.var.requestId, total),
    status,
    extraHeaders,
  );
}

export function pagedCollectionResponse<T>(
  c: Context<AppEnv>,
  filtered: T[],
  limit: number,
  page = 1,
  nextCursor: string | null = null,
  status: ContentfulStatusCode = 200,
  extraHeaders?: Record<string, string>,
) {
  return collectionResponse(
    c,
    applyListPage(filtered, limit, page),
    nextCursor,
    status,
    filtered.length,
    extraHeaders,
  );
}

export function parseListQuery(params: URLSearchParams): { q: string; limit: number; page: number } {
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const rawLimit = Number(params.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 100) : 25;
  const rawPage = Number(params.get("page"));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { q, limit, page };
}

export function applyListPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

export function parseTimestampSort(params: URLSearchParams, field: string): "desc" | "asc" {
  return params.get("sort") === `${field}:asc` ? "asc" : "desc";
}

export function sortByTimestamp<T extends { id: string }>(
  items: T[],
  field: string,
  direction: "desc" | "asc",
): T[] {
  const timeOf = (row: T): number => {
    const n = new Date(String((row as Record<string, unknown>)[field] ?? "")).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  return [...items].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
    return a.id.localeCompare(b.id);
  });
}

export function includesQuery(haystack: string | null | undefined, q: string): boolean {
  return !q ? true : (haystack ?? "").toLowerCase().includes(q);
}

export function matchesPhoneQuery(
  phone: string | null | undefined,
  normalizedPhone: string | null | undefined,
  q: string,
): boolean {
  if (!q) return true;
  if (includesQuery(phone, q)) return true;
  const digits = q.replace(/\D/g, "");
  if (!digits) return false;
  return (normalizedPhone ?? "").replace(/\D/g, "").includes(digits);
}

export function applyCursorPage<T extends { id: string; created_at: string }>(
  sortedDesc: T[],
  limit: number,
  cursor: string | null,
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor !== null && cursor !== "") {
    let decoded: { created_at: string; id: string };
    try {
      decoded = decodeCursor(cursor);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Malformed pagination cursor.", 400);
    }
    start = sortedDesc.findIndex(
      (row) =>
        row.created_at < decoded.created_at ||
        (row.created_at === decoded.created_at && row.id < decoded.id),
    );
    if (start === -1) return { page: [], nextCursor: null };
  }
  const page = sortedDesc.slice(start, start + limit);
  const nextCursor =
    page.length === limit && start + limit < sortedDesc.length
      ? encodeCursor({
          created_at: page[page.length - 1]!.created_at,
          id: page[page.length - 1]!.id,
        })
      : null;
  return { page, nextCursor };
}

export function sortNewestFirst<T extends { id: string; created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

export async function readCappedText(req: Request): Promise<string> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body is not valid JSON.", 400);
  }
}

export async function readJsonBody(c: Context<AppEnv>): Promise<any> {
  const text = await readCappedText(c.req.raw);
  if (text.trim() === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400,
    );
  }
  return parseJsonText(text);
}

export async function readJsonBodyLenient(c: Context<AppEnv>): Promise<any> {
  try {
    return await readJsonBody(c);
  } catch (error) {
    if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") throw error;
    return {};
  }
}

export async function readCappedMultipartFormData(
  c: Context<AppEnv>,
  capBytes: number,
): Promise<FormData> {
  const req = c.req.raw;
  const declaredLength = Number(req.headers.get("Content-Length") ?? "0");
  if (declaredLength > capBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
  }
  const body = req.body;
  if (!body) return new FormData();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel().catch(() => {});
      throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
    }
    chunks.push(value);
  }
  if (total === 0) return new FormData();
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const rebuilt = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: merged,
  });
  return rebuilt.formData();
}

export function getClientIp(req: Request): string {
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  const viaCloudflare =
    cfConnectingIp !== null || req.headers.get("cf-ray") !== null;
  return (
    cfConnectingIp ??
    (viaCloudflare ? "127.0.0.1" : (req.headers.get("x-real-ip") ?? "127.0.0.1"))
  );
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (
      rawName === "stackmate_session" ||
      rawName === "__Host-stackmate_session" ||
      rawName === "better-auth.session_token" ||
      rawName === "__Secure-better-auth.session_token"
    ) {
      return rest.join("=").trim();
    }
  }
  return null;
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1]!.trim() : null;
}

export function setupTokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const betterAuthFallbackClients = new WeakMap<
  object,
  Array<{ end: () => Promise<unknown> }>
>();

export async function getBetterAuth(env: StackMateBindings, store: StackMateDataStore) {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  let authConfig: ResolvedAuthConfig | undefined;
  if (maybeDrizzle.drizzleDb) {
    authConfig = await loadAuthConfig(
      maybeDrizzle.drizzleDb as Parameters<typeof loadAuthConfig>[0],
      { encryptionKey: env.ENCRYPTION_KEY_V1, keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION },
      env.HYPERDRIVE_NO_CACHE.connectionString,
    ).catch(() => undefined);
  }
  if (maybeDrizzle.drizzleDb) {
    return createBetterAuth(
      env,
      maybeDrizzle.drizzleDb as Parameters<typeof createBetterAuth>[1],
      authConfig,
    );
  }
  const { Client } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const client = new Client({
    connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
  });
  const tracked = betterAuthFallbackClients.get(store) ?? [];
  tracked.push(client);
  betterAuthFallbackClients.set(store, tracked);
  return createBetterAuth(env, drizzle(client), authConfig);
}

// Integration hook for the Hono app entrypoint: end any Better Auth
// fallback pg.Client created for this request (app.ts closed these in
// fetchHandler's finally; the Hono composition must call this there).
export async function closeBetterAuthFallbackClients(
  store: StackMateDataStore,
): Promise<void> {
  const clients = betterAuthFallbackClients.get(store);
  if (!clients || clients.length === 0) return;
  betterAuthFallbackClients.delete(store);
  await Promise.all(clients.map((cl) => cl.end().catch(() => {})));
}

export async function sendEmailViaSmtp(
  store: StackMateDataStore,
  env: StackMateBindings,
  message: { to: string; subject: string; text: string; html?: string },
  preloadedSmtp?: ResolvedSmtpSettings | null,
): Promise<SendResult> {
  const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
    | Parameters<typeof sendStackMateEmail>[0]
    | undefined;
  if (!db) {
    return {
      sent: false,
      error: "Email is not configured. Set up SMTP in Settings → Email.",
    };
  }
  const sendWithPreloaded = sendStackMateEmail as (
    db: Parameters<typeof sendStackMateEmail>[0],
    deps: Parameters<typeof sendStackMateEmail>[1],
    message: Parameters<typeof sendStackMateEmail>[2],
    preloadedSmtp?: ResolvedSmtpSettings | null,
  ) => Promise<SendResult>;
  return sendWithPreloaded(
    db,
    {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
      appUrl: env.APP_URL,
    },
    message,
    preloadedSmtp ?? undefined,
  );
}

export function driverDepsForRequest(
  store: StackMateDataStore,
  env: StackMateBindings,
): DriverDeps {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  const maybeBucket = store as unknown as {
    r2Bucket?: unknown;
    usesInMemoryBucket?: boolean;
  };
  return {
    db: (maybeDrizzle.drizzleDb ?? null) as DriverDeps["db"],
    appEnv: env.APP_ENV,
    r2Bucket: maybeBucket.r2Bucket as DriverDeps["r2Bucket"],
    usesInMemoryBucket: maybeBucket.usesInMemoryBucket,
  };
}

export function assertSameSiteCookieMutation(c: Context<AppEnv>, req: Request): void {
  const trustedOrigins = c.var.env.TRUSTED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sessionCookie = parseSessionCookie(req.headers.get("Cookie"));
  if (!sessionCookie) return;
  const methodUpper = req.method.toUpperCase();
  if (methodUpper === "GET" || methodUpper === "HEAD") return;
  const origin = req.headers.get("Origin");
  const referer = req.headers.get("Referer");
  const fetchSite = req.headers.get("Sec-Fetch-Site");
  const refererOrigin = (() => {
    if (!referer) return null;
    try {
      return new URL(referer).origin;
    } catch {
      return "invalid";
    }
  })();
  const crossSite =
    (origin !== null && !trustedOrigins.includes(origin)) ||
    (origin === null &&
      refererOrigin !== null &&
      !trustedOrigins.includes(refererOrigin)) ||
    (origin === null && refererOrigin === null && fetchSite === "cross-site");
  if (crossSite) {
    throw new AppError(
      "FORBIDDEN",
      `Cross-origin state-changing request from untrusted origin '${origin ?? refererOrigin ?? "cross-site"}' blocked by CSRF policy.`,
      403,
    );
  }
}

