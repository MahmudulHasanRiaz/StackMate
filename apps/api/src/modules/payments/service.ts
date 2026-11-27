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
  formatDisplayDateDDMMYYYY,
  isValidIsoDateOnly,
  parseStrictDDMMYYYYToIsoDate,
  RejectPaymentSubmissionSchema,
  SubmitManualPaymentSchema,
  UpdateInstallmentSchema,
  UpdatePaymentMethodSchema,
  UpdatePaymentProviderSchema,
} from "../../../../../packages/contracts/src/index.ts";
import { businessTodayIso } from "../activation/service.ts";
import { storeValidatedPrivateObject } from "../../platform/storage/driver.ts";
import type { StorageDriver } from "../../platform/storage/driver.ts";
import type {
  DatabaseState,
  LicenseRecord,
  OrderInstallmentRecord,
  OrderRecord,
  PaymentMethodRecord,
  PaymentProviderRecord,
  PaymentRefundRecord,
  PaymentSubmissionRecord,
  PaymentTransactionRecord,
  StackMateDataStore,
  SubscriptionRecord,
  UploadedAssetRecord,
} from "../../platform/db/store.ts";
export type { PaymentRefundRecord } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import {
  evaluateActivationForOrderInTx,
  evaluateSuspensionForOrderInTx,
} from "../activation/service.ts";
import { appendAuditLog } from "../audit/service.ts";
import {
  enqueuePaymentApprovedNotificationInTx,
  enqueuePaymentRejectedNotificationInTx,
} from "../notifications/service.ts";
import {
  computeOrderPaid,
  computeOrderRemaining,
  normalizePhoneE164,
} from "../customers/service.ts";
import { sha256Hex } from "../../platform/crypto/index.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

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
    /** Resolved storage driver (R2 or Local, per Settings → Storage). */
    driver: StorageDriver;
    /**
     * H-1: who uploaded. Staff (admin route) → the permission is
     * asserted here and the upload is audited as staff. Null (public
     * checkout route) → the route already proved the site key +
     * checkout token + order reference; the upload is audited as the
     * integration instead. There is no unauthenticated path.
     */
    actor: StaffPrincipal | null;
    integratedSiteId?: string | null;
    requestId: string;
  }
): Promise<PaymentEvidenceUploadDto> {
  // H-1: the admin upload path has a service-level permission check
  // (the route-level check is the core agent's part). The public path
  // passes actor null — its authorization is the checkout token, which
  // the route verified before calling here.
  if (input.actor) assertStaffPermission(input.actor, "payments.approve");
  const assetId = randomUUID();
  const objectKey = `payment-evidence/${input.orderId}/${assetId}`;
  const stored = await storeValidatedPrivateObject({
    driver: input.driver,
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
      uploaded_by_user_id: input.actor ? input.actor.user.id : null,
      owner_customer_id: input.customerId,
      created_at: new Date().toISOString(),
    };
    state.uploaded_assets.push(asset);
    // H-1: the upload is auditable — who, for which order, what file.
    appendAuditLog(state, {
      actor_type: input.actor ? "staff" : "integration",
      actor_user_id: input.actor ? input.actor.user.id : null,
      integrated_site_id: input.actor ? null : (input.integratedSiteId ?? null),
      action: "payments.evidence.uploaded",
      resource_type: "uploaded_asset",
      resource_id: asset.id,
      outcome: "success",
      request_id: input.requestId,
      changes: {
        order_id: input.orderId,
        customer_id: input.customerId,
        original_filename: asset.original_filename,
        content_type: asset.content_type,
        byte_size: asset.byte_size,
      },
    });
    // L-10: the response is a MINIMAL DTO — never the full asset
    // record. The R2 object key / bucket name must never reach a
    // client (the old code returned them verbatim on the admin route).
    return toPaymentEvidenceUploadDto(asset);
  });
}

/**
 * Minimal evidence-upload response (L-10). The client needs the asset
 * id to attach it to a claim — nothing else. Storage keys stay
 * server-side; downloads go through the authenticated content
 * endpoint, which resolves the driver.
 */
export interface PaymentEvidenceUploadDto {
  id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string;
  visibility: "private";
  created_at: string;
}

export function toPaymentEvidenceUploadDto(asset: UploadedAssetRecord): PaymentEvidenceUploadDto {
  return {
    id: asset.id,
    original_filename: asset.original_filename,
    content_type: asset.content_type,
    byte_size: asset.byte_size,
    checksum_sha256: asset.checksum_sha256,
    visibility: "private",
    created_at: asset.created_at,
  };
}

/**
 * Customer manual payment submission (API Spec §14.7).
 * Sets submission status to 'submitted' and order payment_status to 'pending_verification'.
 * NEVER marks the order paid or issues a license.
 */
