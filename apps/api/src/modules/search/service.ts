/**
 * Global search (PLAN §29 / ADR-0010).
 *
 * Pure function over the full store snapshot: every group queries the
 * whole table server-side, so a record at position #500+ is found just
 * like the first one — the per-group cap (8) applies to the RESPONSE,
 * never to the dataset searched. The store loads the full table per
 * request by design; if the store ever paginates at the DB layer, these
 * filters must move into SQL.
 *
 * Permission gating mirrors assertStaffPermission: a super_admin sees
 * every group; anyone else sees only the groups their permissions
 * allow. A group the caller cannot read is omitted, never a 403 for
 * the whole search.
 */
import type { DatabaseState } from "../../platform/db/store.ts";
import type { StaffPrincipal } from "../identity/service.ts";
import {
  GLOBAL_SEARCH_MAX_PER_GROUP,
  GLOBAL_SEARCH_MIN_QUERY_LENGTH,
  type GlobalSearchGroup,
  type GlobalSearchGroupKey,
  type GlobalSearchItem,
} from "../../../../../packages/contracts/src/domains/search.ts";

const GROUP_LABEL: Record<GlobalSearchGroupKey, string> = {
  customers: "Customers",
  orders: "Orders",
  products: "Products",
  licenses: "Licenses",
  subscriptions: "Subscriptions",
  tickets: "Tickets",
  leads: "Leads",
  staff: "Staff",
  sites: "Websites",
};

const GROUP_PERMISSION: Record<GlobalSearchGroupKey, string> = {
  customers: "customers.read",
  orders: "orders.read",
  products: "products.read",
  licenses: "licenses.read",
  subscriptions: "subscriptions.read",
  tickets: "tickets.view",
  leads: "leads.view",
  staff: "users.manage",
  sites: "integrations.manage",
};

function includes(haystack: string | null | undefined, q: string): boolean {
  return (haystack ?? "").toLowerCase().includes(q);
}

