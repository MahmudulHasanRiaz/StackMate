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

import { createHash, randomUUID } from "node:crypto";
import { verifyMediaBytes } from "../../platform/storage/media-validation.ts";
import { and } from "drizzle-orm";
import { resolveStorageDriver } from "../../platform/storage/driver.ts";
import { AppError } from "../../shared/errors.ts";
import { type StaffPrincipal, updateOwnProfile } from "../../modules/identity/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody, readCappedMultipartFormData, driverDepsForRequest } from "../../shared/http.ts";
export function registerAdminCoreRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/me", async (c) => {
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
    return jsonResponse(c, principal);
  });
  app.patch("/api/v1/admin/me", async (c) => {
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
    // Self-service profile: name ONLY. Email is the login identity
    // (administrator change only) and roles are never self-editable
    // — extra fields in the body are ignored, never applied.
    const body = (await readJsonBody(c)) as {
      name?: unknown;
      avatar_url?: unknown;
    };
    // updateOwnProfile requires a valid name (1–120 chars), so it
    // runs only when a name is actually being changed — an
    // avatar-only PATCH must not 422 on the missing name.
    let updated: StaffPrincipal = principal;
    if (body.name !== undefined) {
      updated = await updateOwnProfile(store, principal, {
        name: body.name,
        requestId,
      });
    }
    // M-23: avatar_url is set at the route (updateOwnProfile owns
    // name only); null clears the avatar. Two forms are accepted
    // and both are stored as the object KEY (never a URL):
    //  - an `avatars/` key returned by POST /me/avatar;
    //  - a media-library content URL
    //    (/api/v1/admin/media/<id>/content), resolved here to
    //    the asset's object key — the asset must exist and be an
    //    image. Anything else (external URLs included) is 422.
    // The UI renders the stored key through GET /me/avatar.
    let avatarUrl: string | null | undefined = (
      updated.user as { avatar_url?: string | null }
    ).avatar_url;
    if (body.avatar_url !== undefined) {
      let key: string | null = null;
      if (body.avatar_url !== null) {
        if (typeof body.avatar_url !== "string") {
          throw new AppError(
            "VALIDATION_ERROR",
            "avatar_url must be a string or null.",
            422,
          );
        }
        if (body.avatar_url.startsWith("avatars/")) {
          key = body.avatar_url;
        } else {
          const mediaMatch = body.avatar_url.match(
            /^\/api\/v1\/admin\/media\/([^/?#]+)\/content(?:\?.*)?$/,
          );
          if (!mediaMatch) {
            throw new AppError(
              "VALIDATION_ERROR",
              "avatar_url must be an avatar object key returned by POST /api/v1/admin/me/avatar, a media-library content URL, or null to clear.",
              422,
            );
          }
          const asset = store.state.media_assets.find((a) => a.id === mediaMatch[1]);
          if (!asset) {
            throw new AppError("NOT_FOUND", "Media asset not found.", 404);
          }
          if (!asset.mime_type.startsWith("image/")) {
            throw new AppError("VALIDATION_ERROR", "Avatar must be an image.", 422);
          }
          key = asset.object_key;
        }
      }
      const saved = await store.setStaffAvatarUrl(principal.user.id, key);
      avatarUrl = saved.avatar_url;
    }
    return jsonResponse(c, { ...updated, avatar_url: avatarUrl ?? null }, 200);
  });
  app.post("/api/v1/admin/me/avatar", async (c) => {
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
    // A-08: streaming 2 MB multipart cap (never buffer-then-validate).
    const form = await readCappedMultipartFormData(c, 2 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "A file upload is required (multipart field 'file').",
        422
      );
    }
    const allowedTypes: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const ext = allowedTypes[file.type];
    if (!ext) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Avatar must be a PNG, JPEG, WebP, or GIF image.",
        422
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) {
      throw new AppError("VALIDATION_ERROR", "Avatar must be 2 MB or smaller.", 413);
    }
    // A-17: verify magic bytes (same check as media/evidence
    // uploads) — the client-claimed MIME alone is not trusted.
    // verifyMediaBytes also returns the bytes to store; avatars
    // are never SVG, so the bytes pass through unchanged.
    verifyMediaBytes(bytes, file.type);
    const driver = await resolveStorageDriver(driverDepsForRequest(store, env));
    const key = `avatars/${principal.user.id}/${randomUUID()}.${ext}`;
    await driver.put(key, bytes, file.type);
    const previous = store.state.users.find((u) => u.id === principal.user.id)?.avatar_url;
    const saved = await store.setStaffAvatarUrl(principal.user.id, key);
    if (previous && previous.startsWith("avatars/") && previous !== key) {
      await driver.delete(previous).catch(() => {});
    }
    return jsonResponse(c, { avatar_url: saved.avatar_url }, 201);
  });
  app.get("/api/v1/admin/me/avatar", async (c) => {
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
    const key = store.state.users.find((u) => u.id === principal.user.id)?.avatar_url;
    if (!key) throw new AppError("NOT_FOUND", "No avatar is set.", 404);
    // B-07: avatar gets the media treatment — the key is
    // content-addressed (a fresh uuid on every upload, so the
    // key changes exactly when the bytes do), so an ETag derived
    // from the key is stable per version and `immutable` is safe
    // (the SPA already cache-busts with ?k=). nosniff included.
    // (Serving from a lightweight single-row lookup instead of
    // the full store load still waits on B-01/A-10: the store
    // is resolved in fetchHandler before routing; this handler
    // itself only reads one user row + one object.)
    const etag = `"${createHash("sha256").update(key, "utf8").digest("hex")}"`;
    const avatarHeaders: Record<string, string> = {
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    const ifNoneMatch = request.headers.get("if-none-match");
    if (
      ifNoneMatch !== null &&
      (ifNoneMatch.trim() === "*" ||
        ifNoneMatch.split(",").some((tag) => tag.trim() === etag))
    ) {
      return new Response(null, { status: 304, headers: avatarHeaders });
    }
    const driver = await resolveStorageDriver(driverDepsForRequest(store, env));
    const obj = await driver.get(key);
    if (!obj) throw new AppError("NOT_FOUND", "Avatar not found.", 404);
    return new Response(obj.bytes, {
      status: 200,
      headers: { ...avatarHeaders, "Content-Type": obj.contentType },
    });
  });
}