// -- Installment allocation (ADR-0009) ----------------------------------------
// A verified payment settles against installments oldest-first (by due date,
// then installment number). The caller may name one installment, which is
// filled first and the rest spills oldest-first. Amounts are capped at the
// order's remaining amount by the caller; this helper only distributes what
// it is given. Every installment touched gets its paid amount, status
// (partially_paid / paid) and paid_at (set when fully paid) updated.

export interface InstallmentAllocation {
  installment_id: string;
  amount_minor: number;
}

export function allocatePaymentToInstallmentsInTx(
  state: DatabaseState,
  order: OrderRecord,
  amountMinor: number,
  preferredInstallmentId?: string | null
): InstallmentAllocation[] {
  const nowIso = new Date().toISOString();
  const installments = state.order_installments
    .filter((i) => i.order_id === order.id && i.paid_amount_minor < i.amount_minor)
    .sort((a, b) =>
      a.due_date === b.due_date
        ? a.installment_number - b.installment_number
        : a.due_date < b.due_date
          ? -1
          : 1
    );
  const ordered = [...installments];
  if (preferredInstallmentId) {
    const idx = ordered.findIndex((i) => i.id === preferredInstallmentId);
    if (idx > 0) {
      const [preferred] = ordered.splice(idx, 1);
      ordered.unshift(preferred as (typeof ordered)[number]);
    }
  }
  const allocations: InstallmentAllocation[] = [];
  let remaining = amountMinor;
  for (const inst of ordered) {
    if (remaining <= 0) break;
    const due = inst.amount_minor - inst.paid_amount_minor;
    const take = Math.min(due, remaining);
    inst.paid_amount_minor += take;
    inst.status = inst.paid_amount_minor >= inst.amount_minor ? "paid" : "partially_paid";
    if (inst.status === "paid") inst.paid_at = nowIso;
    inst.updated_at = nowIso;
    allocations.push({ installment_id: inst.id, amount_minor: take });
    remaining -= take;
  }
  return allocations;
}

/** Validate an optional installment target named in a claim. */
export function resolveClaimInstallment(
  state: DatabaseState,
  order: OrderRecord,
  installmentId?: string | null
): void {
  if (!installmentId) return;
  const inst = state.order_installments.find((i) => i.id === installmentId);
  if (!inst || inst.order_id !== order.id) {
    throw new AppError(
      "INVALID_INSTALLMENT",
      "The named installment does not belong to this order.",
      422
    );
  }
  if (inst.paid_amount_minor >= inst.amount_minor) {
    throw new AppError(
      "INVALID_INSTALLMENT",
      `Installment #${inst.installment_number} is already fully paid.`,
      422
    );
  }
}

// -- Payment-plan builder (ADR-0009) ------------------------------------------
// Builds the order_installments rows for an order from the wizard's plan:
// full → one installment (due = clearance date); advance_rest → advance +
// rest; equal_installments → N equal parts every X days from a start date.
// Amounts always sum to the order total exactly (the remainder of an uneven
// split goes to the last installment). Due dates are ISO YYYY-MM-DD.

export interface PaymentPlanInput {
  kind?: "full" | "advance_rest" | "equal_installments";
  // Null-tolerant (ADR-0009 decision 11): the contract schema accepts
  // JSON null for dates; null ≡ absent (falls back to today / start).
  due_date?: string | null | undefined;
  advance_amount_minor?: number | undefined;
  advance_percent?: number | undefined;
  rest_due_date?: string | null | undefined;
  installment_count?: number | undefined;
  interval_days?: number | undefined;
  start_date?: string | null | undefined;
}

