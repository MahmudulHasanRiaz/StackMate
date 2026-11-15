import { randomUUID } from "node:crypto";
import type { AuditLogRecord, DatabaseState } from "../../platform/db/store.ts";

const REDACTED_KEYS = new Set([
  "password",
  "password_hash",
  "secret",
  "secret_hash",
  "secret_ciphertext",
  "access_token",
  "access_token_ciphertext",
  "license_key",
  "license_key_hash",
  "checkout_access_token",
  "token",
]);

export function sanitizeAuditChanges(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = sanitizeAuditChanges(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function appendAuditLog(
  state: DatabaseState,
  entry: {
    actor_type: "staff" | "system" | "integration";
    actor_user_id?: string | null;
    integrated_site_id?: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    outcome: "success" | "denied" | "failed";
    request_id: string;
    changes?: Record<string, unknown>;
  }
): AuditLogRecord {
  const record: AuditLogRecord = {
    id: randomUUID(),
    actor_type: entry.actor_type,
    actor_user_id: entry.actor_user_id ?? null,
    integrated_site_id: entry.integrated_site_id ?? null,
    action: entry.action,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id,
    outcome: entry.outcome,
    request_id: entry.request_id,
    changes: sanitizeAuditChanges(entry.changes ?? {}),
    created_at: new Date().toISOString(),
  };
  state.audit_logs.unshift(record);
  return record;
}
