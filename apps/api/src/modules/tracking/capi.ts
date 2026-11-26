/**
 * Meta Conversions API (CAPI) provider adapter — Batch 4 / E-01
 * (PRD §15.3 + §15.6; API spec §17.5).
 *
 * This is the FIRST real Meta delivery path in StackMate. Until this
 * file existed, CAPI dispatch was a known stub: events were recorded +
 * queued and labelled "simulated", never sent
 * (`apps/api/src/modules/webhooks/service.ts`, C-2/D-6).
 *
 * Rules enforced here (API spec §17.5):
 * - Pinned Graph API version from configuration (`META_GRAPH_API_VERSION`,
 *   default `v21.0` in `apps/api/src/env.ts`) — never a floating version.
 * - The CAPI access token is decrypted from the pixel group's encrypted
 *   store value and NEVER leaves this module: it travels only as the
 *   `access_token` query parameter Meta documents, and it is NEVER
 *   written to diagnostics, audit rows, or error messages.
 * - PII is hashed server-side before dispatch: callers pass the already-
 *   hashed `em`/`ph` values the tracking service stores, or raw
 *   `email`/`phone`, which are hashed here with the same helpers the
 *   tracking service uses (`sha256Hex`, `normalizePhoneE164`).
 * - Bounded retry: transient failures (network error, 429, 5xx) retry at
 *   most 3 attempts with bounded backoff; permanent 4xx rejections are
 *   never retried.
 * - Delivery status is separate from acceptance, and HONEST: `delivered`
 *   is true only when Meta answers HTTP 2xx AND `events_received >= 1`.
 *   A 2xx with zero events received, a 4xx, or an exhausted retry is
 *   `delivered: false` — never recorded as delivered anywhere.
 * - Diagnostics are bounded and sanitized (pixel id, event name/id,
 *   attempts, HTTP status, `events_received`, `fbtrace_id`, Meta's
 *   messages, truncated error text). No token, no raw PII.
 *
 * Wiring note (E-01): the outbox drain loop (`processTransactionalOutboxBatch`
 * in `modules/webhooks/service.ts`) calls this adapter through
 * `createCapiDeliver(env)` in that same module, which `scheduled.ts`
 * passes as `capiDeliver` on every cron tick. The drain maps the
 * result onto the tracking event / outbox row. This module performs
 * the HTTP delivery only; it writes no rows.
 */
import { decryptSecretAtRest, sha256Hex } from "../../platform/crypto/index.ts";
import { AppError } from "../../shared/errors.ts";
import type { TrackingConfigRecord } from "../../platform/db/store.ts";
import { normalizePhoneE164 } from "../customers/service.ts";

export const META_CAPI_MAX_ATTEMPTS = 3;
const META_CAPI_TIMEOUT_MS = 10_000;
const META_CAPI_BACKOFF_MS = [500, 1000];

export interface MetaCapiEventInput {
  event_name: string;
  event_id: string;
  /** ISO-8601 instant, unix seconds, or unix milliseconds. */
  event_time: string | number;
  /** API spec §17.5 / pixel allowlist: the site's own domain. */
  event_source_url?: string | null;
  action_source?: string;
  user_data?: {
    /** Already SHA-256-hashed email (as stored by the tracking service). */
    em?: string;
    /** Already SHA-256-hashed phone digits (as stored by the tracking service). */
    ph?: string;
    fbp?: string;
    fbc?: string;
    /** Raw email — hashed here when `em` is absent. */
    email?: string;
    /** Raw phone — normalized + hashed here when `ph` is absent. */
    phone?: string;
  };
  /**
   * Custom data, passed through to Meta. `value_minor` (integer minor
   * units, StackMate convention) is converted to Meta's `value` (major
   * units) when `value` is absent; `currency` passes through.
   */
  custom_data?: Record<string, unknown>;
  /** Meta test-event code (from the pixel group) — test traffic only. */
  test_event_code?: string | null;
}

export type MetaCapiDeliveryStatus = "delivered" | "failed" | "rejected" | "skipped";

