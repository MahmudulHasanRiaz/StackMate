/**
 * Admin payment-approval routes (Hono) — Hono migration Phase 1.
 *
 * Split out of payments.ts (500-line cap). Submission approve/reject
 * + manual refund creation (all A-04 idempotent). Converted verbatim
 * from app.ts (baseline feat e382d65).
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createSuccessEnvelope,
  RecordManualRefundSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  sha256Hex,
} from "../../platform/crypto/index.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  approvePaymentSubmissionByStaff,
  recordManualRefundByAdmin,
  rejectPaymentSubmissionByStaff,
} from "../../modules/payments/service.ts";

// --- HTTP plumbing copied from app.ts handleRequest (closures there) ---

function requirePrincipal(c: Context<AppEnv>): StaffPrincipal {
  const principal = c.var.principal;
  if (!principal) {
    throw new AppError(
      "UNAUTHORIZED",
      "Valid staff authentication session required.",
      401
    );
  }
  return principal;
}

function ok<T>(c: Context<AppEnv>, data: T, status = 200): Response {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status as ContentfulStatusCode);
}

const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

async function readJsonBody(c: Context<AppEnv>): Promise<any> {
  const body = c.req.raw.body;
  if (!body) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Request payload exceeds limit.",
        413
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim() === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is not valid JSON.",
      400
    );
  }
}

// A-04: dispatcher-level idempotency (see app.ts runIdempotentCommand
// header for the reserve → execute → complete protocol). Copied
// verbatim, store passed explicitly instead of closed over.

async function runIdempotentCommand<T>(
  store: StackMateDataStore,
  options: {
    scope: string;
    key: string | null | undefined;
    payload: unknown;
    statusCode: number;
    fn: () => Promise<T>;
    redactForStore?: (body: T) => unknown;
    reissueOnReplay?: (storedBody: unknown) => Promise<T> | T;
  }
): Promise<{ status: number; body: T; replayed: boolean }> {
  const rawKey = options.key?.trim() ?? "";
  if (rawKey === "") {
    return { status: options.statusCode, body: await options.fn(), replayed: false };
  }
  if (rawKey.length < 8 || rawKey.length > 128) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Idempotency-Key header must be between 8 and 128 characters.",
      400
    );
  }
  const requestHash = sha256Hex(JSON.stringify(options.payload ?? {}));
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const findRecord = (state: typeof store.state) =>
    state.idempotency_records.find(
      (r) => r.scope_key === options.scope && r.idempotency_key === rawKey
    );
  const reserved = await store.withTransaction((state) => {
    const existing = findRecord(state);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with a different request payload.",
          409
        );
      }
      if (existing.status === "processing") {
        throw new AppError(
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is currently processing.",
          409
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

export function registerAdminPaymentApprovalsRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/admin/payment-submissions/:submissionId/approve", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
    const body = await readJsonBody(c);
    // A-04: approval is idempotent per Idempotency-Key. The
    // stored replay body must NEVER hold plaintext license keys
    // (A-03 class): issued_license_key_once values are stored
    // ENCRYPTED under the master key (same at-rest protection as
    // site credential secrets) and decrypted on replay.
    const submissionId = c.req.param("submissionId");
    const approved = await runIdempotentCommand(store, {
      scope: `admin_payment_approve:${submissionId}`,
      key: c.req.header("Idempotency-Key"),
      payload: body,
      statusCode: 200,
      fn: () =>
        approvePaymentSubmissionByStaff(
          store,
          principal,
          submissionId,
          body,
          {
            licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
            requestId,
            timeZone: env.DEFAULT_TIMEZONE,
          }
        ),
      redactForStore: (result) => ({
        ...result,
        issued_licenses: result.issued_licenses.map((il) => ({
          ...il,
          issued_license_key_once: encryptSecretAtRest(
            il.issued_license_key_once,
            env.ENCRYPTION_KEY_V1,
            env.ACTIVE_ENCRYPTION_KEY_VERSION,
            `idempotency:admin_payment_approve:${submissionId}`
          ),
        })),
      }),
      reissueOnReplay: (stored) => {
        const storedResult = stored as {
          issued_licenses?: Array<{
            issued_license_key_once?: string;
            [key: string]: unknown;
          }>;
          [key: string]: unknown;
        };
        return {
          ...storedResult,
          issued_licenses: (storedResult.issued_licenses ?? []).map((il) => ({
            ...il,
            issued_license_key_once: il.issued_license_key_once
              ? decryptSecretAtRest(
                  il.issued_license_key_once,
                  env.ENCRYPTION_KEY_V1,
                  `idempotency:admin_payment_approve:${submissionId}`
                )
              : il.issued_license_key_once,
          })),
        } as Awaited<ReturnType<typeof approvePaymentSubmissionByStaff>>;
      },
    });
    return ok(c, approved.body, 200);
  });


  app.post("/api/v1/admin/payment-submissions/:submissionId/reject", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.reject", requestId);
    const body = await readJsonBody(c);
    // A-04: rejection is idempotent per Idempotency-Key (the
    // response carries no secrets, so the stored body is used
    // as-is on replay).
    const submissionId = c.req.param("submissionId");
    const rejected = await runIdempotentCommand(store, {
      scope: `admin_payment_reject:${submissionId}`,
      key: c.req.header("Idempotency-Key"),
      payload: body,
      statusCode: 200,
      fn: () =>
        rejectPaymentSubmissionByStaff(
          store,
          principal,
          submissionId,
          body,
          requestId
        ),
    });
    return ok(c, rejected.body, 200);
  });

  // Refunds (D-4 / F-03): manual refunds only — no gateway.
  // The service records the refund, reverses it out of
  // installments newest-first, adjusts the order balance and
  // writes the audit row; the route validates the envelope with
  // RecordManualRefundSchema and gates on payments.approve.


  app.post("/api/v1/admin/refunds", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
    const body = await readJsonBody(c);
    const parsed = RecordManualRefundSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        parsed.issues[0]?.message ?? "Invalid refund request.",
        422,
      );
    }
    // exactOptionalPropertyTypes: the schema's optional fields
    // parse to `undefined` when absent; the service input takes
    // `string | null`, so normalize absent to null (the refine
    // above guarantees exactly one of the two ids is set).
    // A-04: manual refunds are idempotent per Idempotency-Key —
    // a retried refund replays the first instead of refunding
    // twice. (assertStaffPermission here is swapped to the
    // audited variant by F-01 below.)
    const created = await runIdempotentCommand(store, {
      scope: "admin_refund_create",
      key: c.req.header("Idempotency-Key"),
      payload: {
        ...parsed.data,
        payment_transaction_id: parsed.data.payment_transaction_id ?? null,
        order_id: parsed.data.order_id ?? null,
        provider_refund_id: parsed.data.provider_refund_id ?? null,
      },
      statusCode: 201,
      fn: () =>
        recordManualRefundByAdmin(
          store,
          principal,
          {
            ...parsed.data,
            payment_transaction_id: parsed.data.payment_transaction_id ?? null,
            order_id: parsed.data.order_id ?? null,
            provider_refund_id: parsed.data.provider_refund_id ?? null,
          },
          requestId
        ),
    });
    return ok(c, created.body, created.replayed ? 200 : 201);
  });

}
