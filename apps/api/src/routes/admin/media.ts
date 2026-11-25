/**
 * StackMate API — Hono route module (Hono migration, Phase 1).
 *
 * Converted mechanically from apps/api/src/app.ts (baseline feat e382d65):
 * same paths, methods, service calls, validation, RBAC and JSON shapes.
 * Only the HTTP plumbing changed: handlers read store/env/principal/
 * requestId from c.var (set by the Hono app middleware) and answer with
 * the same success/error envelopes. Shared HTTP plumbing lives in
 * apps/api/src/shared/http.ts.
 *
 * Middleware the Hono app MUST provide (was app.ts handleRequest/admin
 * preamble, not per-route code): request-id + standard/security headers,
 * CORS, CSRF gate, admin principal resolution, the 2FA-setup gate, the
 * admin 600/min bucket, and the AppError/SchemaValidationError ->
 * envelope mapping.
 */

import { and } from "drizzle-orm";
import { StackMateDataStore } from "../../platform/db/store.ts";
import { deleteMediaAsset, getMediaAssetContent, listMediaAssets, listMediaFolders, mediaViewOf, moveMediaAsset, regenerateMediaThumbnail, renameMediaAsset, requireMediaAsset, setMediaAssetTags, uploadMediaAsset } from "../../modules/media/service.ts";
import { AppError } from "../../shared/errors.ts";
import { MAX_MEDIA_BYTES } from "../../platform/storage/media-validation.ts";
import { assertStaffPermissionAudited, type StaffPrincipal } from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBodyLenient, readCappedMultipartFormData, driverDepsForRequest } from "../../shared/http.ts";

function requireMediaDb(store: StackMateDataStore) {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  if (!maybeDrizzle.drizzleDb) {
    throw new AppError("STORE_UNAVAILABLE", "Media library requires a database.", 503);
  }
  return maybeDrizzle.drizzleDb as Parameters<typeof listMediaAssets>[0];
}

function auditMediaChange(
  store: StackMateDataStore,
  principal: StaffPrincipal,
  requestId: string,
  action: string,
  resourceId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  return store
    .withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action,
        resource_type: "media_asset",
        resource_id: resourceId,
        outcome: "success",
        request_id: requestId,
        changes,
      });
    })
    .catch(() => {});
}