export interface MetaCapiDeliveryResult {
  delivered: boolean;
  status: MetaCapiDeliveryStatus;
  http_status: number | null;
  events_received: number | null;
  fbtrace_id: string | null;
  messages: string[];
  attempts: number;
  /** Sanitized diagnostics — never contains the access token or raw PII. */
  diagnostics: {
    pixel_id: string;
    event_name: string;
    event_id: string;
    attempts: number;
    http_status: number | null;
    events_received: number | null;
    fbtrace_id: string | null;
    messages: string[];
    error: string | null;
  };
  error: string | null;
}

export interface MetaCapiEnv {
  META_GRAPH_API_VERSION?: string;
  ENCRYPTION_KEY_V1: string;
}

export interface MetaCapiOptions {
  fetchFn?: typeof fetch;
  /** Injectable sleep for tests — defaults to a real timer. */
  sleepMs?: (ms: number) => Promise<void>;
}

function eventTimeToUnixSeconds(eventTime: string | number): number {
  let seconds: number;
  if (typeof eventTime === "number") {
    seconds = eventTime > 1e12 ? Math.floor(eventTime / 1000) : Math.floor(eventTime);
  } else {
    const ms = Date.parse(eventTime);
    if (!Number.isFinite(ms)) {
      throw new AppError("VALIDATION_ERROR", `Invalid event_time '${eventTime}'.`, 422);
    }
    seconds = Math.floor(ms / 1000);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AppError("VALIDATION_ERROR", `Invalid event_time '${String(eventTime)}'.`, 422);
  }
  return seconds;
}

function buildHashedUserData(
  userData: MetaCapiEventInput["user_data"]
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!userData) return out;
  if (userData.em) out.em = userData.em;
  else if (userData.email) out.em = sha256Hex(userData.email.trim().toLowerCase());
  if (userData.ph) out.ph = userData.ph;
  else if (userData.phone) {
    const digits = (normalizePhoneE164(userData.phone) ?? "").replace(/\D/g, "");
    if (digits) out.ph = sha256Hex(digits);
  }
  if (userData.fbp) out.fbp = userData.fbp;
  if (userData.fbc) out.fbc = userData.fbc;
  return out;
}

function buildCustomData(customData: MetaCapiEventInput["custom_data"]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(customData ?? {}) };
  // StackMate stores money in integer minor units; Meta expects major
  // units. Convert only when the caller stored value_minor.
  if (out.value === undefined && typeof out.value_minor === "number") {
    out.value = out.value_minor / 100;
  }
  delete out.value_minor;
  return out;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deliver ONE event to Meta CAPI for one pixel group.
 *
 * `delivered` is true only on HTTP 2xx with `events_received >= 1`.
 * A disabled group or a non-Meta group is `skipped` (not an error, not
 * a delivery). A 4xx is `rejected` without retry; 429/5xx/network errors
 * retry up to META_CAPI_MAX_ATTEMPTS with bounded backoff, then `failed`.
 */
