/**
 * Outbound Webhook Management & Transactional Outbox Dispatcher (TAD §16, API Spec §18, Security §4.6 & §4.10).
 *
 * - Validates webhook URLs against SSRF rules at both registration time and delivery time.
 * - Signs outbound payloads with `STACKMATE-WEBHOOK-V1` HMAC-SHA256.
 * - Processes `outbox_events` with lease locking, bounded exponential backoff, and dead-letter handling.
 */
import { randomUUID } from "node:crypto";
import { RegisterWebhookEndpointSchema } from "../../../../../packages/contracts/src/index.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  randomOpaqueToken,
  signOutboundWebhookPayload,
  validateSafeExternalUrl,
} from "../../platform/crypto/index.ts";
import type {
  OutboxEventRecord,
  StackMateDataStore,
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

  // SSRF validation at registration time
  validateSafeExternalUrl(input.url, config.allowHttpLocal ?? false);

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
  // SSRF validation at test time, same as registration/delivery.
  validateSafeExternalUrl(endpoint.url, config.allowHttpLocal ?? false);
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
    const res = await fetch(endpoint.url, {
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
    });
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
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "webhooks.endpoint.tested",
      resource_type: "webhook_endpoint",
      resource_id: endpoint.id,
      outcome: delivered ? "success" : "failed",
      request_id: config.requestId,
      changes: { delivery_id: deliveryId, http_status: httpStatus, delivered },
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
 * Claims pending `outbox_events` using a lease lock, dispatches matching webhooks & Meta CAPI events,
 * and handles retries / dead-letter transitions without holding a database transaction open during HTTP calls.
 */
export async function processTransactionalOutboxBatch(
  store: StackMateDataStore,
  options: {
    workerId?: string;
    batchSize?: number;
    maxAttempts?: number;
    encryptionKey: string;
    allowHttpLocal?: boolean;
    transport?: WebhookTransportFn;
  }
): Promise<{
  claimed: number;
  delivered: number;
  retrying: number;
  dead_lettered: number;
}> {
  const workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
  const batchSize = options.batchSize ?? 25;
  const maxAttempts = options.maxAttempts ?? 5;
  const transport = options.transport ?? defaultSimulatedTransport;

  // Step 1: Claim batch with lease inside transaction (`FOR UPDATE SKIP LOCKED` semantics)
  const claimedEvents = await store.withTransaction((state) => {
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
      .slice(0, batchSize);

    for (const ev of eligible) {
      ev.status = "processing";
      ev.locked_by = workerId;
      ev.locked_until = leaseUntilIso;
      ev.attempt_count += 1;
    }
    return eligible.map((ev) => structuredClone(ev));
  });

  let delivered = 0;
  let retrying = 0;
  let deadLettered = 0;

  // Step 2: Process remote side effects OUTSIDE the database transaction
  for (const ev of claimedEvents) {
    try {
      if (ev.event_type === "tracking.meta_capi.dispatch") {
        // Mark tracking event processed
        await store.withTransaction((state) => {
          const track = state.tracking_events.find(
            (t) => t.id === ev.payload.tracking_event_id
          );
          if (track) {
            track.status = "processed";
            track.delivery_attempts += 1;
            track.delivered_at = new Date().toISOString();
          }
        });
      } else {
        // Dispatch to subscribed active webhook endpoints
        const endpoints = store.state.webhook_endpoints.filter(
          (ep) =>
            ep.status === "active" &&
            (ep.subscribed_events.includes(ev.event_type) || ep.subscribed_events.includes("*"))
        );

        for (const ep of endpoints) {
          validateSafeExternalUrl(ep.url, options.allowHttpLocal ?? false);
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

          await store.withTransaction((state) => {
            const existingDeliv = state.webhook_deliveries.find(
              (d) => d.webhook_endpoint_id === ep.id && d.delivery_id === deliveryId
            );
            const nowIso = new Date().toISOString();
            if (existingDeliv) {
              existingDeliv.status = "delivered";
              existingDeliv.attempt_count += 1;
              existingDeliv.last_http_status = res.status;
              existingDeliv.delivered_at = nowIso;
            } else {
              state.webhook_deliveries.push({
                id: randomUUID(),
                webhook_endpoint_id: ep.id,
                event_id: ev.id,
                delivery_id: deliveryId,
                status: "delivered",
                attempt_count: 1,
                last_http_status: res.status,
                delivered_at: nowIso,
              });
            }
          });
        }
      }

      // Mark outbox event delivered
      await store.withTransaction((state) => {
        const target = state.outbox_events.find((e) => e.id === ev.id);
        if (target) {
          target.status = "delivered";
          target.locked_until = null;
          target.locked_by = null;
          target.processed_at = new Date().toISOString();
        }
      });
      delivered += 1;
    } catch (err) {
      const errorCode = (err as Error).message.slice(0, 80) || "DELIVERY_FAILED";
      await store.withTransaction((state) => {
        const target = state.outbox_events.find((e) => e.id === ev.id);
        if (!target) return;
        target.locked_until = null;
        target.locked_by = null;
        target.last_error_code = errorCode;

        if (target.attempt_count >= maxAttempts) {
          target.status = "dead_letter";
          deadLettered += 1;
        } else {
          target.status = "pending";
          const backoffMs = Math.min(300_000, 1000 * 2 ** target.attempt_count);
          target.available_at = new Date(Date.now() + backoffMs).toISOString();
          retrying += 1;
        }
      });
    }
  }

  return {
    claimed: claimedEvents.length,
    delivered,
    retrying,
    dead_lettered: deadLettered,
  };
}