function parsePlanDate(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError("VALIDATION_ERROR", `Invalid date '${raw}' — expected YYYY-MM-DD.`, 422);
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new AppError("VALIDATION_ERROR", `Invalid date '${raw}'.`, 422);
  }
  return raw;
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function createInstallmentsForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  plan: PaymentPlanInput | undefined,
  now: Date,
  /**
   * F-12: the default due date is TODAY IN THE BUSINESS TIMEZONE, not
   * the UTC date — an order created at 01:00 Dhaka would otherwise
   * get a due date of "yesterday" (UTC) and read as missed on day one.
   */
  timeZone = "Asia/Dhaka"
): OrderInstallmentRecord[] {
  const nowIso = now.toISOString();
  const today = businessTodayIso(now, timeZone);
  const kind = plan?.kind ?? "full";
  const rows: Array<{ amount_minor: number; due_date: string }> = [];

  if (kind === "full") {
    rows.push({
      amount_minor: order.total_minor,
      due_date: parsePlanDate(plan?.due_date, today),
    });
  } else if (kind === "advance_rest") {
    const advance =
      plan?.advance_amount_minor ??
      (plan?.advance_percent !== undefined
        ? Math.round((order.total_minor * plan.advance_percent) / 100)
        : 0);
    if (advance <= 0 || advance >= order.total_minor) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Advance must be greater than 0 and less than the order total.",
        422
      );
    }
    rows.push({ amount_minor: advance, due_date: parsePlanDate(plan?.start_date, today) });
    rows.push({
      amount_minor: order.total_minor - advance,
      due_date: parsePlanDate(plan?.rest_due_date, today),
    });
  } else {
    const count = plan?.installment_count ?? 2;
    const interval = plan?.interval_days ?? 30;
    const start = parsePlanDate(plan?.start_date, today);
    const base = Math.floor(order.total_minor / count);
    for (let i = 0; i < count; i += 1) {
      const amount = i === count - 1 ? order.total_minor - base * (count - 1) : base;
      rows.push({ amount_minor: amount, due_date: addDaysIso(start, i * interval) });
    }
  }

  const created: OrderInstallmentRecord[] = rows.map((row, idx) => {
    const rec: OrderInstallmentRecord = {
      id: randomUUID(),
      order_id: order.id,
      installment_number: idx + 1,
      amount_minor: row.amount_minor,
      due_date: row.due_date,
      status: "pending",
      paid_amount_minor: 0,
      paid_at: null,
      notes: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    state.order_installments.push(rec);
    return rec;
  });
  return created;
}

/**
 * Canonical transaction-reference form (F-01): uppercase, all
 * whitespace stripped. "bkash 123", "BKASH123" and "Bkash  123" are
 * the SAME reference — every comparison (claim-time duplicate check,
 * approval-time double-approval guard, stored
 * `provider_transaction_id`) must use this form, or the same money
 * approves twice under two spellings.
 */
