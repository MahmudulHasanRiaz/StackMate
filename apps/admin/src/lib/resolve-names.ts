/**
 * Display-name resolution for audit-log / outbox UUIDs (F3 + F6,
 * 2026-11-16). The API returns raw ids (actor_user_id, resource_id,
 * aggregate_id); the tables must show HUMAN names instead of UUIDs.
 * These hooks join client-side against the same lists the sections
 * already fetch (same TanStack query keys, so no duplicate requests):
 * staff users, integrated sites, webhook endpoints, invitations.
 * Unknown ids fall back to a SHORT id (first 8 chars) — never the
 * full UUID wrapping over three lines.
 */
import { useMemo } from "react";
import { useAdminList } from "./section-kit";

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** "webhook_endpoint" -> "Webhook endpoint". */
export function humanizeType(type: string): string {
  return type
    .split("_")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

interface IdName {
  id: string;
  name: string;
}

function toMap(items: IdName[] | undefined): Map<string, string> {
  return new Map((items ?? []).map((i) => [i.id, i.name]));
}

export function useStaffNameMap(): Map<string, string> {
  const q = useAdminList<{ id: string; name: string }>(
    "staff-users",
    "/api/v1/admin/users",
  );
  return useMemo(() => toMap(q.data), [q.data]);
}

export function useSiteNameMap(): Map<string, string> {
  const q = useAdminList<{ id: string; name: string }>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );
  return useMemo(() => toMap(q.data), [q.data]);
}

export function useWebhookUrlMap(): Map<string, string> {
  const q = useAdminList<{ id: string; url: string }>(
    "webhooks",
    "/api/v1/admin/webhooks",
  );
  return useMemo(
    () => new Map((q.data ?? []).map((w) => [w.id, w.url])),
    [q.data],
  );
}

export function useInvitationEmailMap(): Map<string, string> {
  const q = useAdminList<{ id: string; email: string }>(
    "staff-invitations",
    "/api/v1/admin/users/invitations",
  );
  return useMemo(
    () => new Map((q.data ?? []).map((i) => [i.id, i.email])),
    [q.data],
  );
}

export interface ResourceMaps {
  staff: Map<string, string>;
  sites: Map<string, string>;
  webhooks: Map<string, string>;
  invitations: Map<string, string>;
}

export function useResourceMaps(): ResourceMaps {
  const staff = useStaffNameMap();
  const sites = useSiteNameMap();
  const webhooks = useWebhookUrlMap();
  const invitations = useInvitationEmailMap();
  return useMemo(
    () => ({ staff, sites, webhooks, invitations }),
    [staff, sites, webhooks, invitations],
  );
}

/**
 * Human display for a resource id, or null when no name is known
 * (callers fall back to shortId). Resource types with no global list
 * (credential, domain, product, …) intentionally return null — their
 * ids stay short, never full UUIDs.
 */
export function resolveResourceName(
  resourceType: string,
  resourceId: string,
  maps: ResourceMaps,
): string | null {
  switch (resourceType) {
    case "user":
    case "staff_user":
      return maps.staff.get(resourceId) ?? null;
    case "integrated_site":
      return maps.sites.get(resourceId) ?? null;
    case "webhook_endpoint":
      return maps.webhooks.get(resourceId) ?? null;
    case "staff_invitation":
      return maps.invitations.get(resourceId) ?? null;
    default:
      return null;
  }
}
