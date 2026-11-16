import { randomUUID } from "node:crypto";
import { formatMinorMoney } from "../../../../../packages/contracts/src/index.ts";
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

/**
 * Human display name for an audit-log resource (F3 follow-up, 2026-11-16).
 *
 * WHY SERVER-SIDE (decision, same batch): the client-side maps in
 * `apps/admin/src/lib/resolve-names.ts` only cover the four flat lists
 * the audit page already fetches (staff, sites, webhooks, invitations).
 * Covering the rest client-side would need a 3-level fan-out
 * (products → packages → versions → prices; sites → credentials /
 * tracking configs) plus a sessions lookup for which NO admin list
 * endpoint exists at all. The audit list already enriches rows with a
 * display-only field (`created_date_display`), so this follows the
 * same additive pattern: one in-memory lookup per row, no extra HTTP
 * requests, no waterfall, no migration, no contract break. The field
 * is `resource_display_name: string | null` on each row; null means
 * the resource no longer exists (hard-deleted) or the type has no
 * lookup — callers fall back to the client-side maps, then a short id.
 * Nothing here exposes a secret: only names, numbers, URLs, and
 * public identifiers are returned (never tokens, hashes, or ciphers).
 */
export function resolveAuditResourceDisplayName(
  state: DatabaseState,
  resourceType: string,
  resourceId: string,
  actorUserId?: string | null,
  // The row's own changes payload (fix batch #2): deleted resources
  // are gone from state, but their identity is usually IN the row
  // (the URL a webhook was registered/deleted with, the label a pixel
  // group was created/deleted with, the feature keys a bulk create
  // logged). The resolver prefers live state, then the row payload.
  changes?: Record<string, unknown> | null,
): string | null {
  const userName = (id: string | null | undefined): string | null =>
    id ? (state.users.find((u) => u.id === id)?.name ?? null) : null;
  // A changes value is usable as a display fragment only when it is a
  // non-empty string — never a nested object, array, or secret.
  const changeString = (key: string): string | null => {
    const v = changes?.[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  switch (resourceType) {
    case "auth_config":
      // Authentication settings are a singleton (resource_id is the
      // literal "auth-config"); the changes payload says what changed.
      return "Authentication settings";
    case "general_settings":
      // General settings are a singleton (resource_id "general-settings").
      return "General settings";
    case "user":
    case "staff_user":
      return userName(resourceId);
    case "integrated_site":
      return (
        state.integrated_sites.find((s) => s.id === resourceId)?.name ?? null
      );
    case "webhook_endpoint": {
      const live =
        state.webhook_endpoints.find((w) => w.id === resourceId)?.url ?? null;
      if (live) return live;
      // Deleted endpoints: registered + deleted rows carry the URL in
      // changes. Tested rows carry no URL — only the delivery outcome
      // — so they read as a test event, never a bare UUID.
      const url = changeString("url");
      if (url) return url;
      const status = changes?.http_status;
      if (typeof status === "number") return `Webhook test · HTTP ${status}`;
      return null;
    }
    case "staff_invitation":
      return (
        state.staff_invitations.find((i) => i.id === resourceId)?.email ??
        null
      );
    case "product":
      return state.products.find((p) => p.id === resourceId)?.name ?? null;
    case "product_feature": {
      const live =
        state.product_features.find((f) => f.id === resourceId)?.name ?? null;
      if (live) return live;
      // bulk_created rows log the PRODUCT id as the resource id (one
      // summary row for N features) — resolve the parent product name.
      // The row's changes carry created_count + feature_keys.
      const product = state.products.find((p) => p.id === resourceId);
      if (product) {
        const count = changes?.created_count;
        return typeof count === "number" && count > 0
          ? `${product.name} · ${count} features`
          : product.name;
      }
      const name = changeString("name");
      if (name) return name;
      const key = changeString("feature_key");
      if (key) return key;
      const keys = changes?.feature_keys;
      if (Array.isArray(keys) && keys.length > 0) return `${keys.length} features`;
      return null;
    }
    case "product_package":
      return (
        state.product_packages.find((p) => p.id === resourceId)?.name ?? null
      );
    case "package_version": {
      const v = state.package_versions.find((x) => x.id === resourceId);
      if (!v) return null;
      const pkg = state.product_packages.find((p) => p.id === v.package_id);
      return pkg ? `v${v.version_number} · ${pkg.name}` : `v${v.version_number}`;
    }
    case "package_price": {
      const pr = state.package_prices.find((x) => x.id === resourceId);
      if (!pr) return null;
      const v = state.package_versions.find(
        (x) => x.id === pr.package_version_id,
      );
      const pkg = v
        ? state.product_packages.find((p) => p.id === v.package_id)
        : undefined;
      const amount = formatMinorMoney(pr.amount_minor, pr.currency_code);
      const interval =
        pr.price_kind === "recurring" && pr.interval_unit
          ? ` / ${pr.interval_count ?? 1} ${pr.interval_unit}${(pr.interval_count ?? 1) > 1 ? "s" : ""}`
          : "";
      const where = pkg && v ? ` · ${pkg.name} v${v.version_number}` : "";
      return `${amount}${interval}${where}`;
    }
    case "customer":
      return state.customers.find((c) => c.id === resourceId)?.name ?? null;
    case "order":
      return (
        state.orders.find((o) => o.id === resourceId)?.order_number ?? null
      );
    case "subscription":
      return (
        state.subscriptions.find((s) => s.id === resourceId)
          ?.subscription_number ?? null
      );
    case "license":
      return (
        state.licenses.find((l) => l.id === resourceId)?.license_number ??
        null
      );
    case "payment_method":
      return (
        state.payment_methods.find((m) => m.id === resourceId)?.display_name ??
        null
      );
    case "payment_provider":
      return (
        state.payment_providers.find((p) => p.id === resourceId)
          ?.display_name ?? null
      );
    case "payment_submission": {
      const s = state.payment_submissions.find((x) => x.id === resourceId);
      if (!s) return null;
      const order = state.orders.find((o) => o.id === s.order_id);
      const amount = formatMinorMoney(s.amount_minor, s.currency_code);
      return order ? `${amount} · Order ${order.order_number}` : amount;
    }
    case "invoice":
      return (
        state.invoices.find((i) => i.id === resourceId)?.invoice_number ??
        null
      );
    case "role":
      return state.roles.find((r) => r.id === resourceId)?.name ?? null;
    case "site_credential":
      return (
        state.site_credentials.find((c) => c.id === resourceId)?.key_id ?? null
      );
    case "tracking_configuration": {
      const t = state.tracking_configurations.find(
        (x) => x.id === resourceId,
      );
      if (t) return t.label ?? `${t.provider} pixel ${t.pixel_id}`;
      // Deleted groups: created/deleted rows carry label + pixel_id in
      // changes. Updated (toggle) rows carry only site_id + the changed
      // fields — the group's own identity is unrecoverable from the
      // row, so they fall back to the site name (the update action now
      // also writes the identity into changes, so future toggle rows
      // resolve via the label branch above).
      const label = changeString("label");
      if (label) return label;
      const provider = changeString("provider");
      const pixelId = changeString("pixel_id");
      if (provider && pixelId) return `${provider} pixel ${pixelId}`;
      if (pixelId) return `Pixel ${pixelId}`;
      const siteId = changeString("site_id");
      const site = siteId
        ? (state.integrated_sites.find((s) => s.id === siteId)?.name ?? null)
        : null;
      return site ? `${site} · Tracking` : null;
    }
    case "session": {
      // sign_in_failed rows carry the attempted email as the id;
      // signed_in rows carry a 12-char session-token prefix; revoke /
      // sign-out rows carry the session id. Resolve in that order, then
      // fall back to the row's actor (the token prefix itself is never
      // returned — only the resolved user name is).
      if (resourceId.includes("@")) return resourceId;
      const byId = state.sessions.find((s) => s.id === resourceId);
      if (byId) return userName(byId.user_id);
      const byToken = state.sessions.find((s) =>
        s.token.startsWith(resourceId),
      );
      if (byToken) return userName(byToken.user_id);
      return userName(actorUserId);
    }
    case "outbox_event": {
      const e = state.outbox_events.find((x) => x.id === resourceId);
      return e ? e.event_type : null;
    }
    default:
      return null;
  }
}
