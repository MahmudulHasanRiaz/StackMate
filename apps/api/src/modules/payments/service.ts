/**
 * Manual & Provider-Abstracted Payment Engine (PRD §11, TAD §12, Database Design §13, API Spec §11 & §14).
 *
 * Invariants enforced:
 * 1. Customer payment submission NEVER marks an order paid or issues a license.
 * 2. Transaction ID required/optional/disabled policy is enforced per payment method.
 * 3. Bank transfer rails (`npsb`, `beftn`, `rtgs`) are validated against the method's configured allowlist.
 * 4. Staff approval executes atomically in a single serialized transaction (`withTransaction`),
 *    preventing double-settlement race conditions (`409 PAYMENT_SUBMISSION_ALREADY_REVIEWED`),
 *    triggering fulfillment (subscriptions + licenses for software products; service job intent for
 *    future digital_service items per ADR-0003), and enqueueing a verified Meta `Purchase` tracking event.
 */
import { randomUUID } from "node:crypto";
import {
  ApprovePaymentSubmissionSchema,
  CreatePaymentMethodSchema,
  CreatePaymentProviderSchema,
  parseStrictDDMMYYYYToIsoDate,
  RejectPaymentSubmissionSchema,
  SubmitManualPaymentSchema,
  UpdatePaymentMethodSchema,
  UpdatePaymentProviderSchema,
} from "../../../../../packages/contracts/src/index.ts";
import { storeValidatedPrivateR2Object } from "../../platform/storage/r2.ts";
import type {
  LicenseRecord,
  OrderRecord,
  PaymentMethodRecord,
  PaymentProviderRecord,
  PaymentSubmissionRecord,
  PaymentTransactionRecord,
  StackMateDataStore,
  SubscriptionRecord,
  UploadedAssetRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";
import { issueLicenseForOrderItemInTx } from "../licensing/service.ts";
import { createOrExtendSubscriptionInTx } from "../subscriptions/service.ts";

export interface PublicPaymentMethodDto {
  id: string;
  provider_name: string;
  display_name: string;
  method_kind: "mfs_account" | "bank_account" | "automated_checkout";
  account_type: "personal" | "merchant" | "agent" | null;
  account_label: string | null;
  account_number: string;
  account_holder_name: string | null;
  bank_name: string | null;
  branch_name: string | null;
  routing_number: string | null;
  instructions: string | null;
  transaction_id_requirement: "required" | "optional" | "disabled";
  transfer_rails: Array<"npsb" | "beftn" | "rtgs">;
}

export function toPublicPaymentMethodDto(
  store: StackMateDataStore,
  method: PaymentMethodRecord
): PublicPaymentMethodDto {
  const provider = store.state.payment_providers.find((p) => p.id === method.provider_id);
  return {
    id: method.id,
    provider_name: provider?.display_name ?? "Manual Payment",
    display_name: method.display_name,
    method_kind: method.method_kind,
    account_type: method.account_type,
    account_label: method.account_label,
    account_number: method.configuration.account_number,
    account_holder_name: method.configuration.account_holder_name ?? null,
    bank_name: method.configuration.bank_name ?? null,
    branch_name: method.configuration.branch_name ?? null,
    routing_number: method.configuration.routing_number ?? null,
    instructions: method.instructions,
    transaction_id_requirement: method.configuration.transaction_id_requirement,
    transfer_rails: [...method.transfer_rails],
  };
}

export async function createPaymentMethodByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<PaymentMethodRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  const input = CreatePaymentMethodSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const provider = state.payment_providers.find((p) => p.id === input.provider_id);
    if (!provider) {
      throw new AppError("NOT_FOUND", "Payment provider not found.", 404);
    }
    if (
      state.payment_methods.some(
        (m) => m.provider_id === input.provider_id && m.method_key === input.method_key
      )
    ) {
      throw new AppError(
        "CONFLICT",
        `Payment method key '${input.method_key}' already exists for this provider.`,
        409
      );
    }

    if (input.method_kind === "bank_account" && input.transfer_rails.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Bank transfer payment methods must configure at least one supported rail (npsb, beftn, rtgs).",
        422
      );
    }

    const method: PaymentMethodRecord = {
      id: randomUUID(),
      provider_id: input.provider_id,
      method_key: input.method_key,
      display_name: input.display_name,
      method_kind: input.method_kind,
      account_type: input.account_type ?? null,
      account_label: input.account_label ?? null,
      instructions: input.instructions ?? null,
      configuration: {
        account_number: input.configuration.account_number,
        ...(input.configuration.account_holder_name !== undefined
          ? { account_holder_name: input.configuration.account_holder_name }
          : {}),
        ...(input.configuration.bank_name !== undefined
          ? { bank_name: input.configuration.bank_name }
          : {}),
        ...(input.configuration.branch_name !== undefined
          ? { branch_name: input.configuration.branch_name }
          : {}),
        ...(input.configuration.routing_number !== undefined
          ? { routing_number: input.configuration.routing_number }
          : {}),
        transaction_id_requirement: input.configuration.transaction_id_requirement,
      },
      transfer_rails: [...input.transfer_rails],
      is_enabled: input.is_enabled,
      sort_order: input.sort_order,
      created_at: new Date().toISOString(),
    };
    state.payment_methods.push(method);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.method.created",
      resource_type: "payment_method",
      resource_id: method.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        method_key: method.method_key,
        method_kind: method.method_kind,
        account_type: method.account_type,
      },
    });

    return method;
  });
}

