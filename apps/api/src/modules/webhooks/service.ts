/**
 * Outbound Webhook Management & Transactional Outbox Dispatcher (TAD §16, API Spec §18, Security §4.6 & §4.10).
 *
 * - Validates webhook URLs against SSRF rules at both registration time and delivery time.
 * - Signs outbound payloads with `STACKMATE-WEBHOOK-V1` HMAC-SHA256.
 * - Processes `outbox_events` with lease locking, bounded exponential backoff, and dead-letter handling.
 *
 * HONESTY (audit C-2 / decision D-6): outbound delivery is SIMULATED
 * unless the caller passes a real transport (see
 * `createRealWebhookTransport`). A simulated dispatch NEVER records
 * "delivered"/"processed" and never sets `delivered_at` — the touched
 * rows are recorded as status "simulated", and the batch result counts
 * them in `simulated`, not `delivered`, so no report, export, or UI
 * can mistake a simulation for a real delivery. Meta CAPI dispatch is
 * simulated UNLESS the caller passes a `capiDeliver` function
 * (Batch 4, modules/tracking/capi.ts — Worker E): with it the
 * tracking event is really delivered and recorded "processed"; without
 * it the tracking event is marked "simulated" with no delivery
 * attempt and no `delivered_at`.
 *
 * NOTE (migration remainder): "simulated" is not yet in the
 * `tracking_events` / `outbox_events` / `webhook_deliveries` status
 * CHECKs nor in the store's status unions — migration 0014 must add
 * it (see the audit fix report). Until then the assignments below go
 * through `markSimulated`, which types the write as `string`; the
 * runtime value is already "simulated".
 */
import { randomUUID } from "node:crypto";
import { RegisterWebhookEndpointSchema } from "../../../../../packages/contracts/src/index.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  randomOpaqueToken,
  signOutboundWebhookPayload,
  validateSafeExternalUrlAsync,
} from "../../platform/crypto/index.ts";
import type {
  OutboxEventRecord,
  StackMateDataStore,
  TrackingConfigRecord,
  TrackingEventRecord,
  WebhookEndpointRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export async function registerWebhookEndpointByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  config: {
    encryptionKey: string;
    keyVersion: string;
    allowHttpLocal?: boolean;
    requestId: string;
  }
): Promise<{
  endpoint: Omit<WebhookEndpointRecord, "secret_ciphertext">;
  raw_signing_secret_once: string;
}> {
  assertStaffPermission(actor, "integrations.manage");
  const input = RegisterWebhookEndpointSchema.parse(rawInput);

  // SSRF validation at registration time (M-3): sync checks + DNS
  // resolution with a re-check of every resolved address.
  await validateSafeExternalUrlAsync(input.url, config.allowHttpLocal ?? false);

  return store.withTransaction((state) => {
    const endpointId = randomUUID();
    const secretKeyId = randomOpaqueToken("whsec_key", 10);
    const rawSecret = randomOpaqueToken("whsec", 28);
    const ciphertext = encryptSecretAtRest(
      rawSecret,
      config.encryptionKey,
      config.keyVersion,
      `webhook_endpoints:${endpointId}`
    );

    const endpoint: WebhookEndpointRecord = {
      id: endpointId,
      integrated_site_id: input.integrated_site_id ?? null,
      url: input.url,
      description: input.description,
      subscribed_events: [...input.subscribed_events],
      status: "active",
      secret_key_id: secretKeyId,
      secret_ciphertext: ciphertext,
      key_version: config.keyVersion,
      created_at: new Date().toISOString(),
    };
    state.webhook_endpoints.push(endpoint);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.registered",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: "success",
      request_id: config.requestId,
      changes: { url: endpoint.url, subscribed_events: endpoint.subscribed_events },
    });

    const { secret_ciphertext: _, ...safeEndpoint } = endpoint;
    return {
      endpoint: safeEndpoint,
      raw_signing_secret_once: rawSecret,
    };
  });
}

/**
 * Delete a webhook endpoint (hard delete + audit).
 *
 * The endpoint's deliveries are removed from state in the same
 * transaction: Postgres would cascade-delete them through the
 * `webhook_deliveries.webhook_endpoint_id` FK anyway, and leaving
 * them in state would make persistStateDiff re-insert orphaned rows
 * against that FK (500 on the next persist). The endpoint secrets
 * cascade the same way (FK on `webhook_endpoint_secrets`); they are
 * folded into the endpoint record in state, so deleting the record
 * removes them. `outbox_events` stay — they carry no FK to the
 * endpoint, so the dispatch history survives the delete.
 */
export async function deleteWebhookEndpointByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  endpointId: string,
  requestId: string
): Promise<Omit<WebhookEndpointRecord, "secret_ciphertext">> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const endpoint = state.webhook_endpoints.find((ep) => ep.id === endpointId);
    if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
    state.webhook_endpoints = state.webhook_endpoints.filter((ep) => ep.id !== endpointId);
    state.webhook_deliveries = state.webhook_deliveries.filter(
      (d) => d.webhook_endpoint_id !== endpointId
    );

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.deleted",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: "success",
      request_id: requestId,
      changes: { url: endpoint.url, description: endpoint.description },
    });

    const { secret_ciphertext: _, ...safeEndpoint } = endpoint;
    return safeEndpoint;
  });
}

/**
 * Shared test-delivery transport (E-06): performs ONE synthetic
 * `webhook.test` delivery against an endpoint — outbox row, SSRF-checked
 * fetch, delivery row — WITHOUT the audit row. The admin wrapper
 * (`testWebhookEndpointByAdmin`, staff actor) and the S2S wrapper
 * (`testWebhookForSite`, integration actor) each add their own audit
 * row afterwards, so the same delivery cannot be audited twice and the
 * actor always matches the trust boundary that called it.
 */
