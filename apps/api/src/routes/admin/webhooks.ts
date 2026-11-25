/**
 * Admin webhook + outbox routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~6970–7160):
 * webhook endpoints (+ delete, rotate, test, deliveries),
 * outbox-events (+ replay) and outbox dispatch. Service layer,
 * validators and envelopes are unchanged — only the HTTP plumbing
 * moved. Auth / CSRF / rate-limit middleware (Worker 3, hono/*)
 * provides c.var.requestId / env / store / principal; the per-route
 * permission checks below are preserved from app.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  decodeCursor,
  encodeCursor,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  createRealWebhookTransport,
  deleteWebhookEndpointByAdmin,
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
  replayOutboxEventByAdmin,
  rotateWebhookSecret,
  testWebhookEndpointByAdmin,
  updateWebhookEndpoint,
} from "../../modules/webhooks/service.ts";

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

const includesQuery = (
  haystack: string | null | undefined,
  q: string
): boolean => (!q ? true : (haystack ?? "").toLowerCase().includes(q));

// B-05: cursor pagination for the append-heavy lists (audit logs,
// tracking events, outbox). Offset paging over append-heavy tables
// can skip/duplicate rows between pages as rows are inserted; a
// cursor pins the position. Rows are newest-first
// (created_at DESC, id DESC tiebreak); the cursor is the last row
// of the previous page. A malformed ?cursor= is a 400, never a
// silent restart from page 1.
function applyCursorPage<T extends { id: string; created_at: string }>(
  sortedDesc: T[],
  limit: number,
  cursor: string | null
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor !== null && cursor !== "") {
    let decoded: { created_at: string; id: string };
    try {
      decoded = decodeCursor(cursor);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Malformed pagination cursor.", 400);
    }
    start = sortedDesc.findIndex(
      (row) =>
        row.created_at < decoded.created_at ||
        (row.created_at === decoded.created_at && row.id < decoded.id)
    );
    if (start === -1) return { page: [], nextCursor: null };
  }
  const page = sortedDesc.slice(start, start + limit);
  const nextCursor =
    page.length === limit && start + limit < sortedDesc.length
      ? encodeCursor({
          created_at: page[page.length - 1]!.created_at,
          id: page[page.length - 1]!.id,
        })
      : null;
  return { page, nextCursor };
}

// Newest-first sort shared by the cursor-paged lists (created_at
// DESC, id DESC tiebreak — the same order applyCursorPage assumes).
function sortNewestFirst<T extends { id: string; created_at: string }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
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

export function registerAdminWebhooksRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/webhooks", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // L-6: read-only roles hold integrations.read (migration 0016).
    await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
    const endpoints = store.state.webhook_endpoints.map(
      ({ secret_ciphertext: _, ...safe }) => safe
    );
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(c, endpoints, limit, page);
  });

  app.post("/api/v1/admin/webhooks", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = await readJsonBody(c);
    const created = await registerWebhookEndpointByAdmin(store, principal, body, {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
      allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
      requestId,
    });
    return ok(c, created, 201);
  });

  app.delete("/api/v1/admin/webhooks/:webhookId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const deleted = await deleteWebhookEndpointByAdmin(
      store,
      principal,
      c.req.param("webhookId"),
      requestId
    );
    return ok(c, deleted);
  });

  // E-17: edit a webhook endpoint (PRD §16; coverage P2) — URL +
  // subscribed events only; the secret is untouched (rotation is
  // the separate POST .../rotate below).
  app.patch("/api/v1/admin/webhooks/:webhookId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    // The service reads url / description / subscribed_events
    // (or subscribedEvents) off the raw body — pass it through.
    const body = await readJsonBody(c);
    const updated = await updateWebhookEndpoint(
      store,
      principal,
      c.req.param("webhookId"),
      body,
      {
        allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
        requestId,
      }
    );
    return ok(c, updated);
  });

  // E-04: rotate a webhook secret (API spec §18.6) — mirrors the
  // site-credential rotate pattern: a new secret is issued
  // (shown once by the service), the old one retires.
  app.post("/api/v1/admin/webhooks/:webhookId/rotate", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const result = await rotateWebhookSecret(
      store,
      principal,
      c.req.param("webhookId"),
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        requestId,
      }
    );
    return ok(c, result);
  });

  // Batch 1: webhook test delivery + delivery history + outbox reads/replay.
  app.post("/api/v1/admin/webhooks/:webhookId/test", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const result = await testWebhookEndpointByAdmin(store, principal, c.req.param("webhookId"), {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
      requestId,
    });
    return ok(c, result);
  });

  app.get("/api/v1/admin/webhooks/:webhookId/deliveries", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // L-6: read-only roles hold integrations.read (migration 0016).
    await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
    const endpoint = store.state.webhook_endpoints.find(
      (ep) => ep.id === c.req.param("webhookId")
    );
    if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(
      c,
      store.state.webhook_deliveries.filter(
        (d) => d.webhook_endpoint_id === endpoint.id
      ),
      limit,
      page
    );
  });

  app.get("/api/v1/admin/outbox-events", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // L-6: read-only roles hold integrations.read (migration 0016).
    await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
    const query = c.req.query();
    const statusFilter = query.status;
    // Server-side `?q=` (search batch): matches event_key /
    // event_type / aggregate_type / aggregate_id / status
    // substrings, case-insensitive — the same `includesQuery`
    // helper every other list endpoint uses, so a match past the
    // loaded window is never missed. event_key MUST be in the
    // list: it is the first column the user reads, and for the
    // CAPI rows it carries words the event_type does not
    // (event_key "meta_capi.purchase:<id>" vs event_type
    // "tracking.meta_capi.dispatch" — "purchase" matched nothing
    // live until this was added, 2026-11-22).
    const { q, limit, page } = parseListQuery(query);
    const items = store.state.outbox_events
      .filter((e) => (!statusFilter ? true : e.status === statusFilter))
      .filter(
        (e) =>
          includesQuery(e.event_key, q) ||
          includesQuery(e.event_type, q) ||
          includesQuery(e.aggregate_type, q) ||
          includesQuery(e.aggregate_id, q) ||
          includesQuery(e.status, q),
      );
    // B-05: cursor pagination (?cursor=) — see audit-logs.
    const cursorParam = query.cursor ?? null;
    if (cursorParam !== null) {
      const { page: cursorPage, nextCursor } = applyCursorPage(
        sortNewestFirst(items),
        limit,
        cursorParam
      );
      return collection(c, cursorPage, nextCursor, 200, items.length);
    }
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/outbox-events/:eventId/replay", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const replayed = await replayOutboxEventByAdmin(
      store,
      principal,
      c.req.param("eventId"),
      requestId
    );
    return ok(c, replayed);
  });

  app.post("/api/v1/admin/outbox/dispatch", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    // C-2: pass the real transport — without it the dispatcher
    // runs simulated and records "simulated" (never "delivered").
    const summary = await processTransactionalOutboxBatch(store, {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
      transport: createRealWebhookTransport({
        allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
      }),
    });
    return ok(c, summary);
  });
}