export async function uploadPrivatePaymentEvidence(
  store: StackMateDataStore,
  input: {
    orderId: string;
    customerId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    bucketName: string;
  }
): Promise<UploadedAssetRecord> {
  const assetId = randomUUID();
  const objectKey = `payment-evidence/${input.orderId}/${assetId}`;
  const stored = await storeValidatedPrivateR2Object({
    bucket: store.r2Bucket,
    bucketName: input.bucketName,
    objectKey,
    originalFilename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
  });

  return store.withTransaction((state) => {
    const asset: UploadedAssetRecord = {
      id: assetId,
      object_key: stored.objectKey,
      bucket_name: stored.bucketName,
      original_filename: stored.originalFilename,
      content_type: stored.contentType,
      byte_size: stored.byteSize,
      checksum_sha256: stored.checksumSha256,
      visibility: "private",
      uploaded_by_user_id: null,
      owner_customer_id: input.customerId,
      created_at: new Date().toISOString(),
    };
    state.uploaded_assets.push(asset);
    return asset;
  });
}

/**
 * Customer manual payment submission (API Spec §14.7).
 * Sets submission status to 'submitted' and order payment_status to 'pending_verification'.
 * NEVER marks the order paid or issues a license.
 */
export async function submitManualPaymentClaim(
  store: StackMateDataStore,
  input: {
    orderPublicReference: string;
    idempotencyKey: string;
    rawBody: unknown;
  }
): Promise<{
  replayed: boolean;
  payment_submission: PaymentSubmissionRecord;
  order: { public_reference: string; payment_status: string; status: string };
}> {
  const parsed = SubmitManualPaymentSchema.parse(input.rawBody);

  const res = await store.executeIdempotent(
    `payment_submission:${input.orderPublicReference}`,
    input.idempotencyKey,
    parsed,
    201,
    (state) => {
      const order = state.orders.find((o) => o.public_reference === input.orderPublicReference);
      if (!order) {
        throw new AppError("NOT_FOUND", "Order not found.", 404);
      }
      if (order.payment_status === "paid") {
        throw new AppError("CONFLICT", "This order has already been paid and verified.", 409);
      }
      if (order.status === "cancelled") {
        throw new AppError("CONFLICT", "Cannot submit payment for a cancelled order.", 409);
      }

      const method = state.payment_methods.find(
        (m) => m.id === parsed.payment_method_id && m.is_enabled
      );
      if (!method) {
        throw new AppError("NOT_FOUND", "Selected payment method is not available.", 404);
      }

      // Enforce full-payment amount and currency match (Section 5: Partial payments disabled initially)
      if (parsed.currency_code.toUpperCase() !== order.currency_code) {
        throw new AppError(
          "PAYMENT_AMOUNT_MISMATCH",
          `Payment currency '${parsed.currency_code}' does not match order currency '${order.currency_code}'.`,
          422
        );
      }
      if (parsed.amount_minor !== order.total_minor) {
        throw new AppError(
          "PAYMENT_AMOUNT_MISMATCH",
          `Submitted payment amount (${parsed.amount_minor}) must match exact order total (${order.total_minor}).`,
          422
        );
      }

      // Enforce Transaction ID policy (PRD §11.4, API Spec §14.7)
      const txnReq = method.configuration.transaction_id_requirement;
      const rawTxn = parsed.transaction_id?.trim() || "";
      if (txnReq === "required" && !rawTxn) {
        throw new AppError(
          "TRANSACTION_ID_REQUIRED",
          "Transaction ID is required for the selected payment method.",
          422
        );
      }
      if (txnReq === "disabled" && rawTxn) {
        throw new AppError(
          "TRANSACTION_ID_DISABLED",
          "Transaction ID field is disabled for the selected payment method.",
          422
        );
      }

      // Enforce Bank Transfer Rail allowlist (PRD §11.5)
      if (method.method_kind === "bank_account") {
        if (!parsed.transfer_rail || !method.transfer_rails.includes(parsed.transfer_rail)) {
          throw new AppError(
            "TRANSFER_RAIL_NOT_SUPPORTED",
            `Transfer rail '${String(parsed.transfer_rail)}' is not supported by '${method.display_name}'.`,
            422
          );
        }
      }

      // Verify evidence asset ownership if attached
      if (parsed.evidence_asset_id) {
        const asset = state.uploaded_assets.find((a) => a.id === parsed.evidence_asset_id);
        if (!asset || asset.owner_customer_id !== order.customer_id) {
          throw new AppError(
            "FORBIDDEN",
            "Attached payment evidence asset does not belong to this order.",
            403
          );
        }
      }

      let isoPaymentDate: string | null = null;
      if (parsed.payment_date_display) {
        try {
          isoPaymentDate = parseStrictDDMMYYYYToIsoDate(parsed.payment_date_display);
        } catch (err) {
          throw new AppError("VALIDATION_ERROR", (err as Error).message, 422);
        }
      }

      const normalizedTxn = rawTxn ? rawTxn.toUpperCase().replace(/\s+/g, "") : null;
      let duplicateWarning = false;
      if (normalizedTxn) {
        const existingSubmissionWithRef = state.payment_submissions.find(
          (s) =>
            s.normalized_transaction_reference === normalizedTxn &&
            s.status !== "rejected" &&
            s.status !== "cancelled"
        );
        if (existingSubmissionWithRef) {
          if (existingSubmissionWithRef.status === "approved") {
            throw new AppError(
              "DUPLICATE_TRANSACTION_REFERENCE",
              "This transaction reference has already been verified and approved on another payment.",
              409
            );
          }
          duplicateWarning = true;
        }
      }

      const nowIso = new Date().toISOString();
      const submission: PaymentSubmissionRecord = {
        id: randomUUID(),
        order_id: order.id,
        customer_id: order.customer_id,
        payment_method_id: method.id,
        amount_minor: parsed.amount_minor,
        currency_code: order.currency_code,
        sender_name: parsed.sender_name ?? null,
        sender_phone: parsed.sender_phone ?? null,
        sender_bank_name: parsed.sender_bank_name ?? null,
        sender_account_reference: parsed.sender_account_reference ?? null,
        transfer_rail_key: parsed.transfer_rail ?? null,
        transaction_reference: rawTxn || null,
        normalized_transaction_reference: normalizedTxn,
        payment_date: isoPaymentDate,
        proof_asset_id: parsed.evidence_asset_id ?? null,
        duplicate_risk_Warning: duplicateWarning,
        status: "submitted",
        customer_note: parsed.customer_note ?? null,
        submitted_at: nowIso,
        reviewed_at: null,
        reviewed_by_user_id: null,
      };

      state.payment_submissions.push(submission);
      order.payment_status = "pending_verification";
      order.updated_at = nowIso;

      state.outbox_events.push({
        id: randomUUID(),
        event_key: `payment.submitted:${submission.id}`,
        aggregate_type: "payment_submission",
        aggregate_id: submission.id,
        event_type: "payment.submitted",
        payload: {
          order_reference: order.public_reference,
          payment_submission_id: submission.id,
          amount_minor: submission.amount_minor,
          currency_code: submission.currency_code,
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
        payment_submission: submission,
        order: {
          public_reference: order.public_reference,
          payment_status: order.payment_status,
          status: order.status,
        },
      };
    }
  );

  return {
    replayed: res.replayed,
    ...res.body,
  };
}

/**
 * Atomic Staff Payment Verification & Approval (TAD §12.4, Database Design §21.2, API Spec §11.2).
 *
 * Within one serialized transaction:
 * 1. Confirms submission is still reviewable ('submitted' or 'under_review').
 * 2. Validates verified_amount_minor & currency_code against the order.
 * 3. Creates append-only payment_verification_logs entry.
 * 4. Marks submission 'approved' and creates unique payment_transactions row.
 * 5. Marks order 'completed' / 'paid' and invoice 'paid'.
 * 6. Runs FulfillmentOrchestrator per order item:
 *    - software_license / saas_provision -> creates/extends Subscription + issues License.
 *    - digital_service -> records service fulfillment intent (ADR-0003).
 * 7. Enqueues outbound webhook + verified Meta Purchase CAPI tracking event in outbox_events.
 */
export async function approvePaymentSubmissionByStaff(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  submissionId: string,
  rawInput: unknown,
  config: { licenseVerifierSecret: string; requestId: string }
): Promise<{
  submission: PaymentSubmissionRecord;
  transaction: PaymentTransactionRecord;
  order_status: string;
  payment_status: string;
  subscriptions: SubscriptionRecord[];
  issued_licenses: Array<{ license: LicenseRecord; issued_license_key_once: string }>;
}> {
  assertStaffPermission(actor, "payments.approve");
  const input = ApprovePaymentSubmissionSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const submission = state.payment_submissions.find((s) => s.id === submissionId);
    if (!submission) {
      throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
    }
    if (submission.status !== "submitted" && submission.status !== "under_review") {
      throw new AppError(
        "PAYMENT_SUBMISSION_ALREADY_REVIEWED",
        "This payment submission has already been reviewed.",
        409
      );
    }

    const order = state.orders.find((o) => o.id === submission.order_id);
    if (!order) {
      throw new AppError("NOT_FOUND", "Associated order not found.", 404);
    }
    if (order.payment_status === "paid") {
      throw new AppError(
        "PAYMENT_SUBMISSION_ALREADY_REVIEWED",
        "Associated order is already paid.",
        409
      );
    }

    if (
      input.currency_code.toUpperCase() !== order.currency_code ||
      input.verified_amount_minor !== order.total_minor
    ) {
      throw new AppError(
        "PAYMENT_AMOUNT_MISMATCH",
        `Verified amount (${input.verified_amount_minor} ${input.currency_code}) does not match order total (${order.total_minor} ${order.currency_code}).`,
        422
      );
    }

    const method = state.payment_methods.find((m) => m.id === submission.payment_method_id);
    if (!method) {
      throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    }

    const nowIso = new Date().toISOString();
    submission.status = "approved";
    submission.reviewed_at = nowIso;
    submission.reviewed_by_user_id = actor.user.id;

    state.payment_verification_logs.push({
      id: randomUUID(),
      payment_submission_id: submission.id,
      actor_user_id: actor.user.id,
      decision: "approved",
      reason_code: null,
      customer_message: null,
      notes: input.internal_note ?? `Verified reference: ${input.verification_reference}`,
      created_at: nowIso,
    });

    const transaction: PaymentTransactionRecord = {
      id: randomUUID(),
      order_id: order.id,
      payment_method_id: method.id,
      payment_submission_id: submission.id,
      provider_id: method.provider_id,
      provider_transaction_id:
        submission.normalized_transaction_reference ?? input.verification_reference,
      amount_minor: input.verified_amount_minor,
      currency_code: order.currency_code,
      status: "succeeded",
      paid_at: nowIso,
      verified_by_user_id: actor.user.id,
      verification_source: "manual_staff",
      created_at: nowIso,
    };
    state.payment_transactions.push(transaction);

    order.payment_status = "paid";
    order.status = "completed";
    order.completed_at = nowIso;
    order.updated_at = nowIso;

    for (const inv of state.invoices) {
      if (inv.order_id === order.id && inv.status === "open") {
        inv.status = "paid";
        inv.amount_paid_minor = inv.total_minor;
        inv.amount_due_minor = 0;
        inv.paid_at = nowIso;
      }
    }

    // Fulfillment Orchestrator (ADR-0003: dispatches by fulfillment_type_snapshot)
    const subscriptionsCreated: SubscriptionRecord[] = [];
    const licensesIssued: Array<{ license: LicenseRecord; issued_license_key_once: string }> = [];

    for (const item of order.items) {
      if (item.fulfillment_type_snapshot === "digital_service") {
        // ADR-0003: Service order does not issue a software license
        state.outbox_events.push({
          id: randomUUID(),
          event_key: `service_fulfillment.queued:${item.id}`,
          aggregate_type: "order_item",
          aggregate_id: item.id,
          event_type: "service.fulfillment_requested",
          payload: {
            order_id: order.id,
            order_item_id: item.id,
            product_id: item.product_id,
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
        continue;
      }

      const sub = createOrExtendSubscriptionInTx(state, order, item, transaction.id);
      subscriptionsCreated.push(sub);

      const { license, rawKeyOnce } = issueLicenseForOrderItemInTx(
        state,
        order,
        item,
        sub,
        config.licenseVerifierSecret
      );
      licensesIssued.push({ license, issued_license_key_once: rawKeyOnce });
    }

    // Outbox events: payment.approved, order.paid, and verified Meta Purchase event (API Spec §17.4)
    state.outbox_events.push({
      id: randomUUID(),
      event_key: `payment.approved:${submission.id}`,
      aggregate_type: "payment_submission",
      aggregate_id: submission.id,
      event_type: "payment.approved",
      payload: {
        order_reference: order.public_reference,
        payment_submission_id: submission.id,
        currency_code: order.currency_code,
        amount_minor: transaction.amount_minor,
        payment_status: "paid",
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

    if (order.integrated_site_id) {
      const purchaseEventId = `purchase_${order.public_reference}`;
      const existingTrack = state.tracking_events.find(
        (te) =>
          te.integrated_site_id === order.integrated_site_id &&
          te.event_name === "Purchase" &&
          te.event_id === purchaseEventId
      );
      if (!existingTrack) {
        const trackId = randomUUID();
        state.tracking_events.push({
          id: trackId,
          integrated_site_id: order.integrated_site_id,
          event_name: "Purchase",
          event_id: purchaseEventId,
          event_time: nowIso,
          event_source_url: null,
          order_id: order.id,
          consent_state: "granted",
          consent_policy_version: "server-verified-v1",
          sanitized_payload: {
            order_reference: order.public_reference,
            currency: order.currency_code,
            value_minor: order.total_minor,
          },
          status: "queued",
          delivery_attempts: 0,
          delivered_at: null,
          created_at: nowIso,
        });

        state.outbox_events.push({
          id: randomUUID(),
          event_key: `meta_capi.purchase:${order.id}`,
          aggregate_type: "tracking_event",
          aggregate_id: trackId,
          event_type: "tracking.meta_capi.dispatch",
          payload: {
            tracking_event_id: trackId,
            event_name: "Purchase",
            event_id: purchaseEventId,
            order_reference: order.public_reference,
            currency_code: order.currency_code,
            amount_minor: order.total_minor,
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
      }
    }

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.submission.approved",
      resource_type: "payment_submission",
      resource_id: submission.id,
      outcome: "success",
      request_id: config.requestId,
      changes: {
        order_id: order.id,
        verified_amount_minor: input.verified_amount_minor,
        currency_code: order.currency_code,
        verification_reference: input.verification_reference,
        licenses_issued: licensesIssued.map((l) => l.license.license_number),
      },
    });

    return {
      submission,
      transaction,
      order_status: order.status,
      payment_status: order.payment_status,
      subscriptions: subscriptionsCreated,
      issued_licenses: licensesIssued,
    };
  });
}

export async function rejectPaymentSubmissionByStaff(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  submissionId: string,
  rawInput: unknown,
  requestId: string
): Promise<PaymentSubmissionRecord> {
  assertStaffPermission(actor, "payments.reject");
  const input = RejectPaymentSubmissionSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const submission = state.payment_submissions.find((s) => s.id === submissionId);
    if (!submission) {
      throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
    }
    if (submission.status !== "submitted" && submission.status !== "under_review") {
      throw new AppError(
        "PAYMENT_SUBMISSION_ALREADY_REVIEWED",
        "This payment submission has already been reviewed.",
        409
      );
    }

    const order = state.orders.find((o) => o.id === submission.order_id);
    if (!order) throw new AppError("NOT_FOUND", "Associated order not found.", 404);

    const nowIso = new Date().toISOString();
    submission.status = "rejected";
    submission.reviewed_at = nowIso;
    submission.reviewed_by_user_id = actor.user.id;

    // Order remains unpaid and no license is issued
    order.payment_status = "unpaid";
    order.updated_at = nowIso;

    state.payment_verification_logs.push({
      id: randomUUID(),
      payment_submission_id: submission.id,
      actor_user_id: actor.user.id,
      decision: "rejected",
      reason_code: input.reason_code,
      customer_message: input.customer_message,
      notes: input.internal_note ?? null,
      created_at: nowIso,
    });

    state.outbox_events.push({
      id: randomUUID(),
      event_key: `payment.rejected:${submission.id}`,
      aggregate_type: "payment_submission",
      aggregate_id: submission.id,
      event_type: "payment.rejected",
      payload: {
        order_reference: order.public_reference,
        payment_submission_id: submission.id,
        reason_code: input.reason_code,
        customer_message: input.customer_message,
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

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.submission.rejected",
      resource_type: "payment_submission",
      resource_id: submission.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        order_id: order.id,
        reason_code: input.reason_code,
      },
    });

    return submission;
  });
}

export async function createPaymentProviderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<PaymentProviderRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  const input = CreatePaymentProviderSchema.parse(rawInput);
  return store.withTransaction((state) => {
    if (state.payment_providers.some((p) => p.provider_key === input.provider_key)) {
      throw new AppError(
        "CONFLICT",
        `Payment provider key '${input.provider_key}' already exists.`,
        409
      );
    }
    const provider: PaymentProviderRecord = {
      id: randomUUID(),
      provider_key: input.provider_key,
      display_name: input.display_name,
      provider_type: input.provider_type,
      adapter_key: input.adapter_key,
      status: input.status,
    };
    state.payment_providers.push(provider);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.provider.created",
      resource_type: "payment_provider",
      resource_id: provider.id,
      outcome: "success",
      request_id: requestId,
      changes: { provider_key: provider.provider_key, provider_type: provider.provider_type },
    });
    return provider;
  });
}

export async function updatePaymentProviderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  providerId: string,
  rawInput: unknown,
  requestId: string
): Promise<PaymentProviderRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  const input = UpdatePaymentProviderSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const provider = state.payment_providers.find((p) => p.id === providerId);
    if (!provider) throw new AppError("NOT_FOUND", "Payment provider not found.", 404);
    if (input.display_name !== undefined) provider.display_name = input.display_name;
    if (input.adapter_key !== undefined) provider.adapter_key = input.adapter_key;
    if (input.status !== undefined) provider.status = input.status;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.provider.updated",
      resource_type: "payment_provider",
      resource_id: provider.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return provider;
  });
}

