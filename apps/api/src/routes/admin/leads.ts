/**
 * Admin lead routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~5332–5460).
 * Service layer, validators and envelopes are unchanged — only the
 * HTTP plumbing moved. Auth / CSRF / rate-limit middleware (Worker 3,
 * hono/*) provides c.var.requestId / env / store / principal; the
 * per-route permission checks below are preserved from app.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  assignLeadByAdmin,
  convertLeadByAdmin,
  createLeadByAdmin,
  transitionLeadByAdmin,
  updateLeadByAdmin,
} from "../../modules/leads/service.ts";

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

function collection<T>(
  c: Context<AppEnv>,
  items: T[],
  nextCursor: string | null = null,
  status = 200,
  total?: number
): Response {
  return c.json(
    createCollectionEnvelope(items, nextCursor, c.var.requestId, total),
    status as ContentfulStatusCode
  );
}

function parseListQuery(query: Record<string, string | undefined>): {
  q: string;
  limit: number;
  page: number;
} {
  const q = query.q?.trim().toLowerCase() ?? "";
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), 100)
      : 25;
  const rawPage = Number(query.page);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { q, limit, page };
}

function applyListPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

function pagedCollection<T>(
  c: Context<AppEnv>,
  filtered: T[],
  limit: number,
  page = 1,
  nextCursor: string | null = null,
  status = 200
): Response {
  return collection(
    c,
    applyListPage(filtered, limit, page),
    nextCursor,
    status,
    filtered.length
  );
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

export function registerAdminLeadsRoutes(app: Hono<AppEnv>): void {
  // Customer+Order batch (ADR-0009): Leads.
  app.get("/api/v1/admin/leads", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "leads.view", requestId);
    const query = c.req.query();
    const statusFilter = query.status;
    const siteFilter = query.source_site_id;
    const campaignFilter = query.utm_campaign;
    const fromFilter = query.from;
    const toFilter = query.to;
    const q = query.q?.trim().toLowerCase() ?? "";
    const { limit, page } = parseListQuery(query);
    const items = store.state.leads
      .filter((l) => (!statusFilter ? true : l.status === statusFilter))
      .filter((l) => (!siteFilter ? true : l.source_site_id === siteFilter))
      .filter((l) => (!campaignFilter ? true : l.utm_campaign === campaignFilter))
      .filter((l) => (!fromFilter ? true : l.created_at.slice(0, 10) >= fromFilter))
      .filter((l) => (!toFilter ? true : l.created_at.slice(0, 10) <= toFilter))
      .filter((l) =>
        !q
          ? true
          : l.name.toLowerCase().includes(q) ||
            (l.email ?? "").toLowerCase().includes(q) ||
            (l.phone ?? "").includes(q) ||
            (l.interest ?? "").toLowerCase().includes(q)
      )
      .map((l) => ({
        ...l,
        source_site: l.source_site_id
          ? (store.state.integrated_sites.find((s) => s.id === l.source_site_id) ?? null)
          : null,
        assignee_name: l.assignee_user_id
          ? (store.state.users.find((u) => u.id === l.assignee_user_id)?.name ?? null)
          : null,
      }));
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/leads", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
    const body = await readJsonBody(c);
    const lead = await createLeadByAdmin(store, principal, body, requestId);
    return ok(c, lead, 201);
  });

  app.get("/api/v1/admin/leads/:leadId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "leads.view", requestId);
    const lead = store.state.leads.find((l) => l.id === c.req.param("leadId"));
    if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
    return ok(c, {
      ...lead,
      source_site: lead.source_site_id
        ? (store.state.integrated_sites.find((s) => s.id === lead.source_site_id) ?? null)
        : null,
      product: lead.product_id
        ? (store.state.products.find((p) => p.id === lead.product_id) ?? null)
        : null,
      assignee_name: lead.assignee_user_id
        ? (store.state.users.find((u) => u.id === lead.assignee_user_id)?.name ?? null)
        : null,
      converted_customer: lead.converted_customer_id
        ? (store.state.customers.find((cu) => cu.id === lead.converted_customer_id) ?? null)
        : null,
      converted_order: lead.converted_order_id
        ? (store.state.orders.find((o) => o.id === lead.converted_order_id) ?? null)
        : null,
    });
  });

  app.patch("/api/v1/admin/leads/:leadId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateLeadByAdmin(
      store,
      principal,
      c.req.param("leadId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/leads/:leadId/transition", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await transitionLeadByAdmin(
      store,
      principal,
      c.req.param("leadId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/leads/:leadId/assign", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await assignLeadByAdmin(
      store,
      principal,
      c.req.param("leadId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/leads/:leadId/convert", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
    const result = await convertLeadByAdmin(
      store,
      principal,
      c.req.param("leadId"),
      requestId
    );
    return ok(c, result);
  });
}