export function normalizeTransactionReference(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

export async function submitManualPaymentClaim(
  store: StackMateDataStore,
  input: {
    orderPublicReference: string;
    idempotencyKey: string;
    rawBody: unknown;
    /** M-14: the HTTP request id, for the claim audit row. */
    requestId: string;
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

      // Partial payments (ADR-0009, flips API spec §27): any positive amount
      // is accepted; only the currency must match. Amounts above the
      // remaining are accepted too — the excess becomes customer credit at
      // approval. The old full-amount 422 is gone.
      if (parsed.currency_code.toUpperCase() !== order.currency_code) {
        throw new AppError(
          "PAYMENT_AMOUNT_MISMATCH",
          `Payment currency '${parsed.currency_code}' does not match order currency '${order.currency_code}'.`,
          422
        );
      }
      resolveClaimInstallment(state, order, parsed.installment_id ?? null);

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

      const normalizedTxn = rawTxn ? normalizeTransactionReference(rawTxn) : null;
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
        installment_id: parsed.installment_id ?? null,
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

      // M-14: a public payment claim is a money mutation — it belongs
      // in the audit log (actor "integration": the claim arrived
      // through the site's checkout token; the order's site id is the
      // attribution). Idempotent replays do not re-run this callback,
      // so the row is written exactly once per claim.
      appendAuditLog(state, {
        actor_type: "integration",
        integrated_site_id: order.integrated_site_id,
        action: "payments.submission.claimed",
        resource_type: "payment_submission",
        resource_id: submission.id,
        outcome: "success",
        request_id: input.requestId,
        changes: {
          order_id: order.id,
          amount_minor: submission.amount_minor,
          currency_code: submission.currency_code,
        },
      });

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
  config: {
    licenseVerifierSecret: string;
    requestId: string;
    /**
     * F-12: business timezone for the activation/suspension date
     * boundaries (callers pass `env.DEFAULT_TIMEZONE`). Omitted →
     * Asia/Dhaka (the env default) inside the evaluation functions.
     */
    timeZone?: string | undefined;
  }
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

    // Partial payments (ADR-0009, flips API spec §27): the verified amount
    // is any positive amount in the order's currency. Credit may be applied
    // on top (explicit, never silent): apply_credit_minor must not exceed
    // the customer's credit balance nor the order's remaining amount.
    if (input.currency_code.toUpperCase() !== order.currency_code) {
      throw new AppError(
        "PAYMENT_AMOUNT_MISMATCH",
        `Verified currency '${input.currency_code}' does not match order currency '${order.currency_code}'.`,
        422
      );
    }
    const customer = state.customers.find((c) => c.id === order.customer_id);
    if (!customer) {
      throw new AppError("NOT_FOUND", "Associated customer not found.", 404);
    }
    const applyCredit = input.apply_credit_minor ?? 0;
    if (applyCredit > customer.credit_balance_minor) {
      throw new AppError(
        "CREDIT_EXCEEDS_BALANCE",
        `Credit to apply (${applyCredit}) exceeds the customer's credit balance (${customer.credit_balance_minor}).`,
        422
      );
    }
    const remainingBefore = computeOrderRemaining(state, order);
    if (applyCredit > remainingBefore) {
      throw new AppError(
        "CREDIT_EXCEEDS_BALANCE",
        `Credit to apply (${applyCredit}) exceeds the order's remaining amount (${remainingBefore}).`,
        422
      );
    }
    // Settled value for this approval = verified money + applied credit.
    // Any money above the remaining becomes customer credit (overpayment).
    const settledMinor = input.verified_amount_minor + applyCredit;
    const appliedToOrder = Math.min(settledMinor, remainingBefore);
    const excessMoney = Math.max(0, settledMinor - remainingBefore);
    const newCreditBalance =
      customer.credit_balance_minor - applyCredit + excessMoney;

    const method = state.payment_methods.find((m) => m.id === submission.payment_method_id);
    if (!method) {
      throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    }

    // F-01: the claim-time check only rejects a ref already approved
    // on ANOTHER submission. Two submissions carrying the same ref can
    // both sit in "submitted" and both be approved in sequence — the
    // second approval would mint a second transaction and phantom
    // credit. Guard here, inside the serialized transaction (the
    // drizzle store takes a global writer advisory lock, so two
    // approvals can never interleave): a succeeded transaction already
    // exists for this (provider, normalized ref).
    const approvalRef = normalizeTransactionReference(
      submission.normalized_transaction_reference ?? input.verification_reference
    );
    if (approvalRef !== "") {
      const alreadySettled = state.payment_transactions.find(
        (t) =>
          t.provider_id === method.provider_id &&
          t.status === "succeeded" &&
          t.provider_transaction_id !== null &&
          normalizeTransactionReference(t.provider_transaction_id) === approvalRef
      );
      if (alreadySettled) {
        throw new AppError(
          "DUPLICATE_TRANSACTION_REFERENCE",
          "This transaction reference has already been verified and approved on another payment.",
          409
        );
      }
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
      notes:
        input.internal_note ??
        `Verified reference: ${input.verification_reference}` +
          (applyCredit > 0 ? `; credit applied: ${applyCredit}` : "") +
          (excessMoney > 0 ? `; overpayment to credit: ${excessMoney}` : ""),
      created_at: nowIso,
    });

    const transaction: PaymentTransactionRecord = {
      id: randomUUID(),
      order_id: order.id,
      payment_method_id: method.id,
      payment_submission_id: submission.id,
      provider_id: method.provider_id,
      // Stored NORMALIZED (F-01): the raw verification_reference may
      // carry spaces/case that would defeat the duplicate guard on the
      // next approval of the same money.
      provider_transaction_id:
        submission.normalized_transaction_reference ??
        (approvalRef !== "" ? approvalRef : null),
      amount_minor: input.verified_amount_minor,
      currency_code: order.currency_code,
      status: "succeeded",
      paid_at: nowIso,
      verified_by_user_id: actor.user.id,
      verification_source: "manual_staff",
      created_at: nowIso,
    };
    state.payment_transactions.push(transaction);

    // Settle: allocate the settled value across installments (the claim's
    // named installment first, then oldest-first), update the customer's
    // credit balance (applied credit leaves, overpaid money enters), and
    // recompute the order + invoice paid/due state from the installments.
    const allocations = allocatePaymentToInstallmentsInTx(
      state,
      order,
      appliedToOrder,
      submission.installment_id
    );
    if (newCreditBalance !== customer.credit_balance_minor) {
      customer.credit_balance_minor = newCreditBalance;
      customer.updated_at = nowIso;
    }

    const paidAfter = computeOrderPaid(state, order.id);
    const remainingAfter = Math.max(0, order.total_minor - paidAfter);
    const fullyPaid = remainingAfter === 0;
    order.payment_status = fullyPaid ? "paid" : "partially_paid";
    if (fullyPaid) {
      order.status = "completed";
      order.completed_at = nowIso;
    }
    order.updated_at = nowIso;

    for (const inv of state.invoices) {
      if (inv.order_id === order.id && (inv.status === "open" || inv.status === "partially_paid")) {
        inv.amount_paid_minor = Math.min(inv.total_minor, paidAfter);
        inv.amount_due_minor = Math.max(0, inv.total_minor - paidAfter);
        inv.status = inv.amount_due_minor === 0 ? "paid" : "partially_paid";
        if (inv.status === "paid") inv.paid_at = nowIso;
      }
    }

    // Fulfillment follows the activation policy (ADR-0009), not payment
    // completion alone: on_full_payment / on_percent / on_date decide when
    // the subscription + license are created; the missed-schedule rule
    // suspends/reactivates afterwards.
    const activation = evaluateActivationForOrderInTx(state, order, nowIso, {
      licenseVerifierSecret: config.licenseVerifierSecret,
      paymentTransactionId: transaction.id,
      actorUserId: actor.user.id,
      requestId: config.requestId,
      timeZone: config.timeZone,
    });
    const subscriptionsCreated = activation.subscriptions;
    const licensesIssued = activation.issued_licenses;
    evaluateSuspensionForOrderInTx(state, order, new Date(nowIso), {
      actorUserId: actor.user.id,
      requestId: config.requestId,
      timeZone: config.timeZone,
    });

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
        payment_status: order.payment_status,
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

    // Notifications v1 (OD-08): the customer gets the payment-approved
    // email. A separate `email.notification.dispatch` outbox event —
    // the cron drain sends it via SMTP; the webhook `payment.approved`
    // event above is untouched. Skipped when the customer has no email
    // address; the approval itself never fails for a missing address.
    enqueuePaymentApprovedNotificationInTx(state, {
      submissionId: submission.id,
      orderReference: order.public_reference,
      customerName: customer.name,
      customerEmail: customer.email,
      amountMinor: transaction.amount_minor,
      currencyCode: order.currency_code,
      paymentStatus: order.payment_status === "paid" ? "paid" : "partially_paid",
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
        // E-01: Meta rejects a Purchase event with empty user_data
        // (HTTP 400, error 100 "Invalid parameter"). Hash the order
        // customer's email/phone server-side, exactly like the
        // website-ingested path (modules/tracking/service.ts):
        // em = sha256(trimmed + lowercased email), ph = sha256
        // (digits of the E.164-normalized phone). Only fields the
        // customer actually has are included — never an invented
        // value, never a hash of an empty string — and raw PII is
        // never stored here or sent to Meta. The drain
        // (createCapiDeliver) forwards these hashes as user_data.
        const purchaseUserDataHashes: Record<string, string> = {};
        const customerEmail = customer.email?.trim();
        if (customerEmail) {
          purchaseUserDataHashes.em = sha256Hex(customerEmail.toLowerCase());
        }
        if (customer.phone) {
          const phoneDigits = (normalizePhoneE164(customer.phone) ?? "").replace(/\D/g, "");
          if (phoneDigits) {
            purchaseUserDataHashes.ph = sha256Hex(phoneDigits);
          }
        }
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
            user_data_hashes: purchaseUserDataHashes,
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
        credit_applied_minor: applyCredit,
        overpayment_to_credit_minor: excessMoney,
        customer_credit_balance_minor: newCreditBalance,
        installment_allocations: allocations,
        activation: activation.reason,
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

    // Notifications v1 (OD-08): the customer gets the payment-rejected
    // email with the staff-written reason. Same separate outbox event
    // as the approved path; skipped when the customer has no email
    // address (or no customer row — the rejection itself never fails
    // for that). The webhook `payment.rejected` event above is
    // untouched.
    const rejectedCustomer = state.customers.find((c) => c.id === order.customer_id);
    enqueuePaymentRejectedNotificationInTx(state, {
      submissionId: submission.id,
      orderReference: order.public_reference,
      customerName: rejectedCustomer?.name ?? "Customer",
      customerEmail: rejectedCustomer?.email ?? null,
      reasonCode: input.reason_code,
      customerMessage: input.customer_message,
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

// -- Manual refunds (audit F-03, decision D-4) -----------------------------
// Manual refunds ONLY — no gateway, no provider API call. Staff records
// money handed back by hand; the refund is "succeeded" the moment it
// is recorded. The refund facts live in `payment_refunds` (DB spec
// §13.8); the original transaction row is never overwritten — its
// status only reflects the refunded state (succeeded →
// Refund record (DB spec §13.8, table `payment_refunds` since
// migration 0000). Lives in platform/db/store.ts — imported +
// re-exported here so existing import sites keep working.

/** The `payment_refunds` collection. Fails closed when the collection
 * is not wired rather than silently dropping the refund row. */
function refundState(state: DatabaseState): PaymentRefundRecord[] {
  const refunds = state.payment_refunds;
  if (!Array.isArray(refunds)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Manual refunds are unavailable: the payment_refunds state collection is not wired.",
      500
    );
  }
  return refunds;
}

export interface RecordManualRefundInput {
  /** Refund against this transaction (preferred). */
  payment_transaction_id?: string | null;
  /** Or the latest refundable transaction of this order. */
  order_id?: string | null;
  amount_minor: number;
  currency_code: string;
  /** Why the money is going back (required, max 1000 chars). */
  reason: string;
  /** Optional provider/bank refund reference (e.g. a bKash refund TrxID). */
  provider_refund_id?: string | null;
}

/**
 * Reverse a refund out of installments, NEWEST-first — the mirror of
 * approval's oldest-first allocation, so the most recent money comes
 * back first. Never drives a paid amount below zero.
 */
export function reverseRefundFromInstallmentsInTx(
  state: DatabaseState,
  order: OrderRecord,
  amountMinor: number
): InstallmentAllocation[] {
  const nowIso = new Date().toISOString();
  const installments = state.order_installments
    .filter((i) => i.order_id === order.id && i.paid_amount_minor > 0)
    .sort((a, b) =>
      a.due_date === b.due_date
        ? b.installment_number - a.installment_number
        : a.due_date < b.due_date
          ? 1
          : -1
    );
  const allocations: InstallmentAllocation[] = [];
  let remaining = amountMinor;
  for (const inst of installments) {
    if (remaining <= 0) break;
    const take = Math.min(inst.paid_amount_minor, remaining);
    inst.paid_amount_minor -= take;
    inst.status = inst.paid_amount_minor === 0 ? "pending" : "partially_paid";
    inst.paid_at = null;
    inst.updated_at = nowIso;
    allocations.push({ installment_id: inst.id, amount_minor: take });
    remaining -= take;
  }
  return allocations;
}

export async function recordManualRefundByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: RecordManualRefundInput,
  requestId: string
): Promise<{
  refund: PaymentRefundRecord;
  transaction: PaymentTransactionRecord;
  order: OrderRecord;
}> {
  assertStaffPermission(actor, "payments.approve");
  // No Zod schema in packages/contracts yet — the core agent adds
  // `RecordManualRefundSchema` + the route; the service validates the
  // plain input shape here so the rules hold whichever way it is called.
  const input = rawInput as RecordManualRefundInput | null | undefined;
  if (!input || typeof input !== "object") {
    throw new AppError("VALIDATION_ERROR", "Refund input is required.", 422);
  }
  const amount = input.amount_minor;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "amount_minor must be a positive integer (minor units).",
      422
    );
  }
  const currency = (input.currency_code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError("VALIDATION_ERROR", "currency_code must be a 3-letter code.", 422);
  }
  const reason = (input.reason ?? "").trim();
  if (reason === "" || reason.length > 1000) {
    throw new AppError("VALIDATION_ERROR", "reason is required (max 1000 characters).", 422);
  }
  const providerRefundId =
    input.provider_refund_id?.trim() && input.provider_refund_id.trim().length > 0
      ? input.provider_refund_id.trim().slice(0, 180)
      : null;

  return store.withTransaction((state) => {
    // Resolve the transaction: an explicit id wins; otherwise the
    // latest refundable transaction of the order.
    let transaction: PaymentTransactionRecord | undefined;
    if (input.payment_transaction_id) {
      transaction = state.payment_transactions.find(
        (t) => t.id === input.payment_transaction_id
      );
      if (!transaction) {
        throw new AppError("NOT_FOUND", "Payment transaction not found.", 404);
      }
    } else if (input.order_id) {
      const candidates = state.payment_transactions
        .filter(
          (t) =>
            t.order_id === input.order_id &&
            (t.status === "succeeded" || t.status === "partially_refunded")
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      transaction = candidates[0];
      if (!transaction) {
        throw new AppError(
          "NOT_FOUND",
          "Order has no refundable payment transaction.",
          404
        );
      }
    } else {
      throw new AppError(
        "VALIDATION_ERROR",
        "Provide payment_transaction_id or order_id.",
        422
      );
    }
    if (transaction.status !== "succeeded" && transaction.status !== "partially_refunded") {
      throw new AppError(
        "CONFLICT",
        `Payment transaction is '${transaction.status}' and cannot be refunded.`,
        409
      );
    }
    if (transaction.currency_code !== currency) {
      throw new AppError(
        "PAYMENT_AMOUNT_MISMATCH",
        `Refund currency '${currency}' does not match transaction currency '${transaction.currency_code}'.`,
        422
      );
    }
    const order = state.orders.find((o) => o.id === transaction.order_id);
    if (!order) {
      throw new AppError("NOT_FOUND", "Associated order not found.", 404);
    }
    const customer = state.customers.find((c) => c.id === order.customer_id);
    if (!customer) {
      throw new AppError("NOT_FOUND", "Associated customer not found.", 404);
    }

    // Refundable ceiling: the transaction's own amount minus refunds
    // already recorded against it (a second refund of the same money
    // is a 422, not phantom negative money).
    const refunds = refundState(state);
    const alreadyRefunded = refunds
      .filter(
        (r) => r.payment_transaction_id === transaction.id && r.status === "succeeded"
      )
      .reduce((sum, r) => sum + r.amount_minor, 0);
    const maxRefundable = transaction.amount_minor - alreadyRefunded;
    if (amount > maxRefundable) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Refund (${amount}) exceeds the transaction's remaining refundable amount (${maxRefundable}).`,
        422
      );
    }

    // The refund draws from the order's paid amount first (newest
    // installments first); any remainder comes out of the customer's
    // credit balance — the overpayment portion of this transaction.
    // If that credit was already spent on another order, the refund
    // is rejected rather than driving a balance negative; staff
    // resolve the credit first.
    const nowIso = new Date().toISOString();
    const orderPaidBefore = computeOrderPaid(state, order.id);
    const fromOrder = Math.min(amount, orderPaidBefore);
    const fromCredit = amount - fromOrder;
    if (fromCredit > customer.credit_balance_minor) {
      throw new AppError(
        "CREDIT_EXCEEDS_BALANCE",
        `Refund exceeds the order's paid amount by ${fromCredit}, but the customer's credit balance is only ${customer.credit_balance_minor} — the credit was already used. Resolve the credit before refunding this amount.`,
        422
      );
    }

    const refund: PaymentRefundRecord = {
      id: randomUUID(),
      payment_transaction_id: transaction.id,
      amount_minor: amount,
      currency_code: currency,
      // D-4: manual refund — the money was handed back by hand, so
      // there is no provider call to await; it is succeeded on record.
      status: "succeeded",
      reason,
      provider_refund_id: providerRefundId,
      requested_by_user_id: actor.user.id,
      processed_by_user_id: actor.user.id,
      created_at: nowIso,
      updated_at: nowIso,
    };
    refunds.push(refund);

    const totalRefundedAfter = alreadyRefunded + amount;
    transaction.status =
      totalRefundedAfter >= transaction.amount_minor ? "refunded" : "partially_refunded";

    const allocations = reverseRefundFromInstallmentsInTx(state, order, fromOrder);
    if (fromCredit > 0) {
      customer.credit_balance_minor -= fromCredit;
      customer.updated_at = nowIso;
    }

    const paidAfter = computeOrderPaid(state, order.id);
    const remainingAfter = Math.max(0, order.total_minor - paidAfter);
    order.payment_status =
      remainingAfter === 0 ? "paid" : paidAfter > 0 ? "partially_paid" : "unpaid";
    // order.status is deliberately untouched: fulfillment already
    // happened (licenses/subscriptions stay). If the refund voids the
    // entitlement, staff revoke/suspend the license as a separate,
    // explicit action.
    order.updated_at = nowIso;

    for (const inv of state.invoices) {
      if (
        inv.order_id === order.id &&
        (inv.status === "open" || inv.status === "partially_paid" || inv.status === "paid")
      ) {
        inv.amount_paid_minor = Math.min(inv.total_minor, paidAfter);
        inv.amount_due_minor = Math.max(0, inv.total_minor - paidAfter);
        inv.status =
          inv.amount_due_minor === 0 ? "paid" : paidAfter > 0 ? "partially_paid" : "open";
        inv.paid_at = inv.status === "paid" ? (inv.paid_at ?? nowIso) : null;
      }
    }

    state.outbox_events.push({
      id: randomUUID(),
      event_key: `payment.refunded:${refund.id}`,
      aggregate_type: "payment_transaction",
      aggregate_id: transaction.id,
      event_type: "payment.refunded",
      payload: {
        order_reference: order.public_reference,
        payment_transaction_id: transaction.id,
        refund_id: refund.id,
        amount_minor: amount,
        currency_code: currency,
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
      action: "payments.refund.recorded",
      resource_type: "payment_refund",
      resource_id: refund.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        order_id: order.id,
        payment_transaction_id: transaction.id,
        amount_minor: amount,
        currency_code: currency,
        reason,
        from_order_minor: fromOrder,
        from_credit_minor: fromCredit,
        transaction_status: transaction.status,
        installment_allocations: allocations,
      },
    });

    return { refund, transaction, order };
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
    // Partial payments (ADR-0009): any positive amount is accepted; the
    // old full-amount 422 is gone. Overpayment excess becomes credit at
    // approval.
    resolveClaimInstallment(state, order, parsed.installment_id ?? null);
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
    const normalizedTxn = rawTxn ? normalizeTransactionReference(rawTxn) : null;
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
      installment_id: parsed.installment_id ?? null,
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

// -- Installment edits (ADR-0009) ----------------------------------------------
// Admin may change an installment's due date (or notes) after creation;
// audit-logged. Paid amounts / status are never edited by hand — they are
// derived from verified payments only.

export async function updateInstallmentByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  installmentId: string,
  rawInput: unknown,
  requestId: string
): Promise<OrderInstallmentRecord> {
  assertStaffPermission(actor, "orders.manage");
  const input = UpdateInstallmentSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const inst = state.order_installments.find((i) => i.id === installmentId);
    if (!inst) throw new AppError("NOT_FOUND", "Installment not found.", 404);
    const changes: Record<string, unknown> = {};
    if (input.due_date !== undefined && input.due_date !== null) {
      const raw = input.due_date.trim();
      // Strict ISO date (AGENTS.md §7): the old regex-only check
      // accepted impossible dates like 2026-02-30.
      if (!isValidIsoDateOnly(raw)) {
        throw new AppError("VALIDATION_ERROR", `Invalid due date '${raw}' — expected a real YYYY-MM-DD date.`, 422);
      }
      inst.due_date = raw;
      changes.due_date = raw;
    }
    if (input.notes !== undefined) {
      inst.notes = input.notes;
      changes.notes = input.notes;
    }
    inst.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "orders.installment.updated",
      resource_type: "order",
      resource_id: inst.order_id,
      outcome: "success",
      request_id: requestId,
      changes: { installment_id: inst.id, installment_number: inst.installment_number, ...changes },
    });
    return inst;
  });
}