async function deliverWebhookTestDelivery(
  store: StackMateDataStore,
  endpoint: WebhookEndpointRecord,
  config: {
    encryptionKey: string;
    allowHttpLocal?: boolean;
  }
): Promise<{
  endpoint_id: string;
  delivery_id: string;
  event_type: string;
  http_status: number | null;
  delivered: boolean;
  error: string | null;
}> {
  // SSRF validation at test time, same as registration/delivery.
  await validateSafeExternalUrlAsync(endpoint.url, config.allowHttpLocal ?? false);
  const secret = decryptSecretAtRest(
    endpoint.secret_ciphertext,
    config.encryptionKey,
    `webhook_endpoints:${endpoint.id}`
  );

  const deliveryId = `whd_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const tsSec = Math.floor(Date.now() / 1000);
  // webhook_deliveries.event_id is a UUID FK to outbox_events(id), so the
  // test event needs a real outbox row. The UUID is generated up front
  // (it goes into the delivered payload). The outbox row is written in
  // its OWN transaction BEFORE the fetch: the store persists delivery
  // rows before outbox rows inside a single diff, so a delivery recorded
  // in the same transaction as its outbox row would violate the FK
  // (found by the Batch 1 repro, 2026-11-15). The row is marked
  // delivered up front: it represents the synthetic test event itself,
  // whose outcome is recorded separately in webhook_deliveries; the
  // dispatcher never picks it up again.
  const testEventId = randomUUID();
  const nowIso = new Date().toISOString();
  const bodyObj = {
    id: testEventId,
    type: "webhook.test",
    created_at: nowIso,
    api_version: "v1",
    delivery_id: deliveryId,
    data: { endpoint_id: endpoint.id, message: "StackMate webhook test delivery." },
  };
  const rawBody = JSON.stringify(bodyObj);
  await store.withTransaction((state) => {
    state.outbox_events.push({
      id: testEventId,
      event_key: `webhook_test:${deliveryId}`,
      event_type: "webhook.test",
      aggregate_type: "webhook_endpoint",
      aggregate_id: endpoint.id,
      payload: bodyObj,
      status: "delivered",
      attempt_count: 1,
      available_at: nowIso,
      locked_until: null,
      locked_by: null,
      last_error_code: null,
      processed_at: nowIso,
      created_at: nowIso,
    });
  });
  const { signatureHeader } = signOutboundWebhookPayload(tsSec, deliveryId, rawBody, secret);

  let httpStatus: number | null = null;
  let error: string | null = null;
  try {
    // Real fetch, SSRF-checked incl. redirects (M-3) — same helper the
    // dispatcher transport uses, so a test delivery cannot be smuggled
    // to a private range by a redirect either.
    const res = await fetchWithSsrfCheckedRedirects(
      endpoint.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StackMate-Event": "webhook.test",
          "X-StackMate-Delivery": deliveryId,
          "X-StackMate-Timestamp": String(tsSec),
          "X-StackMate-Key-Id": endpoint.secret_key_id,
          "X-StackMate-Signature": signatureHeader,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      },
      config.allowHttpLocal ?? false
    );
    httpStatus = res.status;
  } catch (err) {
    error = (err as Error).message.slice(0, 200);
  }

  const delivered = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
  const doneIso = new Date().toISOString();
  await store.withTransaction((state) => {
    // Record the failure reason on the synthetic test event, if any.
    if (!delivered) {
      const testEvent = state.outbox_events.find((e) => e.id === testEventId);
      if (testEvent) testEvent.last_error_code = error;
    }
    state.webhook_deliveries.push({
      id: randomUUID(),
      webhook_endpoint_id: endpoint.id,
      event_id: testEventId,
      delivery_id: deliveryId,
      status: delivered ? "delivered" : "failed",
      attempt_count: 1,
      last_http_status: httpStatus,
      delivered_at: delivered ? doneIso : null,
    });
  });

  return {
    endpoint_id: endpoint.id,
    delivery_id: deliveryId,
    event_type: "webhook.test",
    http_status: httpStatus,
    delivered,
    error,
  };
}

export async function testWebhookEndpointByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  endpointId: string,
  config: {
    encryptionKey: string;
    allowHttpLocal?: boolean;
    requestId: string;
  }
): Promise<{
  endpoint_id: string;
  delivery_id: string;
  event_type: string;
  http_status: number | null;
  delivered: boolean;
  error: string | null;
}> {
  assertStaffPermission(actor, "integrations.manage");
  const endpoint = store.state.webhook_endpoints.find((ep) => ep.id === endpointId);
  if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
  if (endpoint.status !== "active") {
    throw new AppError("CONFLICT", `Webhook endpoint is '${endpoint.status}'.`, 409);
  }
  const result = await deliverWebhookTestDelivery(store, endpoint, config);
  await store.withTransaction((state) => {
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.tested",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: result.delivered ? "success" : "failed",
      request_id: config.requestId,
      // Write-time identity (fix batch #2): the tested row carries no
      // URL otherwise, so after the endpoint is deleted the audit
      // resolver could never name it. The URL is public identifier
      // data, never a secret.
      changes: {
        url: endpoint.url,
        delivery_id: result.delivery_id,
        http_status: result.http_status,
        delivered: result.delivered,
      },
    });
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* E-04: webhook secret rotation (API §18.6; PRD §16.2)               */
/* E-06: S2S webhook test (API §15, scope webhooks.test)              */
/* E-17: webhook endpoint edit (PRD §16; coverage matrix P2)          */
/* ------------------------------------------------------------------ */

/**
 * Rotate a webhook endpoint's signing secret (E-04), mirroring the
 * site-credential rotate pattern: a fresh key id + secret are generated,
 * the new secret is encrypted at rest, and the new secret value is
 * returned EXACTLY ONCE — the caller must show it to staff and never
 * store it. The old secret is revoked (the Drizzle persist layer marks
 * non-current `webhook_endpoint_secrets` rows `revoked`).
 *
 * RETIRING-WINDOW GAP (honest limitation): API §18.6 asks for an
 * overlapping active/retiring window, and the secrets table HAS a
 * `retiring` status — but the endpoint record carries a single secret
 * and the dispatcher signs with `endpoint.secret_ciphertext` only, so
 * an old secret kept `retiring` could never verify a delivery today.
 * A true overlap window needs dispatcher support for two active
 * secrets (follow-up, not in this batch). Until then rotation is
 * immediate: the old secret stops verifying as soon as this call
 * persists. The returned `previous_key_id` names the revoked secret
 * for the audit trail.
 */
export async function rotateWebhookSecret(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  webhookId: string,
  config: {
    encryptionKey: string;
    keyVersion: string;
    requestId: string;
  }
): Promise<{
  endpoint: Omit<WebhookEndpointRecord, "secret_ciphertext">;
  raw_signing_secret_once: string;
  previous_key_id: string;
  rotated_at: string;
}> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const endpoint = state.webhook_endpoints.find((ep) => ep.id === webhookId);
    if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
    if (endpoint.status === "revoked") {
      throw new AppError("CONFLICT", "Webhook endpoint is revoked.", 409);
    }
    const previousKeyId = endpoint.secret_key_id;
    const newKeyId = randomOpaqueToken("whsec_key", 10);
    const rawSecret = randomOpaqueToken("whsec", 28);
    endpoint.secret_key_id = newKeyId;
    endpoint.secret_ciphertext = encryptSecretAtRest(
      rawSecret,
      config.encryptionKey,
      config.keyVersion,
      `webhook_endpoints:${endpoint.id}`
    );
    endpoint.key_version = config.keyVersion;
    const rotatedAt = new Date().toISOString();

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.secret_rotated",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: "success",
      request_id: config.requestId,
      changes: { url: endpoint.url, previous_key_id: previousKeyId, new_key_id: newKeyId },
    });

    const { secret_ciphertext: _, ...safeEndpoint } = endpoint;
    return {
      endpoint: safeEndpoint,
      raw_signing_secret_once: rawSecret,
      previous_key_id: previousKeyId,
      rotated_at: rotatedAt,
    };
  });
}

/**
 * Update a webhook endpoint's URL / description / subscribed events
 * (E-17). The signing secret is NEVER touched here — a URL or
 * subscription correction must not rotate the secret or lose delivery
 * history (that was the whole cost of the old delete + re-register
 * path). A body that changes nothing is a 422. The URL is re-validated
 * against the SSRF rules, same as registration.
 *
 * Dual-key note: `subscribed_events` / `subscribedEvents` are both
 * accepted and normalized here.
 */
export async function updateWebhookEndpoint(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  webhookId: string,
  rawInput: unknown,
  config: {
    allowHttpLocal?: boolean;
    requestId: string;
  }
): Promise<Omit<WebhookEndpointRecord, "secret_ciphertext">> {
  assertStaffPermission(actor, "integrations.manage");
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const nextUrl = typeof raw.url === "string" ? raw.url : undefined;
  const nextDescription =
    typeof raw.description === "string" ? raw.description : undefined;
  const nextEventsRaw =
    raw.subscribed_events !== undefined
      ? raw.subscribed_events
      : raw.subscribedEvents !== undefined
        ? raw.subscribedEvents
        : undefined;
  if (nextUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(nextUrl);
    } catch {
      throw new AppError("VALIDATION_ERROR", "url must be a valid URL.", 422);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new AppError("VALIDATION_ERROR", "url must use http or https.", 422);
    }
  }
  if (nextDescription !== undefined) {
    const trimmed = nextDescription.trim();
    if (trimmed.length < 2 || trimmed.length > 160) {
      throw new AppError(
        "VALIDATION_ERROR",
        "description must be 2–160 characters.",
        422
      );
    }
  }
  let nextEvents: string[] | undefined;
  if (nextEventsRaw !== undefined) {
    if (
      !Array.isArray(nextEventsRaw) ||
      nextEventsRaw.length === 0 ||
      nextEventsRaw.some(
        (e) => typeof e !== "string" || e.trim().length < 3 || e.trim().length > 80
      )
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "subscribed_events must be a non-empty array of event names (3–80 chars).",
        422
      );
    }
    nextEvents = (nextEventsRaw as string[]).map((e) => e.trim());
  }
  if (nextUrl === undefined && nextDescription === undefined && nextEvents === undefined) {
    throw new AppError("VALIDATION_ERROR", "Nothing to update.", 422);
  }

  // SSRF re-validation of the new URL happens BEFORE the transaction,
  // like registration — a blocked URL must not write anything.
  if (nextUrl !== undefined) {
    await validateSafeExternalUrlAsync(nextUrl, config.allowHttpLocal ?? false);
  }

  return store.withTransaction((state) => {
    const endpoint = state.webhook_endpoints.find((ep) => ep.id === webhookId);
    if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
    const changes: Record<string, unknown> = {};
    if (nextUrl !== undefined && nextUrl !== endpoint.url) {
      endpoint.url = nextUrl;
      changes.url = nextUrl;
    }
    if (nextDescription !== undefined && nextDescription.trim() !== endpoint.description) {
      endpoint.description = nextDescription.trim();
      changes.description = endpoint.description;
    }
    if (
      nextEvents !== undefined &&
      JSON.stringify([...nextEvents].sort()) !==
        JSON.stringify([...endpoint.subscribed_events].sort())
    ) {
      endpoint.subscribed_events = [...nextEvents];
      changes.subscribed_events = [...nextEvents];
    }
    if (Object.keys(changes).length === 0) {
      throw new AppError("VALIDATION_ERROR", "Nothing to update.", 422);
    }
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.updated",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: "success",
      request_id: config.requestId,
      changes,
    });
    const { secret_ciphertext: _, ...safeEndpoint } = endpoint;
    return safeEndpoint;
  });
}

/**
 * S2S webhook test for one integrated site (E-06): the route
 * `POST /api/v1/integrations/sites/{siteKey}/webhook-test` (Worker A2)
 * authenticates the caller first with the signed-server HMAC scope
 * `webhooks.test`; this service then tests every ACTIVE endpoint the
 * site owns, reusing the admin test transport. The audit actor is
 * `integration` (the site), not staff — the trust boundary is the
 * site's own HMAC credential.
 */
export async function testWebhookForSite(
  store: StackMateDataStore,
  siteKey: string,
  config: {
    encryptionKey: string;
    allowHttpLocal?: boolean;
  }
): Promise<{
  site_id: string;
  site_key: string;
  results: Array<{
    endpoint_id: string;
    delivery_id: string;
    event_type: string;
    http_status: number | null;
    delivered: boolean;
    error: string | null;
  }>;
}> {
  const site = store.state.integrated_sites.find((s) => s.site_key === siteKey);
  if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
  if (site.status !== "active") {
    throw new AppError("UNAUTHORIZED", `Integrated site is '${site.status}'.`, 401);
  }
  const endpoints = store.state.webhook_endpoints.filter(
    (ep) => ep.integrated_site_id === site.id && ep.status === "active"
  );
  if (endpoints.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "No active webhook endpoint exists for this site.",
      404
    );
  }
  const results = [];
  for (const endpoint of endpoints) {
    const result = await deliverWebhookTestDelivery(store, endpoint, config);
    await store.withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "integration",
        integrated_site_id: site.id,
        action: "webhooks.endpoint.tested_by_site",
        resource_type: "webhook_endpoint",
        resource_id: endpoint.id,
        outcome: result.delivered ? "success" : "failed",
        request_id: `s2s:webhook-test:${site.site_key}`,
        changes: {
          url: endpoint.url,
          delivery_id: result.delivery_id,
          http_status: result.http_status,
          delivered: result.delivered,
        },
      });
    });
    results.push(result);
  }
  return { site_id: site.id, site_key: site.site_key, results };
}

/**
 * Manual replay of a dead-lettered outbox event (API Spec §18.4): the
 * SAME event ID is re-queued for delivery with a fresh attempt budget.
 * Only dead_letter events can be replayed — replaying a delivered or
 * pending event would risk duplicate side effects at the receiver.
 */
export async function replayOutboxEventByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  eventId: string,
  requestId: string
): Promise<OutboxEventRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const event = state.outbox_events.find((e) => e.id === eventId);
    if (!event) throw new AppError("NOT_FOUND", "Outbox event not found.", 404);
    if (event.status !== "dead_letter") {
      throw new AppError(
        "CONFLICT",
        `Only dead-lettered events can be replayed (current status: '${event.status}').`,
        409
      );
    }
    event.status = "pending";
    event.attempt_count = 0;
    event.available_at = new Date().toISOString();
    event.locked_until = null;
    event.locked_by = null;
    event.last_error_code = null;
    event.processed_at = null;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.outbox_event.replayed",
      resource_type: "outbox_event",
      resource_id: event.id,
      outcome: "success",
      request_id: requestId,
      changes: { event_type: event.event_type },
    });
    return event;
  });
}

export type WebhookTransportFn = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number }>;

const defaultSimulatedTransport: WebhookTransportFn = async () => ({ status: 200 });

/**
 * D-6: record a row as simulated, never delivered/processed.
 * Typed as `{ status: string }` on purpose — the store's status
 * unions and the DB CHECKs gain 'simulated' in migration 0015 (see
 * module header); the runtime value written here is already
 * "simulated". (A generic `<T extends { status: string }>` would not
 * compile: "simulated" is not assignable to T["status"].)
 */
export function markSimulated(row: { status: string }): void {
  row.status = "simulated";
}

// -- DNS-over-HTTPS + delivery-time SSRF re-check (audit M-3) -------------
// `validateSafeExternalUrl` (platform/crypto) checks the URL string
// only: it cannot see non-dotted-decimal IP forms, and it never
// resolves the hostname, so a name that resolves to a private IP —
// or a redirect to one — slips past it. The delivery path therefore
// re-checks at fetch time: resolve via DoH, require every answer to
// be a public IP, and follow redirects manually, re-validating each
// hop. Fails CLOSED: an unresolvable host or a failed DNS lookup
// aborts the delivery (retry/dead-letter), it never delivers blind.
//
// Residual: a DNS rebinding between this check and the fetch (a
// sub-second window) cannot be closed with `fetch` on Workers —
// closing it fully needs resolved-IP dialing, which `fetch` does not
// offer. The check closes the static-bypass and redirect holes,
// which is what the audit required.

export interface DohAnswer {
  data: string;
  type: number;
}

/** DNS-over-HTTPS lookup via Cloudflare's dns-json API. Throws 503 when DNS is unreachable. */
export async function queryDnsOverHttps(
  name: string,
  type: "A" | "AAAA" | "TXT"
): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new AppError(
      "TEMPORARY_VALIDATION_UNAVAILABLE",
      `DNS lookup for '${name}' failed: ${(err as Error).message.slice(0, 120)}`,
      503
    );
  }
  if (!res.ok) {
    throw new AppError(
      "TEMPORARY_VALIDATION_UNAVAILABLE",
      `DNS lookup for '${name}' returned HTTP ${res.status}.`,
      503
    );
  }
  const body = (await res.json()) as {
    Answer?: Array<{ data?: string; type?: number }>;
  };
  return (body.Answer ?? []).map((a) => ({
    data: String(a.data ?? ""),
    type: Number(a.type ?? 0),
  }));
}

function isNonPublicIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918 172.16.0.0/12
    (a === 192 && b === 168) || // RFC 1918 192.168.0.0/16
    (a === 192 && b === 0) || // IANA special 192.0.0.0/24
    (a === 198 && b === 18) || // benchmarking 198.18.0.0/15
    (a === 198 && b === 51 && octets[2] === 100) || // TEST-NET-2 198.51.100.0/24
    (a === 203 && b === 0 && octets[2] === 113) || // TEST-NET-3 203.0.113.0/24
    a >= 224 // multicast 224/4 + reserved 240/4
  );
}

/** True when an IP literal is loopback / private / link-local / CGNAT / metadata / multicast / reserved / documentation. Covers IPv4, IPv6, and IPv4-mapped/embedded IPv6. */
export function isNonPublicIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])] as [
      number,
      number,
      number,
      number,
    ];
    if (octets.some((o) => o < 0 || o > 255)) return true;
    // TEST-NET-1 192.0.2.0/24 (documentation — no real receiver lives there).
    if (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) return true;
    return isNonPublicIpv4(octets);
  }
  if (!v.includes(":")) return true; // not an IP literal at all — fail closed
  // IPv4-mapped ::ffff:a.b.c.d — judge the embedded IPv4 address.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v);
  if (mapped) return isNonPublicIp(mapped[1]!);
  // 6to4 2002:<v4>:: — judge the embedded IPv4 address.
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(v);
  if (sixToFour) {
    const hi = Number.parseInt(sixToFour[1]!, 16);
    const lo = Number.parseInt(sixToFour[2]!, 16);
    return isNonPublicIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  // Teredo 2001:0:<v4-inverted> — judge the embedded (bit-inverted) IPv4 address.
  const teredo = /^2001:0:[0-9a-f]{1,4}:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (teredo) {
    const hi = Number.parseInt(teredo[1]!, 16) ^ 0xffff;
    const lo = Number.parseInt(teredo[2]!, 16) ^ 0xffff;
    return isNonPublicIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return (
    v === "::1" || // loopback
    v === "::" || // unspecified
    v.startsWith("fe8") ||
    v.startsWith("fe9") ||
    v.startsWith("fea") ||
    v.startsWith("feb") || // link-local fe80::/10
    v.startsWith("fc") ||
    v.startsWith("fd") || // unique-local fc00::/7
    v.startsWith("2001:db8:") // documentation 2001:db8::/32
  );
}

/**
 * Delivery-time DNS re-check (M-3): resolve the hostname via DoH and
 * require EVERY returned address to be public. IP literals are
 * checked directly (no DNS involved). Fails closed — throws
 * SSRF_BLOCKED on a private answer, 503 when DNS is unreachable or
 * returns no addresses. `allowHttpLocal` skips the check entirely:
 * local/dev deliveries are explicitly allowed by config.
 */
export async function assertHostnameResolvesToPublicIp(
  hostname: string,
  allowHttpLocal = false
): Promise<void> {
  const host = hostname.toLowerCase();
  if (allowHttpLocal) return;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    if (isNonPublicIp(host)) {
      throw new AppError("SSRF_BLOCKED", `Destination IP '${host}' is not public.`, 400);
    }
    return;
  }
  const [a, aaaa] = await Promise.all([
    queryDnsOverHttps(host, "A"),
    queryDnsOverHttps(host, "AAAA"),
  ]);
  const ips = [...a, ...aaaa]
    .map((r) => r.data.replace(/"/g, "").trim())
    .filter(Boolean);
  if (ips.length === 0) {
    throw new AppError(
      "TEMPORARY_VALIDATION_UNAVAILABLE",
      `DNS lookup for '${host}' returned no addresses.`,
      503
    );
  }
  for (const ip of ips) {
    if (isNonPublicIp(ip)) {
      throw new AppError(
        "SSRF_BLOCKED",
        `Destination host '${host}' resolves to non-public IP '${ip}'.`,
        400
      );
    }
  }
}

const MAX_DELIVERY_REDIRECTS = 5;

/**
 * POST with SSRF-checked redirects (M-3): follows 3xx `Location`
 * targets manually, re-validating each hop with the static rules
 * AND the DNS re-check, so a redirect can never smuggle a delivery
 * to a private range. The same signal budgets the whole hop chain.
 */
export async function fetchWithSsrfCheckedRedirects(
  url: string,
  init: RequestInit,
  allowHttpLocal = false
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_DELIVERY_REDIRECTS; hop += 1) {
    // One call now does both layers: sync checks + DNS re-check of the
    // (possibly redirected) host, so a redirect can never smuggle a
    // delivery to a private range.
    await validateSafeExternalUrlAsync(current, allowHttpLocal);
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    if (res.status < 300 || res.status >= 400 || hop === MAX_DELIVERY_REDIRECTS) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new AppError("SSRF_BLOCKED", "Too many redirects.", 400);
}

/**
 * A REAL webhook transport: performs the HTTP delivery with a 10s
 * timeout and SSRF-checked redirects (M-3). This is the transport
 * the cron call site (app.ts) passes to enable real delivery. Until
 * it is wired in, the dispatcher runs simulated (no transport) and
 * records "simulated" (D-6).
 */
export function createRealWebhookTransport(options?: {
  allowHttpLocal?: boolean;
  timeoutMs?: number;
}): WebhookTransportFn {
  const allowHttpLocal = options?.allowHttpLocal ?? false;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  return async ({ url, headers, body }) => {
    const res = await fetchWithSsrfCheckedRedirects(
      url,
      {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      },
      allowHttpLocal
    );
    return { status: res.status };
  };
}

/**
 * Claims pending `outbox_events` using a lease lock, dispatches matching webhooks & Meta CAPI events,
 * and handles retries / dead-letter transitions without holding a database transaction open during HTTP calls.
 *
 * SERVICE CONTRACT (C-2 / D-6) — what the cron call site (app.ts) can rely on:
 * - `options.transport` omitted → SIMULATED dispatch: no network call
 *   is made (the default transport returns 200 without fetching).
 *   Every touched row is recorded as status "simulated" (never
 *   "delivered"/"processed", `delivered_at` stays null) and the result
 *   counts the event in `simulated`, not `delivered`.
 * - `options.transport` given (e.g. `createRealWebhookTransport()`)
 *   → real HTTP delivery: a 2xx records "delivered" + `delivered_at`
 *   and counts in `delivered`.
 * - A non-CAPI event with NO subscribed active endpoints is "skipped"
 *   (Q3, 2026-11-22): nothing received it, so it must never be
 *   recorded "delivered" — the endpoint loop simply runs zero times.
 *   The outbox row is terminal "skipped" (`delivered_at` stays null —
 *   no delivery row exists at all), the audit action is
 *   `webhooks.outbox_event.skipped_no_subscribers`, and the result
 *   counts it in `skipped`, never in `delivered` / `retrying` /
 *   `dead_lettered`. CAPI events never take this branch — they are
 *   always simulated (see below).
 * - `tracking.meta_capi.dispatch` events are simulated UNLESS the
 *   caller passes `options.capiDeliver` (Batch 4's
 *   `deliverMetaCapiEvent`, modules/tracking/capi.ts — Worker E
 *   exports it, app.ts wires it in): with it, the tracking event is
 *   really delivered and recorded "processed" with `delivered_at`;
 *   without it the event is marked "simulated" with no delivery
 *   attempt and no `delivered_at` — and so is the outbox row, the
 *   audit row and the result counts, even when a real webhook
 *   transport is configured.
 * - Every terminal outcome (delivered / simulated / dead-letter) writes
 *   an audit row (M-14); retries write none — the final outcome owns
 *   the row.
 * - B-02: delivery runs with bounded concurrency (default 5 in
 *   flight), and each event's delivery rows + terminal outbox/audit
 *   writes collapse into ONE transaction per event (previously one
 *   transaction per delivery row + one terminal transaction, each
 *   re-running the full combined load). The result carries
 *   `duration_ms` and the tick is logged, so overlap is observable.
 */
export interface CapiDeliveryInput {
  /** First enabled Meta pixel group for the event's site, or null. */
  pixelGroup: TrackingConfigRecord | null;
  event: TrackingEventRecord;
}

export interface CapiDeliveryResult {
  delivered: boolean;
  status: string;
  diagnostics?: unknown;
}

/** Batch 4 Meta CAPI delivery (modules/tracking/capi.ts). */
export type CapiDeliverFn = (
  input: CapiDeliveryInput
) => Promise<CapiDeliveryResult>;

export async function processTransactionalOutboxBatch(
  store: StackMateDataStore,
  options: {
    workerId?: string;
    batchSize?: number;
    maxAttempts?: number;
    encryptionKey: string;
    allowHttpLocal?: boolean;
    transport?: WebhookTransportFn;
    /** Batch 4 Meta CAPI delivery; omitted → CAPI stays simulated. */
    capiDeliver?: CapiDeliverFn;
    /** Bounded concurrency for delivery attempts (B-02, default 5). */
    concurrency?: number;
  }
): Promise<{
  claimed: number;
  delivered: number;
  simulated: number;
  // Q3: events with no subscribed active endpoint — terminal
  // "skipped", counted apart from delivered / retrying / dead-lettered.
  skipped: number;
  retrying: number;
  dead_lettered: number;
  /** Wall time of the whole drain in ms (B-02 observability). */
  duration_ms: number;
}> {
  const startedAtMs = Date.now();
  const workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
  const batchSize = options.batchSize ?? 25;
  const maxAttempts = options.maxAttempts ?? 5;
  const simulated = options.transport === undefined;
  const transport = options.transport ?? defaultSimulatedTransport;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 10));

  // Step 1: Claim a batch with a lease.
  // C-05: on a DrizzleStore this is a REAL SQL claim
  // (UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED),
  // ordered by available_at, created_at — see
  // DrizzleStore.claimOutboxEvents). The in-memory fallback below is
  // NOT row-level locking: it filters the loaded state and relies on
  // the global writer advisory lock to serialise drains — two
  // concurrent drains serialize wholesale instead of splitting the
  // batch. The eligible set is ordered explicitly here too (the old
  // code relied on the load query's ordering).
  const drizzleStore = store as unknown as {
    claimOutboxEvents?: (
      batchSize: number,
      workerId: string
    ) => Promise<OutboxEventRecord[]>;
  };
  let claimedEvents: OutboxEventRecord[];
  if (typeof drizzleStore.claimOutboxEvents === "function") {
    claimedEvents = await drizzleStore.claimOutboxEvents(batchSize, workerId);
  } else {
    claimedEvents = await store.withTransaction((state) => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const leaseUntilIso = new Date(nowMs + 60 * 1000).toISOString();

      const eligible = state.outbox_events
        .filter(
          (ev) =>
            (ev.status === "pending" && new Date(ev.available_at).getTime() <= nowMs) ||
            (ev.status === "processing" &&
              ev.locked_until !== null &&
              new Date(ev.locked_until).getTime() <= nowMs)
        )
        .sort(
          (a, b) =>
            new Date(a.available_at).getTime() - new Date(b.available_at).getTime() ||
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )
        .slice(0, batchSize);

      for (const ev of eligible) {
        ev.status = "processing";
        ev.locked_by = workerId;
        ev.locked_until = leaseUntilIso;
        ev.attempt_count += 1;
      }
      return eligible.map((ev) => structuredClone(ev));
    });
  }

  type EventOutcome =
    | "delivered"
    | "simulated"
    | "skipped"
    | "retrying"
    | "dead_lettered";

  interface DeliveryOutcome {
    endpointId: string;
    deliveryId: string;
    httpStatus: number;
  }

  // Step 2: process remote side effects OUTSIDE the database
  // transaction, with bounded concurrency (B-02). Each event returns
  // its outcome; counters are aggregated after the pool drains, so no
  // shared mutable state is touched from concurrent tasks.
  async function processOne(ev: OutboxEventRecord): Promise<EventOutcome> {
    // D-6: a CAPI dispatch is simulated unless a real CAPI deliver
    // function was injected — even when a real webhook transport is
    // configured. `capiDelivered` flips only on a real delivery.
    let capiDelivered = false;
    let noSubscribers = false;
    const deliveries: DeliveryOutcome[] = [];
    try {
      if (ev.event_type === "tracking.meta_capi.dispatch") {
        if (options.capiDeliver) {
          // Batch 4 (Worker E): real Meta CAPI delivery. The pixel
          // group is resolved from the loaded state; the tracking
          // event row is updated in the terminal transaction below.
          // TODO (Worker E): modules/tracking/capi.ts must export
          // deliverMetaCapiEvent(env, pixelGroup, event) -> { delivered,
          // status, diagnostics }; app.ts passes it as `capiDeliver`.
          // Until then this branch is unreachable and CAPI stays
          // simulated (never recorded delivered).
          const track = store.state.tracking_events.find(
            (t) => t.id === ev.payload.tracking_event_id
          );
          if (!track) throw new Error("TRACKING_EVENT_NOT_FOUND");
          const pixelGroup =
            store.state.tracking_configurations.find(
              (tc) =>
                tc.integrated_site_id === track.integrated_site_id &&
                tc.provider === "meta" &&
                tc.status === "enabled"
            ) ?? null;
          const result = await options.capiDeliver({ pixelGroup, event: track });
          if (!result.delivered) {
            throw new Error(`CAPI_${result.status}`);
          }
          capiDelivered = true;
        }
        // Without capiDeliver: simulated — the terminal transaction
        // below marks the tracking event simulated, no delivery
        // attempt is counted and `delivered_at` stays null.
      } else {
        // Dispatch to subscribed active webhook endpoints
        const endpoints = store.state.webhook_endpoints.filter(
          (ep) =>
            ep.status === "active" &&
            (ep.subscribed_events.includes(ev.event_type) || ep.subscribed_events.includes("*"))
        );
        // Q3: with zero subscribers the loop below runs zero times and
        // the terminal block used to record "delivered" anyway — a
        // delivery that never happened. Mark it skipped instead (the
        // terminal block below); no delivery row is created, so no
        // delivered_at is recorded anywhere.
        if (endpoints.length === 0) noSubscribers = true;

        for (const ep of endpoints) {
          await validateSafeExternalUrlAsync(ep.url, options.allowHttpLocal ?? false);
          const secret = decryptSecretAtRest(
            ep.secret_ciphertext,
            options.encryptionKey,
            `webhook_endpoints:${ep.id}`
          );
          const deliveryId = `whd_${ev.id.replace(/-/g, "").slice(0, 16)}`;
          const tsSec = Math.floor(Date.now() / 1000);
          const bodyObj = {
            id: `evt_${ev.id.replace(/-/g, "").slice(0, 16)}`,
            type: ev.event_type,
            created_at: ev.created_at,
            api_version: "v1",
            delivery_id: deliveryId,
            data: ev.payload,
          };
          const rawBody = JSON.stringify(bodyObj);
          const { signatureHeader } = signOutboundWebhookPayload(
            tsSec,
            deliveryId,
            rawBody,
            secret
          );

          const res = await transport({
            url: ep.url,
            headers: {
              "Content-Type": "application/json",
              "X-StackMate-Event": ev.event_type,
              "X-StackMate-Delivery": deliveryId,
              "X-StackMate-Timestamp": String(tsSec),
              "X-StackMate-Key-Id": ep.secret_key_id,
              "X-StackMate-Signature": signatureHeader,
            },
            body: rawBody,
          });

          if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP_${res.status}`);
          }
          deliveries.push({ endpointId: ep.id, deliveryId, httpStatus: res.status });
        }
      }

      // B-02: ONE transaction per event — delivery rows + tracking
      // update + terminal outbox status + audit row together (was one
      // transaction per delivery row + one terminal transaction).
      const eventSimulated =
        ev.event_type === "tracking.meta_capi.dispatch" ? !capiDelivered : simulated;
      await store.withTransaction((state) => {
        if (ev.event_type === "tracking.meta_capi.dispatch") {
          const track = state.tracking_events.find(
            (t) => t.id === ev.payload.tracking_event_id
          );
          if (track) {
            if (capiDelivered) {
              track.status = "processed";
              track.delivery_attempts += 1;
              track.delivered_at = new Date().toISOString();
            } else {
              markSimulated(track);
            }
          }
        }
        for (const d of deliveries) {
          const existingDeliv = state.webhook_deliveries.find(
            (x) => x.webhook_endpoint_id === d.endpointId && x.delivery_id === d.deliveryId
          );
          const nowIso = new Date().toISOString();
          if (existingDeliv) {
            existingDeliv.attempt_count += 1;
            existingDeliv.last_http_status = d.httpStatus;
            if (simulated) {
              // D-6: a simulated 200 is not a delivery.
              markSimulated(existingDeliv);
              existingDeliv.delivered_at = null;
            } else {
              existingDeliv.status = "delivered";
              existingDeliv.delivered_at = nowIso;
            }
          } else {
            const row = {
              id: randomUUID(),
              webhook_endpoint_id: d.endpointId,
              event_id: ev.id,
              delivery_id: d.deliveryId,
              status: "delivered" as const,
              attempt_count: 1,
              last_http_status: d.httpStatus,
              delivered_at: nowIso as string | null,
            };
            if (simulated) {
              markSimulated(row);
              row.delivered_at = null;
            }
            state.webhook_deliveries.push(row);
          }
        }
        // Mark outbox event terminal: delivered (real), simulated, or
        // skipped (no subscribed active endpoints — Q3).
        const target = state.outbox_events.find((e) => e.id === ev.id);
        if (target) {
          if (noSubscribers) target.status = "skipped";
          else if (eventSimulated) markSimulated(target);
          else target.status = "delivered";
          target.locked_until = null;
          target.locked_by = null;
          target.processed_at = new Date().toISOString();
        }
        // M-14: the dispatch outcome is auditable (actor "system" —
        // the dispatcher, not a staff member; the worker id correlates).
        appendAuditLog(state, {
          actor_type: "system",
          action: noSubscribers
            ? "webhooks.outbox_event.skipped_no_subscribers"
            : eventSimulated
              ? "webhooks.outbox_event.simulated"
              : "webhooks.outbox_event.delivered",
          resource_type: "outbox_event",
          resource_id: ev.id,
          outcome: "success",
          request_id: `worker:${workerId}`,
          changes: noSubscribers
            ? { event_type: ev.event_type, reason: "no_active_subscribers" }
            : { event_type: ev.event_type },
        });
      });
      if (noSubscribers) return "skipped";
      if (eventSimulated) return "simulated";
      return "delivered";
    } catch (err) {
      const errorCode = (err as Error).message.slice(0, 80) || "DELIVERY_FAILED";
      let deadLettered = false;
      await store.withTransaction((state) => {
        const target = state.outbox_events.find((e) => e.id === ev.id);
        if (!target) return;
        target.locked_until = null;
        target.locked_by = null;
        target.last_error_code = errorCode;

        if (target.attempt_count >= maxAttempts) {
          target.status = "dead_letter";
          deadLettered = true;
          // M-14: a dead-lettered dispatch is auditable (failed outcome).
          appendAuditLog(state, {
            actor_type: "system",
            action: "webhooks.outbox_event.dead_lettered",
            resource_type: "outbox_event",
            resource_id: ev.id,
            outcome: "failed",
            request_id: `worker:${workerId}`,
            changes: {
              event_type: ev.event_type,
              error_code: errorCode,
              attempt_count: target.attempt_count,
            },
          });
        } else {
          target.status = "pending";
          const backoffMs = Math.min(300_000, 1000 * 2 ** target.attempt_count);
          target.available_at = new Date(Date.now() + backoffMs).toISOString();
        }
      });
      return deadLettered ? "dead_lettered" : "retrying";
    }
  }

  // Bounded-concurrency pool (B-02): `concurrency` workers pull from
  // the claimed list; a slow endpoint blocks one worker, not the tick.
  const outcomes: EventOutcome[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, claimedEvents.length) }, async () => {
    while (nextIndex < claimedEvents.length) {
      const ev = claimedEvents[nextIndex]!;
      nextIndex += 1;
      outcomes.push(await processOne(ev));
    }
  });
  await Promise.all(workers);

  const result = {
    claimed: claimedEvents.length,
    delivered: outcomes.filter((o) => o === "delivered").length,
    simulated: outcomes.filter((o) => o === "simulated").length,
    skipped: outcomes.filter((o) => o === "skipped").length,
    retrying: outcomes.filter((o) => o === "retrying").length,
    dead_lettered: outcomes.filter((o) => o === "dead_lettered").length,
    duration_ms: Date.now() - startedAtMs,
  };
  // B-02: tick observability — duration + counts on every tick (was:
  // only errors were logged, so overlap was invisible).
  console.info(
    `[stackmate-cron] outbox drain: claimed=${result.claimed} delivered=${result.delivered} ` +
      `simulated=${result.simulated} skipped=${result.skipped} retrying=${result.retrying} ` +
      `dead_lettered=${result.dead_lettered} duration_ms=${result.duration_ms}`
  );
  return result;
}
