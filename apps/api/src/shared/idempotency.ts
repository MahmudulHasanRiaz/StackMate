/**
 * Dispatcher-level idempotency + per-token attempt cap (Hono migration).
 *
 * Moved verbatim from apps/api/src/app.ts (A-04/A-06): the reserve ->
 * execute -> complete idempotency runner and the 5-attempts-per-hour
 * one-time-token cap. Split out of shared/http.ts so no file exceeds
 * ~500 lines.
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "../platform/crypto/index.ts";
import { and } from "drizzle-orm";
import { AppError } from "../shared/errors.ts";
import type { Context } from "hono";
import type { AppEnv } from "../types/context.ts";

export async function capTokenAttempts(
  c: Context<AppEnv>,
  bucketKey: string,
  onExhausted: () => Promise<void>,
): Promise<void> {
  try {
    await c.var.store.checkRateLimit(bucketKey, 5, 60 * 60_000);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED") {
      await onExhausted().catch(() => {});
    }
    throw error;
  }
}

export async function runIdempotentCommand<T>(c: Context<AppEnv>, options: {
  scope: string;
  key: string | null | undefined;
  payload: unknown;
  statusCode: number;
  fn: () => Promise<T>;
  redactForStore?: (body: T) => unknown;
  reissueOnReplay?: (storedBody: unknown) => Promise<T> | T;
}): Promise<{ status: number; body: T; replayed: boolean }> {
  const store = c.var.store;
  const rawKey = options.key?.trim() ?? "";
  if (rawKey === "") {
    return { status: options.statusCode, body: await options.fn(), replayed: false };
  }
  if (rawKey.length < 8 || rawKey.length > 128) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Idempotency-Key header must be between 8 and 128 characters.",
      400,
    );
  }
  const requestHash = sha256Hex(JSON.stringify(options.payload ?? {}));
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const findRecord = (state: typeof store.state) =>
    state.idempotency_records.find(
      (r) => r.scope_key === options.scope && r.idempotency_key === rawKey,
    );
  const reserved = await store.withTransaction((state) => {
    const existing = findRecord(state);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with a different request payload.",
          409,
        );
      }
      if (existing.status === "processing") {
        throw new AppError(
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is currently processing.",
          409,
        );
      }
      if (existing.status === "failed") {
        existing.status = "processing";
        existing.response_body = null;
        return { replay: false as const };
      }
      return {
        replay: true as const,
        body: existing.response_body,
        status: existing.response_status,
      };
    }
    state.idempotency_records.push({
      id: randomUUID(),
      scope_key: options.scope,
      idempotency_key: rawKey,
      request_hash: requestHash,
      status: "processing",
      response_status: options.statusCode,
      response_body: null,
      expires_at: expiresAt,
      created_at: nowIso,
    });
    return { replay: false as const };
  });
  if (reserved.replay) {
    const body = options.reissueOnReplay
      ? await options.reissueOnReplay(reserved.body)
      : (reserved.body as T);
    return { status: reserved.status, body, replayed: true };
  }
  let body: T;
  try {
    body = await options.fn();
  } catch (error) {
    await store
      .withTransaction((state) => {
        const rec = findRecord(state);
        if (rec && rec.status === "processing") rec.status = "failed";
      })
      .catch(() => {});
    throw error;
  }
  const storedBody = options.redactForStore ? options.redactForStore(body) : body;
  await store
    .withTransaction((state) => {
      const rec = findRecord(state);
      if (rec) {
        rec.status = "completed";
        rec.response_status = options.statusCode;
        rec.response_body = storedBody;
      }
    })
    .catch(() => {});
  return { status: options.statusCode, body, replayed: false };
}