/* ------------------------------------------------------------------ */
/* E-16: payment provider / method delete (PRD §11.2, matrix J3)      */
/* ------------------------------------------------------------------ */

/**
 * Delete a payment provider (E-16). Same guard pattern as webhook-
 * endpoint delete: financial history is NEVER deleted with it.
 *
 * - A provider that still owns methods is a 409 — delete (or move)
 *   the methods first; silently dropping them would orphan the
 *   submissions that reference them.
 * - A provider with no methods deletes cleanly; submissions and
 *   transactions never reference a provider directly (they reference
 *   the method), so no financial row is touched. Disable (not delete)
 *   stays the right call for a provider that must keep its history
 *   reachable — deletion is for misconfigured/retired providers only.
 */
export async function deletePaymentProviderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  providerId: string,
  requestId: string
): Promise<PaymentProviderRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  return store.withTransaction((state) => {
    const provider = state.payment_providers.find((p) => p.id === providerId);
    if (!provider) throw new AppError("NOT_FOUND", "Payment provider not found.", 404);
    const methods = state.payment_methods.filter((m) => m.provider_id === providerId);
    if (methods.length > 0) {
      throw new AppError(
        "CONFLICT",
        `Payment provider still owns ${methods.length} payment method(s). Delete the methods first.`,
        409
      );
    }
    state.payment_providers = state.payment_providers.filter((p) => p.id !== providerId);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.provider.deleted",
      resource_type: "payment_provider",
      resource_id: provider.id,
      outcome: "success",
      request_id: requestId,
      changes: { provider_key: provider.provider_key, display_name: provider.display_name },
    });
    return provider;
  });
}

