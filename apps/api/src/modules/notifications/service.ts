/**
 * Notifications v1 (OD-08, approved 2026-11-27).
 *
 * Exactly two templates, email only, code-defined (admin-editable
 * templates are a later step — deliberately NOT built here), delivered
 * through the existing transactional outbox + cron drain. No campaign
 * engine, no new table, no new delivery pipeline, and the renewal
 * reminders stay in the renewal/reminders modules — untouched.
 *
 * Flow:
 * 1. `modules/payments/service.ts` enqueues one outbox event per
 *    staff review (`email.notification.dispatch`) inside the same
 *    serialized approval/rejection transaction — the notification is
 *    atomic with the decision, never sent for a decision that rolled
 *    back. A customer with no email address gets no event (there is
 *    nowhere to send it); the payment decision itself never fails
 *    for a missing address.
 * 2. The cron drain (`modules/webhooks/service.ts`,
 *    `processTransactionalOutboxBatch`) handles that event type
 *    BEFORE the webhook fan-out, so a `*`-subscribed webhook
 *    endpoint never receives the email payload. It renders the
 *    code-defined template from the event payload and sends it via
 *    the existing SMTP path (`modules/email/service.ts`,
 *    `sendStackMateEmail` — the same sender password-reset and
 *    invite mail use). A failed send retries with the drain's
 *    normal backoff and dead-letters after `maxAttempts`; a
 *    dead-lettered notification is replayable from the admin outbox
 *    UI once SMTP is fixed (`replayOutboxEventByAdmin`).
 * 3. Honesty (C-2 / D-6): without a deliverer — an in-memory/test
 *    store with no drizzle DB and no injected `emailDeliver` — the
 *    event is recorded "simulated", never "delivered". In
 *    production the cron store always has a drizzle DB, so the
 *    default deliverer is built inside the drain and no caller
 *    (scheduled.ts, the manual dispatch route) needs to change.
 *
 * Deliberately OUT of v1: in-app bell / in-app notification UI,
 * admin-editable templates, any template beyond the two below,
 * secondary-email fallback (primary email only).
 */
