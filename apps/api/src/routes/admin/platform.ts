/**
 * Admin platform routes (Hono) — Hono migration Phase 1.
 *
 * Payment-evidence asset content + tracking events/test-event.
 * Analytics overview + profit-loss live in platform-analytics.ts,
 * audit logs + jobs in platform-audit.ts. Converted verbatim from
 * app.ts (baseline feat e382d65) — only the HTTP plumbing moved;
 * service layer unchanged.
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
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  decodeCursor,
  encodeCursor,
} from "../../../../../packages/contracts/src/index.ts";
import type { StackMateBindings } from "../../env.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import {
  resolveStorageDriver,
  type DriverDeps,
} from "../../platform/storage/driver.ts";
import { sendTrackingTestEvent } from "../../modules/tracking/service.ts";
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

function driverDepsForRequest(
  store: StackMateDataStore,
  env: StackMateBindings
): DriverDeps {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  const maybeBucket = store as unknown as {
    r2Bucket?: unknown;
    usesInMemoryBucket?: boolean;
  };
  return {
    db: (maybeDrizzle.drizzleDb ?? null) as DriverDeps["db"],
    appEnv: env.APP_ENV,
    r2Bucket: maybeBucket.r2Bucket as DriverDeps["r2Bucket"],
    usesInMemoryBucket: maybeBucket.usesInMemoryBucket,
  };
}

export function registerAdminPlatformRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/assets/:assetId/content", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const asset = store.state.uploaded_assets.find(
      (a) => a.id === c.req.param("assetId")
    );
    if (!asset) throw new AppError("NOT_FOUND", "Asset not found.", 404);
    // L-10: serve through the resolved storage driver (R2 or
    // Local) — the direct r2Bucket.get bypassed the driver
    // selection, so a Local-configured instance 404d here even
    // though the object existed.
    const assetDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
    const obj = await assetDriver.get(asset.object_key);
    if (!obj) throw new AppError("NOT_FOUND", "Object content not found.", 404);
    // A-17: nosniff on evidence downloads, and ?download=1
    // forces a save-as download (like the media content route)
    // instead of inline preview.
    const safeFilename = asset.original_filename.replace(/["\\\r\n]/g, "");
    const evidenceDownload = c.req.query("download") === "1";
    return new Response(obj.bytes, {
      status: 200,
      headers: {
        "Content-Type": asset.content_type,
        "Content-Length": String(obj.size),
        "Cache-Control": "private, no-store",
        "Content-Disposition": evidenceDownload
          ? `attachment; filename="${safeFilename}"`
          : `inline; filename="${safeFilename}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Request-ID": requestId,
      },
    });
  });


  app.get("/api/v1/admin/tracking/events", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // L-6: read-only roles hold tracking.read (migration 0016).
    await assertStaffPermissionAudited(store, principal, "tracking.read", requestId);
    const query = c.req.query();
    const { limit, page } = parseListQuery(query);
    // E-19: dedup flag on every row. Duplicates are never stored
    // (ingest returns the first-seen row instead of inserting a
    // second one), so a stored row is first-seen unless another
    // row shares (site, event_name, event_id) with an earlier
    // created_at — derived here, so the flag stays truthful if
    // duplicates ever do get stored.
    const firstSeenByKey = new Map<string, { created_at: string; id: string }>();
    for (const e of store.state.tracking_events) {
      const key = `${e.integrated_site_id}|${e.event_name}|${e.event_id}`;
      const prev = firstSeenByKey.get(key);
      if (
        !prev ||
        e.created_at < prev.created_at ||
        (e.created_at === prev.created_at && e.id < prev.id)
      ) {
        firstSeenByKey.set(key, { created_at: e.created_at, id: e.id });
      }
    }
    const items = store.state.tracking_events.map((e) => ({
      ...e,
      deduplicated:
        firstSeenByKey.get(`${e.integrated_site_id}|${e.event_name}|${e.event_id}`)
          ?.id !== e.id,
    }));
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

  // E-18: send a tracking test event (PRD §15.6; API spec §17.5
  // — dedup policy must be verified in test events before
  // production). Ingests a synthetic event through the normal
  // pipeline with the pixel group's test code attached.


  app.post("/api/v1/admin/tracking/test-event", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const body = (await readJsonBody(c)) as {
      pixel_group_id?: unknown;
      event_name?: unknown;
    };
    if (
      typeof body.pixel_group_id !== "string" ||
      body.pixel_group_id.trim() === "" ||
      typeof body.event_name !== "string" ||
      body.event_name.trim() === ""
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "pixel_group_id and event_name are required.",
        422
      );
    }
    const result = await sendTrackingTestEvent(store, principal, body, requestId);
    return ok(c, result, 202);
  });

  // Dashboard & Analytics Overview (PRD §18: Pending payments are NEVER counted as revenue!)
  // PLAN §23 — date filter: `?from=YYYY-MM-DD&to=YYYY-MM-DD` scopes
  // the FLOW metrics to the inclusive range (Dhaka day boundaries).
  // verified_revenue_minor = paid orders completed in the range (the
  // existing paid-only definition, unchanged for all time);
  // total_orders = created in the range; paid_orders = created in the
  // range AND paid (cohort, so "paid / total" stays a coherent ratio).
  // Everything else is a current-state snapshot — history cannot be
  // reconstructed from current state, so products / subscriptions /
  // licenses / queues / all-time customer total are NOT range-scoped.

}
