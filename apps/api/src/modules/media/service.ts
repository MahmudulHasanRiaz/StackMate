/**
 * Media library service (PLAN §31 / ADR-0011).
 *
 * Library files are private objects in the SELECTED storage driver
 * (R2 by default, Local on Docker/VPS). Each row stores its OWN
 * driver, so reads always use the row's driver and a driver switch
 * never orphans library files. The API never returns raw storage
 * keys or public URLs — downloads go through the authenticated
 * content endpoint (`GET /api/v1/admin/media/:id/content`).
 *
 * Uploads are multipart FormData on the route (not base64 JSON —
 * files can be 100 MB). Validation is `verifyMediaBytes`
 * (allowlist + magic bytes + SVG sanitize); the STORED bytes are the
 * verified bytes (sanitized for SVG).
 *
 * Delete order: row first, then the object (best-effort). A failed
 * object delete after the row is gone leaves an orphaned invisible
 * object; a failed row delete after the object is gone would leave a
 * user-visible row pointing at nothing. The audit log records the
 * delete either way.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { mediaAssets } from "../../../../../db/schema/media.ts";
import * as schema from "../../../../../db/schema/index.ts";
import { AppError } from "../../shared/errors.ts";
import { sha256Hex } from "../../platform/crypto/index.ts";
import {
  resolveStorageDriver,
  type DriverDeps,
  type StorageDriverName,
} from "../../platform/storage/driver.ts";
import {
  MAX_MEDIA_BYTES,
  MEDIA_ALLOWED_MIME,
  mediaKindOfMime,
  mediaObjectKey,
  normalizeFilename,
  normalizeFolder,
  normalizeTags,
  verifyMediaBytes,
  type MediaKind,
} from "../../platform/storage/media-validation.ts";
import type {
  MediaAssetView,
  MediaListResponse,
} from "../../../../../packages/contracts/src/index.ts";

export type MediaDb = NodePgDatabase<typeof schema>;

export const MEDIA_LIST_DEFAULT_LIMIT = 50;
export const MEDIA_LIST_MAX_LIMIT = 100;

const KIND_MIMES: Record<MediaKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"],
  video: ["video/mp4", "video/webm"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg"],
  document: ["application/pdf"],
  archive: ["application/zip", "application/x-zip-compressed"],
  other: ["text/plain", "text/csv"],
};

export function mediaViewOf(row: typeof mediaAssets.$inferSelect): MediaAssetView {
  return {
    id: row.id,
    original_filename: row.originalFilename,
    mime_type: row.mimeType,
    kind: mediaKindOfMime(row.mimeType) ?? "other",
    byte_size: Number(row.byteSize),
    checksum_sha256: row.checksumSha256,
    width: row.width,
    height: row.height,
    folder: row.folder,
    tags: [...row.tags],
    driver: row.driver === "local" ? "local" : "r2",
    uploaded_by_user_id: row.uploadedByUserId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    content_url: `/api/v1/admin/media/${row.id}/content`,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface MediaListParams {
  // `| undefined`: exactOptionalPropertyTypes — app.ts passes
  // `parsed.q` etc. through, which are `T | undefined`.
  q?: string | undefined;
  kind?: MediaKind | undefined;
  folder?: string | undefined;
  /** Exact MIME types to include (allowlisted only — anything else is a 422). */
  mimes?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function clampMediaListParams(params: MediaListParams): {
  q: string;
  kind: MediaKind | undefined;
  folder: string | undefined;
  mimes: string[] | undefined;
  limit: number;
  offset: number;
} {
  const q = (params.q ?? "").trim();
  let kind: MediaKind | undefined;
  if (params.kind !== undefined) {
    if (!(params.kind in KIND_MIMES)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `kind must be one of: ${Object.keys(KIND_MIMES).join(", ")}.`,
        422,
      );
    }
    kind = params.kind;
  }
  let mimes: string[] | undefined;
  if (params.mimes !== undefined) {
    mimes = params.mimes.map((m) => m.trim().toLowerCase()).filter(Boolean);
    const bad = mimes.find((m) => !(m in MEDIA_ALLOWED_MIME));
    if (bad !== undefined) {
      throw new AppError("VALIDATION_ERROR", `mime '${bad}' is not a supported media type.`, 422);
    }
    if (mimes.length === 0) mimes = undefined;
  }
  const folder =
    params.folder === undefined ? undefined : normalizeFolder(params.folder);
  const limit = Math.min(
    MEDIA_LIST_MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? MEDIA_LIST_DEFAULT_LIMIT) || MEDIA_LIST_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Math.floor(params.offset ?? 0) || 0);
  return { q, kind, folder, mimes, limit, offset };
}

/**
 * Server-side list over the FULL media_assets dataset (owner hard
 * rule, PLAN §29): `q` matches filename (substring, case-insensitive)
 * OR any tag; `kind` and `folder` filter server-side too. `limit`
 * caps AFTER filtering — a match at row 500 is found.
 */
