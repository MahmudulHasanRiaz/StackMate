/**
 * Admin audit routes (Hono) — Hono migration Phase 1.
 *
 * Split out of platform.ts (500-line cap). Audit logs + scheduled
 * jobs. Converted verbatim from app.ts (baseline feat e382d65).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import { sql } from "drizzle-orm";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  decodeCursor,
  encodeCursor,
  formatDisplayDateTimeDDMMYYYY,
} from "../../../../../packages/contracts/src/index.ts";
import { resolveAuditResourceDisplayName } from "../../modules/audit/service.ts";

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

export function registerAdminPlatformAuditRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/audit-logs", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "audit_logs.read", requestId);
    // H-05: server-side filters (like the other list endpoints).
    // ?q= matches action / resource type / resource id / actor /
    // display name; ?action=, ?resource=, ?outcome=, ?actor=
    // filter exact. Unknown params are ignored.
    const query = c.req.query();
    const { q, limit, page } = parseListQuery(query);
    const actionFilter = query.action;
    const resourceFilter = query.resource;
    const outcomeFilter = query.outcome;
    const actorFilter = query.actor;
    const items = store.state.audit_logs
      .filter((a) => (!actionFilter ? true : a.action === actionFilter))
      .filter((a) => (!resourceFilter ? true : a.resource_type === resourceFilter))
      .filter((a) => (!outcomeFilter ? true : a.outcome === outcomeFilter))
      .filter((a) => (!actorFilter ? true : a.actor_user_id === actorFilter))
      .map((a) => ({
        ...a,
        // Human display name for the resource (F3 follow-up): resolved
        // server-side from the in-memory state; null when the resource
        // no longer exists — the SPA falls back to its client-side
        // maps, then a short id. Additive field, no contract break.
        resource_display_name: resolveAuditResourceDisplayName(
          store.state,
          a.resource_type,
          a.resource_id,
          a.actor_user_id,
          // Fix batch #2: the row's own changes carry the identity
          // of deleted resources (webhook URL, pixel-group label,
          // bulk feature keys) — the resolver falls back to them.
          a.changes,
        ),
        created_date_display: formatDisplayDateTimeDDMMYYYY(
          a.created_at,
          env.DEFAULT_TIMEZONE
        ),
      }))
      .filter(
        (a) =>
          includesQuery(a.action, q) ||
          includesQuery(a.resource_type, q) ||
          includesQuery(a.resource_id, q) ||
          includesQuery(a.actor_user_id, q) ||
          includesQuery(a.resource_display_name, q),
      );
    // B-05: cursor pagination (?cursor=) for this append-heavy
    // list — offset paging can skip/duplicate rows as new audit
    // rows are appended. ?cursor= absent keeps the offset path.
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

  // E-21: scheduled-jobs visibility (PRD §22) — runs of the
  // every-minute cron (outbox drain + renewal sweep) and any
  // other scheduled job, read DIRECTLY from the
  // scheduled_job_runs table (Worker C: db/schema/jobs.ts —
  // id, job_key, started_at, finished_at, status, summary,
  // error; index on (job_key, started_at DESC)). Never through
  // the store load. No drizzleDb (in-memory store) → 503; table
  // not migrated yet (42P01) → 503 with a plain message, never
  // a 500. Response: collection of { job_key, started_at,
  // finished_at, status, summary }.


  app.get("/api/v1/admin/jobs", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "audit_logs.read", requestId);
    const { limit, page } = parseListQuery(c.req.query());
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    if (!maybeDrizzle.drizzleDb) {
      throw new AppError(
        "STORE_UNAVAILABLE",
        "Scheduled jobs require a database.",
        503
      );
    }
    const db = maybeDrizzle.drizzleDb as {
      execute: (query: unknown) => Promise<unknown>;
    };
    const offset = (page - 1) * limit;
    let rows: Array<Record<string, unknown>>;
    let total: number;
    try {
      const rowsRes = (await db.execute(
        sql`SELECT job_key, started_at, finished_at, status, summary
             FROM scheduled_job_runs
             ORDER BY started_at DESC
             LIMIT ${limit} OFFSET ${offset}`
      )) as unknown as { rows?: Array<Record<string, unknown>> };
      rows = rowsRes.rows ?? [];
      const countRes = (await db.execute(
        sql`SELECT count(*) AS value FROM scheduled_job_runs`
      )) as unknown as { rows?: Array<Record<string, unknown>> };
      total = Number(countRes.rows?.[0]?.value ?? 0);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "42P01") {
        throw new AppError(
          "STORE_UNAVAILABLE",
          "Scheduled jobs are not available yet (scheduled_job_runs is not migrated).",
          503
        );
      }
      throw err;
    }
    const toIso = (v: unknown): string | null =>
      v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
    return collection(
      c,
      rows.map((r) => ({
        job_key: r.job_key ?? null,
        started_at: toIso(r.started_at),
        finished_at: toIso(r.finished_at),
        status: r.status ?? null,
        summary: (r.summary as Record<string, unknown> | null) ?? null,
      })),
      null,
      200,
      total
    );
  });

}
