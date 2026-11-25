/**
 * Admin support-ticket routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~5129–5330).
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
import type { StackMateDataStore } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  addTicketCommentByAdmin,
  assignTicketByAdmin,
  createTicketByAdmin,
  transitionTicketByAdmin,
  updateTicketByAdmin,
} from "../../modules/tickets/service.ts";

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

// Assignee disambiguation (fix batch 2026-11-17, ADR-0009 decision 11):
// two staff can share a name — list + detail embed the assignee's email
// and role keys next to the name.
function staffContactFor(store: StackMateDataStore, userId: string | null) {
  if (!userId) return { email: null, roles: [] as string[] };
  const user = store.state.users.find((u) => u.id === userId);
  if (!user) return { email: null, roles: [] as string[] };
  const roleIds = new Set(
    store.state.user_roles
      .filter((ur) => ur.user_id === user.id)
      .map((ur) => ur.role_id)
  );
  const roles = store.state.roles
    .filter((r) => roleIds.has(r.id))
    .map((r) => r.key);
  return { email: user.email, roles };
}

export function registerAdminTicketsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/tickets", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
    const query = c.req.query();
    const statusFilter = query.status;
    const priorityFilter = query.priority;
    const customerFilter = query.customer_id;
    const assigneeFilter = query.assignee_user_id;
    const q = query.q?.trim().toLowerCase() ?? "";
    const { limit, page } = parseListQuery(query);
    const items = store.state.support_tickets
      .filter((t) => (!statusFilter ? true : t.status === statusFilter))
      .filter((t) => (!priorityFilter ? true : t.priority === priorityFilter))
      .filter((t) => (!customerFilter ? true : t.customer_id === customerFilter))
      .filter((t) => (!assigneeFilter ? true : t.assignee_user_id === assigneeFilter))
      .filter((t) =>
        !q
          ? true
          : t.ticket_number.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            (t.description ?? "").toLowerCase().includes(q)
      )
      .map((t) => ({
        ...t,
        customer: t.customer_id
          ? (store.state.customers.find((c2) => c2.id === t.customer_id) ?? null)
          : null,
        assignee_name: t.assignee_user_id
          ? (store.state.users.find((u) => u.id === t.assignee_user_id)?.name ?? null)
          : null,
        assignee_email: staffContactFor(store, t.assignee_user_id).email,
        assignee_roles: staffContactFor(store, t.assignee_user_id).roles,
      }));
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/tickets", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
    const body = await readJsonBody(c);
    const ticket = await createTicketByAdmin(store, principal, body, requestId);
    return ok(c, ticket, 201);
  });

  app.get("/api/v1/admin/tickets/:ticketId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
    const ticket = store.state.support_tickets.find(
      (t) => t.id === c.req.param("ticketId")
    );
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
    const linked = {
      order: ticket.order_id
        ? (store.state.orders.find((o) => o.id === ticket.order_id) ?? null)
        : null,
      subscription: ticket.subscription_id
        ? (store.state.subscriptions.find((s) => s.id === ticket.subscription_id) ?? null)
        : null,
      license: ticket.license_id
        ? (store.state.licenses.find((l) => l.id === ticket.license_id) ?? null)
        : null,
      product: ticket.product_id
        ? (store.state.products.find((p) => p.id === ticket.product_id) ?? null)
        : null,
    };
    return ok(c, {
      ...ticket,
      customer: ticket.customer_id
        ? (store.state.customers.find((cu) => cu.id === ticket.customer_id) ?? null)
        : null,
      reporter_name: store.state.users.find((u) => u.id === ticket.reporter_user_id)
        ?.name ?? null,
      assignee_name: ticket.assignee_user_id
        ? (store.state.users.find((u) => u.id === ticket.assignee_user_id)?.name ?? null)
        : null,
      assignee_email: staffContactFor(store, ticket.assignee_user_id).email,
      assignee_roles: staffContactFor(store, ticket.assignee_user_id).roles,
      comments: store.state.ticket_comments
        .filter((cm) => cm.ticket_id === ticket.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((cm) => ({
          ...cm,
          author_name:
            store.state.users.find((u) => u.id === cm.author_user_id)?.name ?? null,
        })),
      linked,
    });
  });

  app.patch("/api/v1/admin/tickets/:ticketId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateTicketByAdmin(
      store,
      principal,
      c.req.param("ticketId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/tickets/:ticketId/transition", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await transitionTicketByAdmin(
      store,
      principal,
      c.req.param("ticketId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/tickets/:ticketId/assign", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await assignTicketByAdmin(
      store,
      principal,
      c.req.param("ticketId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  app.post("/api/v1/admin/tickets/:ticketId/comments", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
    const body = await readJsonBody(c);
    const comment = await addTicketCommentByAdmin(
      store,
      principal,
      c.req.param("ticketId"),
      body,
      requestId
    );
    return ok(c, comment, 201);
  });
}