/**
 * Delete a payment method (E-16). Same guard pattern as webhook-
 * endpoint delete, but stricter on history: a method referenced by ANY
 * submission, transaction, or order is a 409 — the financial trail
 * must survive the method. Disable the method instead when history
 * must stay reachable. A method with zero references deletes cleanly.
 */
export async function deletePaymentMethodByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  methodId: string,
  requestId: string
): Promise<PaymentMethodRecord> {
  assertStaffPermission(actor, "payments.methods.manage");
  return store.withTransaction((state) => {
    const method = state.payment_methods.find((m) => m.id === methodId);
    if (!method) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    const submissionCount = state.payment_submissions.filter(
      (s) => s.payment_method_id === methodId
    ).length;
    const transactionCount = state.payment_transactions.filter(
      (t) => t.payment_method_id === methodId
    ).length;
    const orderCount = state.orders.filter((o) => o.payment_method_id === methodId).length;
    const references = submissionCount + transactionCount + orderCount;
    if (references > 0) {
      throw new AppError(
        "CONFLICT",
        `Payment method is referenced by ${submissionCount} submission(s), ${transactionCount} transaction(s) and ${orderCount} order(s). Disable it instead of deleting.`,
        409
      );
    }
    state.payment_methods = state.payment_methods.filter((m) => m.id !== methodId);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "payments.method.deleted",
      resource_type: "payment_method",
      resource_id: method.id,
      outcome: "success",
      request_id: requestId,
      changes: { method_key: method.method_key, display_name: method.display_name },
    });
    return method;
  });
}