export async function deliverMetaCapiEvent(
  env: MetaCapiEnv,
  pixelGroup: TrackingConfigRecord,
  event: MetaCapiEventInput,
  options: MetaCapiOptions = {}
): Promise<MetaCapiDeliveryResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleepMs ?? sleepDefault;
  const graphVersion = env.META_GRAPH_API_VERSION ?? "v21.0";

  const finish = (
    delivered: boolean,
    status: MetaCapiDeliveryStatus,
    httpStatus: number | null,
    eventsReceived: number | null,
    fbtraceId: string | null,
    messages: string[],
    attempts: number,
    error: string | null
  ): MetaCapiDeliveryResult => ({
    delivered,
    status,
    http_status: httpStatus,
    events_received: eventsReceived,
    fbtrace_id: fbtraceId,
    messages,
    attempts,
    diagnostics: {
      pixel_id: pixelGroup.pixel_id,
      event_name: event.event_name,
      event_id: event.event_id,
      attempts,
      http_status: httpStatus,
      events_received: eventsReceived,
      fbtrace_id: fbtraceId,
      messages,
      error,
    },
    error,
  });

  if (pixelGroup.provider !== "meta") {
    return finish(false, "skipped", null, null, null, [], 0,
      `Pixel group provider is '${pixelGroup.provider}', not 'meta'.`);
  }
  if (pixelGroup.status !== "enabled") {
    return finish(false, "skipped", null, null, null, [], 0,
      `Pixel group is '${pixelGroup.status}'.`);
  }

  let accessToken: string;
  try {
    accessToken = decryptSecretAtRest(
      pixelGroup.access_token_ciphertext,
      env.ENCRYPTION_KEY_V1,
      `tracking_configurations:${pixelGroup.id}`
    );
  } catch {
    // Config error, not a delivery: never retry a token that cannot be
    // decrypted, and never surface the ciphertext.
    return finish(false, "failed", null, null, null, [], 0,
      "CAPI access token could not be decrypted.");
  }

  const eventTime = eventTimeToUnixSeconds(event.event_time);
  const payloadEvent: Record<string, unknown> = {
    event_name: event.event_name,
    event_time: eventTime,
    event_id: event.event_id,
    action_source: event.action_source ?? "website",
    user_data: buildHashedUserData(event.user_data),
  };
  if (event.event_source_url) payloadEvent.event_source_url = event.event_source_url;
  const customData = buildCustomData(event.custom_data);
  if (Object.keys(customData).length > 0) payloadEvent.custom_data = customData;

  const body: Record<string, unknown> = { data: [payloadEvent] };
  const testCode = event.test_event_code ?? pixelGroup.test_event_code ?? null;
  if (testCode) body.test_event_code = testCode;

  const url =
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelGroup.pixel_id)}` +
    `/events?access_token=${encodeURIComponent(accessToken)}`;

  let attempts = 0;
  let lastError: string | null = null;
  while (attempts < META_CAPI_MAX_ATTEMPTS) {
    attempts += 1;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(META_CAPI_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = `Network error: ${(err as Error).message.slice(0, 200)}`;
      if (attempts < META_CAPI_MAX_ATTEMPTS) {
        await sleep(META_CAPI_BACKOFF_MS[attempts - 1] ?? 1000);
        continue;
      }
      return finish(false, "failed", null, null, null, [], attempts, lastError);
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const eventsReceived =
      typeof parsed.events_received === "number" ? parsed.events_received : null;
    const fbtraceId = typeof parsed.fbtrace_id === "string" ? parsed.fbtrace_id : null;
    const messages = Array.isArray(parsed.messages)
      ? (parsed.messages as unknown[]).map((m) => String(m).slice(0, 200))
      : [];
    const metaError = parsed.error as
      | { message?: unknown; code?: unknown }
      | undefined;
    const metaErrorText = metaError?.message
      ? `Meta error ${String(metaError.code ?? "?")}: ${String(metaError.message).slice(0, 200)}`
      : null;

    if (res.ok) {
      if ((eventsReceived ?? 0) >= 1) {
        return finish(true, "delivered", res.status, eventsReceived, fbtraceId, messages, attempts, null);
      }
      // HTTP 2xx but Meta took zero events — accepted transport, rejected
      // content. Not a delivery, and retrying the same payload will not help.
      return finish(false, "rejected", res.status, eventsReceived, fbtraceId, messages, attempts,
        metaErrorText ?? "Meta accepted the request but received 0 events.");
    }

    // 4xx (except 429) is permanent: bad token, bad pixel, bad payload.
    // Never retry forever (API spec §17.5).
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return finish(false, "rejected", res.status, eventsReceived, fbtraceId, messages, attempts,
        metaErrorText ?? `Meta rejected the event (HTTP ${res.status}).`);
    }

    // 429 / 5xx: transient — bounded retry.
    lastError = metaErrorText ?? `Meta returned HTTP ${res.status}.`;
    if (attempts < META_CAPI_MAX_ATTEMPTS) {
      await sleep(META_CAPI_BACKOFF_MS[attempts - 1] ?? 1000);
      continue;
    }
    return finish(false, "failed", res.status, eventsReceived, fbtraceId, messages, attempts, lastError);
  }
  return finish(false, "failed", null, null, null, [], attempts,
    lastError ?? "Meta delivery failed.");
}