export async function updatePaymentMethodByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  methodId: string,
  rawInput: unknown,
  requestId: string
): Promise<PaymentMethodRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  const input = UpdatePaymentMethodSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const method = state.payment_methods.find((m) => m.id === methodId);
    if (!method) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    if (input.display_name !== undefined) method.display_name = input.display_name;
    if (input.account_label !== undefined) method.account_label = input.account_label;
    if (input.instructions !== undefined) method.instructions = input.instructions;
    if (input.configuration !== undefined) {
      const cfg = input.configuration;
      // exactOptionalPropertyTypes: assign only present keys; an explicit
      // null clears the optional field (delete), it is never assigned.
      const nextConfig = { ...method.configuration };
      if (cfg.account_number !== undefined) nextConfig.account_number = cfg.account_number;
      if (cfg.account_holder_name !== undefined) {
        if (cfg.account_holder_name === null) delete nextConfig.account_holder_name;
        else nextConfig.account_holder_name = cfg.account_holder_name;
      }
      if (cfg.bank_name !== undefined) {
        if (cfg.bank_name === null) delete nextConfig.bank_name;
        else nextConfig.bank_name = cfg.bank_name;
      }
      if (cfg.branch_name !== undefined) {
        if (cfg.branch_name === null) delete nextConfig.branch_name;
        else nextConfig.branch_name = cfg.branch_name;
      }
      if (cfg.routing_number !== undefined) {
        if (cfg.routing_number === null) delete nextConfig.routing_number;
        else nextConfig.routing_number = cfg.routing_number;
      }
      if (cfg.transaction_id_requirement !== undefined)
        nextConfig.transaction_id_requirement = cfg.transaction_id_requirement;
      method.configuration = nextConfig;
    }
    if (input.transfer_rails !== undefined) {
      if (method.method_kind === "bank_account" && input.transfer_rails.length === 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Bank transfer payment methods must configure at least one supported rail (npsb, beftn, rtgs).",
          422
        );
      }
      method.transfer_rails = [...input.transfer_rails];
    }
    if (input.sort_order !== undefined) method.sort_order = input.sort_order;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.method.updated",
      resource_type: "payment_method",
      resource_id: method.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return method;
  });
}

export async function setPaymentMethodEnabledByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  methodId: string,
  enabled: boolean,
  requestId: string
): Promise<PaymentMethodRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  return store.withTransaction((state) => {
    const method = state.payment_methods.find((m) => m.id === methodId);
    if (!method) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    if (method.is_enabled === enabled) {
      throw new AppError(
        "CONFLICT",
        `Payment method is already ${enabled ? "enabled" : "disabled"}.`,
        409
      );
    }
    method.is_enabled = enabled;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: `payments.method.${enabled ? "enabled" : "disabled"}`,
      resource_type: "payment_method",
      resource_id: method.id,
      outcome: "success",
      request_id: requestId,
      changes: { method_key: method.method_key, is_enabled: enabled },
    });
    return method;
  });
}

/**
 * Staff-recorded manual payment claim (Batch 1, admin-side companion to
 * the customer-facing submitManualPaymentClaim). A customer who paid
 * offline and reported it by phone/chat gets their claim recorded by
 * staff with the same validations — full amount/currency match,
 * transaction-ID policy, rail allowlist, duplicate-reference check —
 * and the SAME consequence: status 'submitted', order
 * 'pending_verification', NEVER paid. Verification/approval still goes
 * through approvePaymentSubmissionByStaff.
 */
export async function recordManualPaymentClaimByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  orderId: string,
  rawInput: unknown,
  requestId: string
): Promise<{ payment_submission: PaymentSubmissionRecord; order: OrderRecord }> {
  assertStaffPermission(actor, "payments.approve");
  const parsed = SubmitManualPaymentSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    if (order.payment_status === "paid") {
      throw new AppError("CONFLICT", "This order has already been paid and verified.", 409);
    }
    if (order.status === "cancelled") {
      throw new AppError("CONFLICT", "Cannot submit payment for a cancelled order.", 409);
    }
    const method = state.payment_methods.find(
      (m) => m.id === parsed.payment_method_id && m.is_enabled
    );
    if (!method) {
      throw new AppError("NOT_FOUND", "Selected payment method is not available.", 404);
    }
    if (parsed.currency_code.toUpperCase() !== order.currency_code) {
      throw new AppError(
        "PAYMENT_AMOUNT_MISMATCH",
        `Payment currency '${parsed.currency_code}' does not match order currency '${order.currency_code}'.`,
        422
      );
    }
    if (parsed.amount_minor !== order.total_minor) {
      throw new AppError(
        "PAYMENT_AMOUNT_MISMATCH",
        `Submitted payment amount (${parsed.amount_minor}) must match exact order total (${order.total_minor}).`,
        422
      );
    }
    const txnReq = method.configuration.transaction_id_requirement;
    const rawTxn = parsed.transaction_id?.trim() || "";
    if (txnReq === "required" && !rawTxn) {
      throw new AppError(
        "TRANSACTION_ID_REQUIRED",
        "Transaction ID is required for the selected payment method.",
        422
      );
    }
    if (txnReq === "disabled" && rawTxn) {
      throw new AppError(
        "TRANSACTION_ID_DISABLED",
        "Transaction ID field is disabled for the selected payment method.",
        422
      );
    }
    if (method.method_kind === "bank_account") {
      if (!parsed.transfer_rail || !method.transfer_rails.includes(parsed.transfer_rail)) {
        throw new AppError(
          "TRANSFER_RAIL_NOT_SUPPORTED",
          `Transfer rail '${String(parsed.transfer_rail)}' is not supported by '${method.display_name}'.`,
          422
        );
      }
    }
    if (parsed.evidence_asset_id) {
      const asset = state.uploaded_assets.find((a) => a.id === parsed.evidence_asset_id);
      if (!asset || asset.owner_customer_id !== order.customer_id) {
        throw new AppError(
          "FORBIDDEN",
          "Attached payment evidence asset does not belong to this order.",
          403
        );
      }
    }
    let isoPaymentDate: string | null = null;
    if (parsed.payment_date_display) {
      try {
        isoPaymentDate = parseStrictDDMMYYYYToIsoDate(parsed.payment_date_display);
      } catch (err) {
        throw new AppError("VALIDATION_ERROR", (err as Error).message, 422);
      }
    }
    const normalizedTxn = rawTxn ? rawTxn.toUpperCase().replace(/\s+/g, "") : null;
    let duplicateWarning = false;
    if (normalizedTxn) {
      const existingSubmissionWithRef = state.payment_submissions.find(
        (s) =>
          s.normalized_transaction_reference === normalizedTxn &&
          s.status !== "rejected" &&
          s.status !== "cancelled"
      );
      if (existingSubmissionWithRef) {
        if (existingSubmissionWithRef.status === "approved") {
          throw new AppError(
            "DUPLICATE_TRANSACTION_REFERENCE",
            "This transaction reference has already been verified and approved on another payment.",
            409
          );
        }
        duplicateWarning = true;
      }
    }

    const nowIso = new Date().toISOString();
    const submission: PaymentSubmissionRecord = {
      id: randomUUID(),
      order_id: order.id,
      customer_id: order.customer_id,
      payment_method_id: method.id,
      amount_minor: parsed.amount_minor,
      currency_code: order.currency_code,
      sender_name: parsed.sender_name ?? null,
      sender_phone: parsed.sender_phone ?? null,
      sender_bank_name: parsed.sender_bank_name ?? null,
      sender_account_reference: parsed.sender_account_reference ?? null,
      transfer_rail_key: parsed.transfer_rail ?? null,
      transaction_reference: rawTxn || null,
      normalized_transaction_reference: normalizedTxn,
      payment_date: isoPaymentDate,
      proof_asset_id: parsed.evidence_asset_id ?? null,
      duplicate_risk_Warning: duplicateWarning,
      status: "submitted",
      customer_note: parsed.customer_note ?? null,
      submitted_at: nowIso,
      reviewed_at: null,
      reviewed_by_user_id: null,
    };
    state.payment_submissions.push(submission);
    order.payment_status = "pending_verification";
    order.updated_at = nowIso;

    state.outbox_events.push({
      id: randomUUID(),
      event_key: `payment.submitted:${submission.id}`,
      aggregate_type: "payment_submission",
      aggregate_id: submission.id,
      event_type: "payment.submitted",
      payload: {
        order_reference: order.public_reference,
        payment_submission_id: submission.id,
        amount_minor: submission.amount_minor,
        currency_code: submission.currency_code,
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

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.submission.recorded_by_staff",
      resource_type: "payment_submission",
      resource_id: submission.id,
      outcome: "success",
      request_id: requestId,
      changes: { order_id: order.id, amount_minor: submission.amount_minor },
    });

    return { payment_submission: submission, order };
  });
}