export async function listMediaAssets(
  db: MediaDb,
  params: MediaListParams,
): Promise<MediaListResponse> {
  const { q, kind, folder, mimes, limit, offset } = clampMediaListParams(params);
  const conditions: SQL[] = [];
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(mediaAssets.originalFilename, like),
      sql`EXISTS (SELECT 1 FROM unnest(${mediaAssets.tags}) AS t WHERE t ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  if (kind !== undefined) {
    conditions.push(inArray(mediaAssets.mimeType, [...KIND_MIMES[kind]]));
  }
  if (mimes !== undefined) {
    conditions.push(inArray(mediaAssets.mimeType, mimes));
  }
  if (folder !== undefined) {
    conditions.push(eq(mediaAssets.folder, folder));
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(mediaAssets)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(where)
    .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
    .limit(limit)
    .offset(offset);
  return { items: rows.map(mediaViewOf), total, limit, offset };
}

export async function getMediaAsset(
  db: MediaDb,
  id: string,
): Promise<typeof mediaAssets.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireMediaAsset(
  db: MediaDb,
  id: string,
): Promise<typeof mediaAssets.$inferSelect> {
  const row = await getMediaAsset(db, id);
  if (!row) throw new AppError("NOT_FOUND", "Media asset not found.", 404);
  return row;
}

export interface MediaUploadInput {
  bytes: Uint8Array;
  declaredMimeType: string;
  filename: string;
  folder?: string | undefined;
  tags?: string[] | undefined;
}

export async function uploadMediaAsset(
  db: MediaDb,
  driverDeps: DriverDeps,
  input: MediaUploadInput,
  uploadedByUserId: string | null,
): Promise<MediaAssetView> {
  const verified = verifyMediaBytes(input.bytes, input.declaredMimeType);
  const filename = normalizeFilename(input.filename);
  const folder = normalizeFolder(input.folder);
  const tags = normalizeTags(input.tags);
  const mime = input.declaredMimeType.trim().toLowerCase();
  const driver = await resolveStorageDriver(driverDeps);
  const key = mediaObjectKey(filename);
  const checksum = sha256Hex(verified.bytes);
  await driver.put(key, verified.bytes, mime);
  const now = new Date();
  let rows: (typeof mediaAssets.$inferSelect)[];
  try {
    rows = await db
      .insert(mediaAssets)
      .values({
        objectKey: key,
        driver: driver.name,
        originalFilename: filename,
        mimeType: mime,
        byteSize: verified.bytes.byteLength,
        checksumSha256: checksum,
        width: verified.width,
        height: verified.height,
        folder,
        tags,
        uploadedByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (err) {
    // The object is stored but the row is not — remove the orphan rather than leak it.
    await driver.delete(key).catch(() => undefined);
    throw err;
  }
  const row = rows[0];
  if (!row) {
    await driver.delete(key).catch(() => undefined);
    throw new AppError("INTERNAL_ERROR", "Media upload failed to persist.", 500);
  }
  return mediaViewOf(row);
}

export async function renameMediaAsset(
  db: MediaDb,
  id: string,
  filename: string,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeFilename(filename);
  const updated = await db
    .update(mediaAssets)
    .set({ originalFilename: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media rename failed to persist.", 500);
  return mediaViewOf(saved);
}

export async function moveMediaAsset(
  db: MediaDb,
  id: string,
  folder: string,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeFolder(folder);
  const updated = await db
    .update(mediaAssets)
    .set({ folder: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media move failed to persist.", 500);
  return mediaViewOf(saved);
}

export async function setMediaAssetTags(
  db: MediaDb,
  id: string,
  tags: unknown,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeTags(tags);
  const updated = await db
    .update(mediaAssets)
    .set({ tags: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media tag update failed to persist.", 500);
  return mediaViewOf(saved);
}

/** Row first, then the object (best-effort — see module header). */
/** The `driver` column is plain text in Drizzle's row type — narrow it
 * to the driver-name union before resolving (reads always use the row's
 * own driver, so an unexpected value falls back to R2, never crashes). */
function driverNameOf(row: { driver: string }): StorageDriverName {
  return row.driver === "local" ? "local" : "r2";
}

export async function deleteMediaAsset(
  db: MediaDb,
  driverDeps: DriverDeps,
  id: string,
): Promise<void> {
  const row = await requireMediaAsset(db, id);
  await db.delete(mediaAssets).where(eq(mediaAssets.id, row.id));
  const driver = await resolveStorageDriver(driverDeps, driverNameOf(row));
  await driver.delete(row.objectKey).catch(() => undefined);
}

export interface MediaContent {
  row: typeof mediaAssets.$inferSelect;
  bytes: Uint8Array;
  mimeType: string;
}

export async function getMediaAssetContent(
  db: MediaDb,
  driverDeps: DriverDeps,
  id: string,
): Promise<MediaContent> {
  const row = await requireMediaAsset(db, id);
  const driver = await resolveStorageDriver(driverDeps, driverNameOf(row));
  const obj = await driver.get(row.objectKey);
  if (!obj) {
    throw new AppError("NOT_FOUND", "Media file not found in storage.", 404);
  }
  return { row, bytes: obj.bytes, mimeType: row.mimeType };
}

/** Distinct folders present in the library, sorted ("" = root is listed first when present). */
export async function listMediaFolders(db: MediaDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ folder: mediaAssets.folder })
    .from(mediaAssets)
    .orderBy(asc(mediaAssets.folder));
  return rows.map((r) => r.folder);
}