function humanizeRoleKey(key: string): string {
  return key
    .split("_")
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function searchGlobal(
  state: DatabaseState,
  principal: StaffPrincipal,
  rawQuery: string,
): GlobalSearchGroup[] {
  const q = rawQuery.trim().toLowerCase();
  if (q.length < GLOBAL_SEARCH_MIN_QUERY_LENGTH) return [];
  const can = (key: GlobalSearchGroupKey): boolean =>
    principal.roles.includes("super_admin") ||
    principal.permissions.includes(GROUP_PERMISSION[key]);
  const cap = <T>(items: T[]): T[] => items.slice(0, GLOBAL_SEARCH_MAX_PER_GROUP);
  const groups: GlobalSearchGroup[] = [];

  // B-13: lookups built ONCE per search instead of `.find`/`.filter`
  // per row — orders/licenses/subscriptions did a customers.find per
  // row, licenses a products.find per row, and staff a
  // user_roles.filter + roles.filter per user.
  const customersById = new Map(state.customers.map((c) => [c.id, c]));
  const productsById = new Map(state.products.map((p) => [p.id, p]));
  const rolesByUserId = new Map<string, string[]>();
  {
    const rolesById = new Map(state.roles.map((r) => [r.id, humanizeRoleKey(r.key)]));
    for (const ur of state.user_roles) {
      const label = rolesById.get(ur.role_id);
      if (!label) continue;
      const list = rolesByUserId.get(ur.user_id);
      if (list) list.push(label);
      else rolesByUserId.set(ur.user_id, [label]);
    }
  }

  if (can("customers")) {
    const items: GlobalSearchItem[] = cap(
      state.customers.filter(
        (c) =>
          includes(c.name, q) ||
          includes(c.email, q) ||
          includes(c.customer_number, q) ||
          includes(c.company_name, q) ||
          includes(c.phone, q) ||
          (q.replace(/\D/g, "").length > 0 &&
            (c.normalized_phone ?? "")
              .replace(/\D/g, "")
              .includes(q.replace(/\D/g, ""))),
      ),
    ).map((c) => ({
      type: "customers" as const,
      id: c.id,
      label: c.name,
      sublabel: [c.email, c.phone].filter(Boolean).join(" · ") || c.customer_number,
      to: `/customers/${c.id}`,
    }));
    if (items.length > 0) groups.push({ key: "customers", label: GROUP_LABEL.customers, items });
  }

  if (can("orders")) {
    const items: GlobalSearchItem[] = cap(
      state.orders.filter(
        (o) =>
          includes(o.order_number, q) ||
          includes(o.public_reference, q) ||
          includes(customersById.get(o.customer_id)?.name, q),
      ),
    ).map((o) => {
      const customer = customersById.get(o.customer_id);
      return {
        type: "orders" as const,
        id: o.id,
        label: o.order_number,
        sublabel: customer ? customer.name : null,
        to: `/orders/${o.id}`,
      };
    });
    if (items.length > 0) groups.push({ key: "orders", label: GROUP_LABEL.orders, items });
  }

  if (can("products")) {
    const items: GlobalSearchItem[] = cap(
      state.products.filter((p) => includes(p.name, q) || includes(p.code, q)),
    ).map((p) => ({
      type: "products" as const,
      id: p.id,
      label: p.name,
      sublabel: p.code,
      to: `/products/${p.id}`,
    }));
    if (items.length > 0) groups.push({ key: "products", label: GROUP_LABEL.products, items });
  }

  if (can("licenses")) {
    const items: GlobalSearchItem[] = cap(
      state.licenses.filter(
        (l) =>
          includes(l.license_number, q) ||
          includes(customersById.get(l.customer_id)?.name, q) ||
          includes(productsById.get(l.product_id)?.code, q),
      ),
    ).map((l) => {
      const customer = customersById.get(l.customer_id);
      const product = productsById.get(l.product_id);
      return {
        type: "licenses" as const,
        id: l.id,
        label: l.license_number,
        sublabel: [customer?.name, product?.code].filter(Boolean).join(" · ") || null,
        to: `/licenses/${l.id}`,
      };
    });
    if (items.length > 0) groups.push({ key: "licenses", label: GROUP_LABEL.licenses, items });
  }

  if (can("subscriptions")) {
    const items: GlobalSearchItem[] = cap(
      state.subscriptions.filter(
        (s) =>
          includes(s.subscription_number, q) ||
          includes(customersById.get(s.customer_id)?.name, q),
      ),
    ).map((s) => {
      const customer = customersById.get(s.customer_id);
      return {
        type: "subscriptions" as const,
        id: s.id,
        label: s.subscription_number,
        sublabel: customer ? customer.name : null,
        to: `/subscriptions/${s.id}`,
      };
    });
    if (items.length > 0)
      groups.push({ key: "subscriptions", label: GROUP_LABEL.subscriptions, items });
  }

  if (can("tickets")) {
    const items: GlobalSearchItem[] = cap(
      state.support_tickets.filter(
        (t) =>
          includes(t.ticket_number, q) ||
          includes(t.title, q) ||
          includes(t.description, q),
      ),
    ).map((t) => ({
      type: "tickets" as const,
      id: t.id,
      label: `${t.ticket_number} — ${t.title}`,
      sublabel: t.status.replace(/_/g, " "),
      to: `/tickets/${t.id}`,
    }));
    if (items.length > 0) groups.push({ key: "tickets", label: GROUP_LABEL.tickets, items });
  }

  if (can("leads")) {
    const items: GlobalSearchItem[] = cap(
      state.leads.filter(
        (l) =>
          includes(l.name, q) || includes(l.email, q) || includes(l.phone, q) || includes(l.interest, q),
      ),
    ).map((l) => ({
      type: "leads" as const,
      id: l.id,
      label: l.name,
      sublabel: [l.email, l.phone].filter(Boolean).join(" · ") || null,
      to: `/leads/${l.id}`,
    }));
    if (items.length > 0) groups.push({ key: "leads", label: GROUP_LABEL.leads, items });
  }

  if (can("staff")) {
    const items: GlobalSearchItem[] = cap(
      state.users.filter((u) => includes(u.name, q) || includes(u.email, q)),
    ).map((u) => {
      const roles = rolesByUserId.get(u.id) ?? [];
      return {
        type: "staff" as const,
        id: u.id,
        label: u.name,
        sublabel: u.email || null,
        badge: roles.join(", ") || null,
        to: `/staff/${u.id}`,
      };
    });
    if (items.length > 0) groups.push({ key: "staff", label: GROUP_LABEL.staff, items });
  }

  if (can("sites")) {
    const items: GlobalSearchItem[] = cap(
      state.integrated_sites.filter(
        (s) =>
          includes(s.name, q) ||
          includes(s.site_key, q) ||
          s.domains.some((d) => includes(d.domain, q)),
      ),
    ).map((s) => ({
      type: "sites" as const,
      id: s.id,
      label: s.name,
      sublabel: s.domains[0]?.domain ?? s.site_key,
      to: `/settings/websites/${s.id}`,
    }));
    if (items.length > 0) groups.push({ key: "sites", label: GROUP_LABEL.sites, items });
  }

  return groups;
}