export function registerAdminMediaRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/media", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "media.view", requestId);
    const result = await listMediaAssets(requireMediaDb(store), {
      q: url.searchParams.get("q") ?? undefined,
      kind: (url.searchParams.get("kind") ?? undefined) as
        | "image"
        | "video"
        | "audio"
        | "document"
        | "archive"
        | "other"
        | undefined,
      folder: url.searchParams.get("folder") ?? undefined,
      mimes: url.searchParams.get("mime")
        ? url.searchParams.get("mime")!.split(",")
        : undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      offset: url.searchParams.get("offset")
        ? Number(url.searchParams.get("offset"))
        : undefined,
    });
    return jsonResponse(c, result);
  });
  app.get("/api/v1/admin/media/folders", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "media.view", requestId);
    const folders = await listMediaFolders(requireMediaDb(store));
    return jsonResponse(c, { folders });
  });
  app.post("/api/v1/admin/media", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
    // A-08: streaming 100 MB multipart cap (MAX_MEDIA_BYTES).
    const form = await readCappedMultipartFormData(c, MAX_MEDIA_BYTES);
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "A file upload is required (multipart field 'file').",
        422
      );
    }
    const tags = form.getAll("tags").map((t) => String(t));
    // Browser-generated thumbnails (PLAN §34): 320px + 64px WebP
    // variants, uploaded together with the original. Absent when
    // the browser could not generate them — the upload proceeds
    // without thumbnails and the UI falls back to the original.
    const thumbFile = form.get("thumbnail");
    const thumbSmallFile = form.get("thumbnail_small");
    const asset = await uploadMediaAsset(
      requireMediaDb(store),
      driverDepsForRequest(store, env),
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredMimeType: file.type || "application/octet-stream",
        filename: file.name,
        folder:
          typeof form.get("folder") === "string"
            ? (form.get("folder") as string)
            : undefined,
        tags: tags.length > 0 ? tags : undefined,
        thumbnails: {
          thumb:
            thumbFile instanceof File
              ? {
                  bytes: new Uint8Array(await thumbFile.arrayBuffer()),
                  declaredMimeType: thumbFile.type || "image/webp",
                }
              : undefined,
          small:
            thumbSmallFile instanceof File
              ? {
                  bytes: new Uint8Array(await thumbSmallFile.arrayBuffer()),
                  declaredMimeType: thumbSmallFile.type || "image/webp",
                }
              : undefined,
        },
      },
      principal.user.id
    );
    await auditMediaChange(store, principal, requestId, "media.uploaded", asset.id, {
      filename: asset.original_filename,
      mime_type: asset.mime_type,
      byte_size: asset.byte_size,
      folder: asset.folder,
      driver: asset.driver,
    });
    return jsonResponse(c, asset, 201);
  });
  app.post("/api/v1/admin/media/:id/thumbnail", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // PLAN §34: regenerate thumbnails for an existing image —
    // the backfill path for pre-0013 files (the browser
    // generates the variants from the loaded original).
    await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
    // A-08: streaming multipart cap (thumbnails are small WebP variants; the media cap is the ceiling).
    const form = await readCappedMultipartFormData(c, MAX_MEDIA_BYTES);
    const thumbFile = form.get("thumbnail");
    const thumbSmallFile = form.get("thumbnail_small");
    const asset = await regenerateMediaThumbnail(
      requireMediaDb(store),
      driverDepsForRequest(store, env),
      c.req.param("id")!,
      {
        thumb:
          thumbFile instanceof File
            ? {
                bytes: new Uint8Array(await thumbFile.arrayBuffer()),
                declaredMimeType: thumbFile.type || "image/webp",
              }
            : undefined,
        small:
          thumbSmallFile instanceof File
            ? {
                bytes: new Uint8Array(await thumbSmallFile.arrayBuffer()),
                declaredMimeType: thumbSmallFile.type || "image/webp",
              }
            : undefined,
      },
    );
    await auditMediaChange(store, principal, requestId, "media.thumbnail_regenerated", asset.id, {
      original_filename: asset.original_filename,
      thumb_url: asset.thumb_url,
      thumb_small_url: asset.thumb_small_url,
    });
    return jsonResponse(c, asset);
  });
  app.get("/api/v1/admin/media/:id/content", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "media.view", requestId);
    const variantRaw = url.searchParams.get("variant");
    const variant =
      variantRaw === null
        ? "original"
        : variantRaw === "thumb"
          ? "thumb"
          : variantRaw === "small"
            ? "small"
            : null;
    if (variant === null) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Unknown variant. Use variant=thumb or variant=small.",
        422,
      );
    }
    let content;
    try {
      content = await getMediaAssetContent(
        requireMediaDb(store),
        driverDepsForRequest(store, env),
        c.req.param("id")!,
        { variant, rangeHeader: request.headers.get("range") },
      );
    } catch (err) {
      if (err instanceof AppError && err.code === "RANGE_NOT_SATISFIABLE") {
        // 416 needs Content-Range: bytes */<size> — build it here
        // rather than letting the generic envelope swallow it.
        const size = (err.details as { size?: unknown } | null)?.size;
        return new Response("Requested range not satisfiable.", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${typeof size === "number" ? size : "*"}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          },
        });
      }
      throw err;
    }
    const safeFilename = content.row.originalFilename.replace(/["\\\r\n]/g, "");
    // M-19: ?download=1 forces a save-as download instead of the
    // default inline preview (ADR-0011 open item).
    const download = url.searchParams.get("download") === "1";
    const headers: Record<string, string> = {
      "Content-Type": content.mimeType,
      "Content-Disposition": download
        ? `attachment; filename="${safeFilename}"`
        : `inline; filename="${safeFilename}"`,
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      ETag: content.etag,
      "Content-Length": String(
        content.range !== null
          ? content.range.end - content.range.start + 1
          : content.size,
      ),
    };
    if (content.mimeType === "image/svg+xml") {
      // Stored SVGs are sanitized on upload, but never let one
      // execute even if opened top-level directly.
      headers["Content-Security-Policy"] = "sandbox";
    }
    // Conditional request: the ETag is derived from the stored
    // checksum, so a client that already has the bytes gets a
    // 304 without the Worker streaming anything.
    const ifNoneMatch = request.headers.get("if-none-match");
    if (
      ifNoneMatch !== null &&
      (ifNoneMatch.trim() === "*" ||
        ifNoneMatch.split(",").some((tag) => tag.trim() === content.etag))
    ) {
      return new Response(null, { status: 304, headers });
    }
    if (content.range !== null) {
      headers["Content-Range"] =
        `bytes ${content.range.start}-${content.range.end}/${content.size}`;
      return new Response(content.body, { status: 206, headers });
    }
    return new Response(content.body, { status: 200, headers });
  });
  app.get("/api/v1/admin/media/:id", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    const mediaId = c.req.param("id");
    await assertStaffPermissionAudited(store, principal, "media.view", requestId);
    const row = await requireMediaAsset(requireMediaDb(store), mediaId);
    return jsonResponse(c, mediaViewOf(row));
  });
  app.patch("/api/v1/admin/media/:id", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    const mediaId = c.req.param("id");
    await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as {
      original_filename?: string;
      folder?: string;
      tags?: string[];
    };
    const db = requireMediaDb(store);
    let view = mediaViewOf(await requireMediaAsset(db, mediaId));
    const changes: Record<string, unknown> = {};
    if (body.original_filename !== undefined) {
      view = await renameMediaAsset(db, mediaId, body.original_filename);
      changes.original_filename = view.original_filename;
    }
    if (body.folder !== undefined) {
      view = await moveMediaAsset(db, mediaId, body.folder);
      changes.folder = view.folder;
    }
    if (body.tags !== undefined) {
      view = await setMediaAssetTags(db, mediaId, body.tags);
      changes.tags = view.tags;
    }
    if (Object.keys(changes).length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Nothing to update — pass original_filename, folder, or tags.",
        422
      );
    }
    await auditMediaChange(store, principal, requestId, "media.updated", mediaId, changes);
    return jsonResponse(c, view);
  });
  app.delete("/api/v1/admin/media/:id", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    const mediaId = c.req.param("id");
    await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
    const db = requireMediaDb(store);
    const row = await requireMediaAsset(db, mediaId);
    await deleteMediaAsset(db, driverDepsForRequest(store, env), mediaId);
    await auditMediaChange(store, principal, requestId, "media.deleted", mediaId, {
      filename: row.originalFilename,
      mime_type: row.mimeType,
      byte_size: Number(row.byteSize),
    });
    return jsonResponse(c, { deleted: true, id: mediaId });
  });
}