import { randomUUID } from "node:crypto";
import type {
  DatabaseState,
  OutboxEventRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import {
  sendStackMateEmail,
  type SendResult,
} from "../email/service.ts";

/** Outbox event type for notification emails (a drain intent, like `tracking.meta_capi.dispatch` — not a webhook event). */
export const EMAIL_NOTIFICATION_EVENT_TYPE = "email.notification.dispatch";

/** The only two templates in v1. */
export type NotificationTemplate = "payment_approved" | "payment_rejected";

export type NotificationEmailPayload =
  | {
      template: "payment_approved";
      to: string;
      customer_name: string;
      order_reference: string;
      amount_minor: number;
      currency_code: string;
      /** "paid" = fully settled; "partially_paid" = part-payment approved, balance still due. */
      payment_status: "paid" | "partially_paid";
    }
  | {
      template: "payment_rejected";
      to: string;
      customer_name: string;
      order_reference: string;
      reason_code: string;
      /** Staff-written message to the customer (required at rejection time). */
      customer_message: string;
    };

export interface NotificationEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Injectable email sender (production: the default SMTP deliverer below; tests: a capture stub). */
export type EmailDeliverFn = (message: NotificationEmail) => Promise<SendResult>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minor units → display amount. BDT matches the renewal-sweep format (`৳1,000.00`); anything else is `CODE 1,000.00`. */
export function formatMinorAmount(amountMinor: number, currencyCode: string): string {
  const code = currencyCode.toUpperCase();
  if (code === "BDT") {
    return `৳${(amountMinor / 100).toLocaleString("en-BD", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `${code} ${(amountMinor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function buildPaymentApprovedEmail(
  data: Extract<NotificationEmailPayload, { template: "payment_approved" }>
): NotificationEmail {
  const amount = formatMinorAmount(data.amount_minor, data.currency_code);
  const partialLine =
    data.payment_status === "partially_paid"
      ? "This was a partial payment — the remaining balance for this order is still due."
      : null;
  const textLines = [
    `Hi ${data.customer_name},`,
    "",
    `Good news — your payment of ${amount} for order ${data.order_reference} has been approved.`,
  ];
  if (partialLine) textLines.push("", partialLine);
  textLines.push("", "Thank you for your payment.", "", "— StackMate");
  return {
    to: data.to,
    subject: `Payment approved — order ${data.order_reference}`,
    text: textLines.join("\n"),
    html: [
      `<p>Hi ${escapeHtml(data.customer_name)},</p>`,
      `<p>Good news — your payment of ${escapeHtml(amount)} for order ${escapeHtml(data.order_reference)} has been approved.</p>`,
      ...(partialLine ? [`<p>${escapeHtml(partialLine)}</p>`] : []),
      "<p>Thank you for your payment.</p>",
      "<p>— StackMate</p>",
    ].join("\n"),
  };
}

export function buildPaymentRejectedEmail(
  data: Extract<NotificationEmailPayload, { template: "payment_rejected" }>
): NotificationEmail {
  const text = [
    `Hi ${data.customer_name},`,
    "",
    `Your payment for order ${data.order_reference} could not be approved.`,
    "",
    `Reason (${data.reason_code}): ${data.customer_message}`,
    "",
    "Please review the details and submit a new payment, or contact support if you need help.",
    "",
    "— StackMate",
  ].join("\n");
  return {
    to: data.to,
    subject: `Payment not approved — order ${data.order_reference}`,
    text,
    html: [
      `<p>Hi ${escapeHtml(data.customer_name)},</p>`,
      `<p>Your payment for order ${escapeHtml(data.order_reference)} could not be approved.</p>`,
      `<p>Reason (${escapeHtml(data.reason_code)}): ${escapeHtml(data.customer_message)}</p>`,
      "<p>Please review the details and submit a new payment, or contact support if you need help.</p>",
      "<p>— StackMate</p>",
    ].join("\n"),
  };
}

/** Render a parsed notification payload with its code-defined template. */
export function renderNotificationEmail(payload: NotificationEmailPayload): NotificationEmail {
  return payload.template === "payment_approved"
    ? buildPaymentApprovedEmail(payload)
    : buildPaymentRejectedEmail(payload);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidEmail(value: unknown): value is string {
  return isNonEmptyString(value) && value.includes("@");
}

/**
 * Strictly validate an outbox payload for `email.notification.dispatch`.
 * Throws on any malformed shape — the drain treats the throw as a
 * failed delivery (retry, then dead-letter), which is the honest
 * outcome for a payload no enqueue path can produce.
 */
export function parseNotificationEmailPayload(payload: unknown): NotificationEmailPayload {
  const fail = (detail: string): never => {
    throw new Error(`INVALID_NOTIFICATION_PAYLOAD: ${detail}`);
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  if (!isValidEmail(p.to)) fail("to must be an email address");
  if (!isNonEmptyString(p.customer_name)) fail("customer_name is required");
  if (!isNonEmptyString(p.order_reference)) fail("order_reference is required");
  const base = {
    to: (p.to as string).trim(),
    customer_name: (p.customer_name as string).trim(),
    order_reference: (p.order_reference as string).trim(),
  };
  if (p.template === "payment_approved") {
    if (!Number.isInteger(p.amount_minor) || (p.amount_minor as number) < 0) {
      fail("amount_minor must be a non-negative integer");
    }
    if (!isNonEmptyString(p.currency_code)) fail("currency_code is required");
    const paymentStatus = p.payment_status;
    if (paymentStatus !== "paid" && paymentStatus !== "partially_paid") {
      fail("payment_status must be 'paid' or 'partially_paid'");
    }
    return {
      ...base,
      template: "payment_approved",
      amount_minor: p.amount_minor as number,
      currency_code: (p.currency_code as string).trim().toUpperCase(),
      // Validated just above (fail() throws otherwise).
      payment_status: paymentStatus as "paid" | "partially_paid",
    };
  }
  if (p.template === "payment_rejected") {
    if (!isNonEmptyString(p.reason_code)) fail("reason_code is required");
    if (!isNonEmptyString(p.customer_message)) fail("customer_message is required");
    return {
      ...base,
      template: "payment_rejected",
      reason_code: (p.reason_code as string).trim(),
      customer_message: (p.customer_message as string).trim(),
    };
  }
  return fail("template must be 'payment_approved' or 'payment_rejected'");
}

// -- Enqueue (in-transaction; called from modules/payments/service.ts) -----

export interface EnqueuePaymentApprovedInput {
  submissionId: string;
  orderReference: string;
  customerName: string;
  customerEmail: string | null;
  amountMinor: number;
  currencyCode: string;
  paymentStatus: "paid" | "partially_paid";
  nowIso?: string;
}

export interface EnqueuePaymentRejectedInput {
  submissionId: string;
  orderReference: string;
  customerName: string;
  customerEmail: string | null;
  reasonCode: string;
  customerMessage: string;
  nowIso?: string;
}

function pushEmailOutboxEvent(
  state: DatabaseState,
  input: {
    submissionId: string;
    template: NotificationTemplate;
    payload: NotificationEmailPayload;
    nowIso: string;
  }
): OutboxEventRecord {
  const event: OutboxEventRecord = {
    id: randomUUID(),
    event_key: `email.notification.${input.template}:${input.submissionId}`,
    aggregate_type: "payment_submission",
    aggregate_id: input.submissionId,
    event_type: EMAIL_NOTIFICATION_EVENT_TYPE,
    payload: { ...input.payload },
    status: "pending",
    attempt_count: 0,
    available_at: input.nowIso,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: input.nowIso,
    processed_at: null,
  };
  state.outbox_events.push(event);
  return event;
}

/**
 * Enqueue the payment-approved email. Returns the outbox event, or
 * null when the customer has no email address (nothing to send to).
 * Never throws for a missing address — the approval must not fail
 * because a notification cannot be addressed.
 */
export function enqueuePaymentApprovedNotificationInTx(
  state: DatabaseState,
  input: EnqueuePaymentApprovedInput
): OutboxEventRecord | null {
  const to = input.customerEmail?.trim() || null;
  if (!to) return null;
  const nowIso = input.nowIso ?? new Date().toISOString();
  return pushEmailOutboxEvent(state, {
    submissionId: input.submissionId,
    template: "payment_approved",
    payload: {
      template: "payment_approved",
      to,
      customer_name: input.customerName,
      order_reference: input.orderReference,
      amount_minor: input.amountMinor,
      currency_code: input.currencyCode,
      payment_status: input.paymentStatus,
    },
    nowIso,
  });
}

/**
 * Enqueue the payment-rejected email (with the staff-written reason).
 * Returns the outbox event, or null when the customer has no email
 * address. Never throws for a missing address — the rejection must
 * not fail because a notification cannot be addressed.
 */
export function enqueuePaymentRejectedNotificationInTx(
  state: DatabaseState,
  input: EnqueuePaymentRejectedInput
): OutboxEventRecord | null {
  const to = input.customerEmail?.trim() || null;
  if (!to) return null;
  const nowIso = input.nowIso ?? new Date().toISOString();
  return pushEmailOutboxEvent(state, {
    submissionId: input.submissionId,
    template: "payment_rejected",
    payload: {
      template: "payment_rejected",
      to,
      customer_name: input.customerName,
      order_reference: input.orderReference,
      reason_code: input.reasonCode,
      customer_message: input.customerMessage,
    },
    nowIso,
  });
}

// -- Default deliverer (used by the drain when no emailDeliver is injected) --

/**
 * Build the real SMTP deliverer from the store's drizzle DB and the
 * encryption key — the same `sendStackMateEmail` path password-reset
 * and invite mail use (SMTP settings from Settings → Email).
 *
 * Returns null when the store has no drizzle DB (in-memory/test
 * store): the drain then records the event "simulated" instead of
 * pretending it was sent. `appUrl` is empty because the send path
 * never builds a URL (only the reset/invite builders do, and they
 * are not used here); `keyVersion` is threaded through for
 * completeness — the SMTP load path decrypts with the key only.
 */
export function createDefaultEmailDeliver(
  store: StackMateDataStore,
  config: { encryptionKey: string; keyVersion?: string }
): EmailDeliverFn | null {
  const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
    | Parameters<typeof sendStackMateEmail>[0]
    | undefined;
  if (!db) return null;
  return async (message: NotificationEmail): Promise<SendResult> =>
    sendStackMateEmail(
      db,
      {
        encryptionKey: config.encryptionKey,
        keyVersion: config.keyVersion ?? "v3",
        appUrl: "",
      },
      { to: message.to, subject: message.subject, text: message.text, html: message.html }
    );
}
