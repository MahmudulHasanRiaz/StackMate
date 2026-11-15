/**
 * Centralized Meta Pixel & Conversions API (CAPI) Tracking Service (PRD §15, TAD §15, API Spec §17).
 *
 * Critical Security & Business Invariants:
 * 1. Meta CAPI access tokens are encrypted at rest (`AES-256-GCM`) and NEVER returned to clients.
 * 2. Browser and external server endpoints are strictly forbidden from submitting `Purchase` events
 *    (`403 PURCHASE_EVENT_FORBIDDEN`). Only verified payment approval inside StackMate can enqueue a `Purchase`.
 * 3. Events are deduplicated by `(integrated_site_id, event_name, event_id)`.
 * 4. PII fields (`email`, `phone`) are normalized and SHA-256 hashed server-side before CAPI dispatch.
 */
import { randomUUID } from "node:crypto";
import {
  ConfigureSiteTrackingSchema,
  IngestTrackingEventSchema,
} from "../../../../../packages/contracts/src/index.ts";
import {
  encryptSecretAtRest,
  sha256Hex,
} from "../../platform/crypto/index.ts";
import type {
  StackMateDataStore,
  TrackingConfigRecord,
  TrackingEventRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { normalizePhoneE164 } from "../customers/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export async function configureSiteTrackingByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  rawInput: unknown,
  config: { encryptionKey: string; keyVersion: string; requestId: string }
): Promise<Omit<TrackingConfigRecord, "access_token_ciphertext">> {
  assertStaffPermission(actor, "tracking.manage");
  const input = ConfigureSiteTrackingSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);

    const existing = state.tracking_configurations.find(
      (tc) => tc.integrated_site_id === siteId && tc.provider === "meta"
    );
    const nowIso = new Date().toISOString();
    const recordId = existing?.id ?? randomUUID();
    const ciphertext = encryptSecretAtRest(
      input.access_token,
      config.encryptionKey,
      config.keyVersion,
      `tracking_configurations:${recordId}`
    );

    let record: TrackingConfigRecord;
    if (existing) {
      existing.pixel_id = input.pixel_id;
      existing.access_token_ciphertext = ciphertext;
      existing.encryption_key_version = config.keyVersion;
      existing.test_event_code = input.test_event_code ?? null;
      existing.enabled_events = [...input.enabled_events];
      existing.status = input.status;
      existing.updated_at = nowIso;
      existing.rotated_at = nowIso;
      record = existing;
    } else {
      record = {
        id: recordId,
        integrated_site_id: siteId,
        provider: "meta",
        pixel_id: input.pixel_id,
        access_token_ciphertext: ciphertext,
        encryption_key_version: config.keyVersion,
        test_event_code: input.test_event_code ?? null,
        enabled_events: [...input.enabled_events],
        status: input.status,
        created_at: nowIso,
        updated_at: nowIso,
        rotated_at: nowIso,
      };
      state.tracking_configurations.push(record);
    }

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tracking.configuration.updated",
      resource_type: "tracking_configuration",
      resource_id: record.id,
      outcome: "success",
      request_id: config.requestId,
      changes: {
        site_id: siteId,
        pixel_id: record.pixel_id,
        enabled_events: record.enabled_events,
        status: record.status,
      },
    });

    const { access_token_ciphertext: _, ...safeConfig } = record;
    return safeConfig;
  });
}

export async function ingestExternalTrackingEvent(
  store: StackMateDataStore,
  siteKey: string,
  rawInput: unknown
): Promise<{
  accepted: boolean;
  deduplicated: boolean;
  tracking_event_id: string | null;
  status: string;
}> {
  const input = IngestTrackingEventSchema.parse(rawInput);

  // Non-negotiable invariant (Section 5 & API Spec §17.4): Browser/external callers CANNOT emit Purchase
  if (input.event_name === "Purchase") {
    throw new AppError(
      "PURCHASE_EVENT_FORBIDDEN",
      "Purchase events cannot be submitted by external clients; they are emitted exclusively after server-verified payment approval.",
      403
    );
  }

  return store.withTransaction((state) => {
    const site = state.integrated_sites.find(
      (s) => s.site_key === siteKey && s.status === "active"
    );
    if (!site) {
      throw new AppError("UNAUTHORIZED", "Active integrated site not found.", 401);
    }

    if (input.consent.status !== "granted") {
      return {
        accepted: false,
        deduplicated: false,
        tracking_event_id: null,
        status: "skipped_no_consent",
      };
    }

    const trackingCfg = state.tracking_configurations.find(
      (tc) => tc.integrated_site_id === site.id && tc.status === "enabled"
    );
    if (trackingCfg && !trackingCfg.enabled_events.includes(input.event_name)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Tracking event '${input.event_name}' is not enabled for this site.`,
        422
      );
    }

    const duplicate = state.tracking_events.find(
      (te) =>
        te.integrated_site_id === site.id &&
        te.event_name === input.event_name &&
        te.event_id === input.event_id
    );
    if (duplicate) {
      return {
        accepted: true,
        deduplicated: true,
        tracking_event_id: duplicate.id,
        status: duplicate.status,
      };
    }

    // Hash PII fields server-side per Meta CAPI specification (never persist raw email/phone in tracking logs)
    const hashedUserData: Record<string, string | undefined> = {
      em: input.user_data?.email
        ? sha256Hex(input.user_data.email.trim().toLowerCase())
        : undefined,
      ph: input.user_data?.phone
        ? sha256Hex((normalizePhoneE164(input.user_data.phone) ?? "").replace(/\D/g, ""))
        : undefined,
      fbp: input.user_data?.fbp,
      fbc: input.user_data?.fbc,
    };

    const nowIso = new Date().toISOString();
    const eventRecord: TrackingEventRecord = {
      id: randomUUID(),
      integrated_site_id: site.id,
      event_name: input.event_name,
      event_id: input.event_id,
      event_time: input.event_time,
      event_source_url: input.event_source_url,
      order_id: null,
      consent_state: input.consent.status,
      consent_policy_version: input.consent.policy_version,
      sanitized_payload: {
        action_source: input.action_source,
        user_data_hashes: hashedUserData,
        custom_data: input.custom_data ?? {},
      },
      status: "queued",
      delivery_attempts: 0,
      delivered_at: null,
      created_at: nowIso,
    };
    state.tracking_events.push(eventRecord);

    state.outbox_events.push({
      id: randomUUID(),
      event_key: `meta_capi.event:${eventRecord.id}`,
      aggregate_type: "tracking_event",
      aggregate_id: eventRecord.id,
      event_type: "tracking.meta_capi.dispatch",
      payload: {
        tracking_event_id: eventRecord.id,
        event_name: eventRecord.event_name,
        event_id: eventRecord.event_id,
      },
      status: "pending",
      attempt_count: 0,
      available_at: nowIso,
      locked_until: null,
      locked_by: null,
      last_error_code: null,
      created_at: nowIso,
      processed_at: null,
    });

    return {
      accepted: true,
      deduplicated: false,
      tracking_event_id: eventRecord.id,
      status: eventRecord.status,
    };
  });
}
