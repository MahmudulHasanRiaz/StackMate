import { v } from "./validator.ts";

export const API_VERSION = "v1" as const;

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "GONE",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "PAYMENT_SUBMISSION_ALREADY_REVIEWED",
  "PAYMENT_AMOUNT_MISMATCH",
  "TRANSACTION_ID_REQUIRED",
  "TRANSACTION_ID_DISABLED",
  "TRANSFER_RAIL_NOT_SUPPORTED",
  "DUPLICATE_TRANSACTION_REFERENCE",
  "CROSS_PRODUCT_FEATURE_ERROR",
  "PACKAGE_VERSION_IMMUTABLE",
  "PRICE_IMMUTABLE",
  "INVOICE_IMMUTABLE",
  "LICENSE_INVALID",
  "LICENSE_REVOKED",
  "LICENSE_SUSPENDED",
  "LICENSE_EXPIRED",
  "LICENSE_NOT_YET_VALID",
  "PRODUCT_MISMATCH",
  "ACTIVATION_LIMIT_REACHED",
  "INSTALLATION_NOT_ACTIVE",
  "DOMAIN_NOT_ALLOWED",
  "SUBSCRIPTION_NOT_ACTIVE",
  "TEMPORARY_VALIDATION_UNAVAILABLE",
  "SIGNATURE_INVALID",
  "TIMESTAMP_EXPIRED",
  "NONCE_REPLAYED",
  "CHECKOUT_TOKEN_INVALID",
  "SITE_NOT_AUTHORIZED_FOR_PRODUCT",
  "PURCHASE_EVENT_FORBIDDEN",
  "SSRF_BLOCKED",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMIT_EXCEEDED",
  "TWO_FACTOR_SETUP_REQUIRED",
  "STORE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiMeta {
  request_id: string;
  api_version: typeof API_VERSION;
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiCollectionData<T> {
  items: T[];
  next_cursor: string | null;
}

export type ApiCollectionEnvelope<T> = ApiSuccessEnvelope<ApiCollectionData<T>>;

export interface ApiErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown> | null;
    request_id: string;
  };
}

export function createSuccessEnvelope<T>(data: T, requestId: string): ApiSuccessEnvelope<T> {
  return {
    data,
    meta: {
      request_id: requestId,
      api_version: API_VERSION,
    },
  };
}

export function createCollectionEnvelope<T>(
  items: T[],
  nextCursor: string | null,
  requestId: string
): ApiCollectionEnvelope<T> {
  return {
    data: {
      items,
      next_cursor: nextCursor,
    },
    meta: {
      request_id: requestId,
      api_version: API_VERSION,
    },
  };
}

export function createErrorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: Record<string, unknown> | null = null
): ApiErrorEnvelope {
  return {
    error: {
      code,
      message,
      details,
      request_id: requestId,
    },
  };
}

export interface CursorPayload {
  created_at: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify({ c: payload.created_at, i: payload.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || !parsed.c || !parsed.i) {
      throw new Error("Invalid cursor structure");
    }
    return { created_at: parsed.c, id: parsed.i };
  } catch {
    throw new Error("Malformed pagination cursor.");
  }
}

export const PaginationQuerySchema = v.object(
  {
    limit: v.number().int().min(1).max(100).default(25),
    cursor: v.string().min(1).max(512).optional(),
  },
  { allowUnknown: true }
);
