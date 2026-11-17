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
  UpdateInstallmentSchema,
  UpdatePaymentMethodSchema,
  UpdatePaymentProviderSchema,
} from "../../../../../packages/contracts/src/index.ts";
import { storeValidatedPrivateR2Object } from "../../platform/storage/r2.ts";
import type {
  DatabaseState,
  LicenseRecord,
  OrderInstallmentRecord,
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
import {
  evaluateActivationForOrderInTx,
  evaluateSuspensionForOrderInTx,
} from "../activation/service.ts";
import { appendAuditLog } from "../audit/service.ts";
import {
  computeOrderPaid,
  computeOrderRemaining,
} from "../customers/service.ts";
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
  due_date?: string | undefined;
  advance_amount_minor?: number | undefined;
  advance_percent?: number | undefined;
  rest_due_date?: string | undefined;
  installment_count?: number | undefined;
  interval_days?: number | undefined;
  start_date?: string | undefined;
}

function parsePlanDate(value: string | undefined, fallback: string): string {
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
  now: Date
): OrderInstallmentRecord[] {
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
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
    });
    const subscriptionsCreated = activation.subscriptions;
    const licensesIssued = activation.issued_licenses;
    evaluateSuspensionForOrderInTx(state, order, new Date(nowIso), {
      actorUserId: actor.user.id,
      requestId: config.requestId,
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
    if (input.due_date !== undefined) {
      const raw = input.due_date.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new AppError("VALIDATION_ERROR", `Invalid due date '${raw}' — expected YYYY-MM-DD.`, 422);
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
