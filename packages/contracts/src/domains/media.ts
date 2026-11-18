/**
 * Media library (PLAN §31 / ADR-0011).
 *
 * Library files are private objects in the selected storage driver
 * (R2 or Local); the API never returns raw storage keys or public
 * URLs — downloads go through the authenticated content endpoint.
 *
 * Search rule (owner hard rule, PLAN §29): list `q` filters
 * server-side over the FULL media_assets dataset (filename + tags);
 * `limit` caps AFTER filtering. Type + folder filters are server
 * params too.
 *
 * Type groups for the UI filter: images / video / audio / documents /
 * archives / other. `kind` on the item is the group the file belongs
 * to; `mime_type` is the exact type.
 */

/** Same union as MediaKind in apps/api media-validation.ts (kept in sync by the media-library tests). */
export type MediaLibraryKind = "image" | "video" | "audio" | "document" | "archive" | "other";

export const MEDIA_LIBRARY_KINDS: readonly MediaLibraryKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
];

export interface MediaAssetView {
  id: string;
  original_filename: string;
  mime_type: string;
  kind: MediaLibraryKind;
  byte_size: number;
  checksum_sha256: string;
  width: number | null;
  height: number | null;
  folder: string;
  tags: string[];
  driver: "r2" | "local";
  uploaded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  /** Authenticated content URL (same origin, session cookie) for preview/download. */
  content_url: string;
}

export interface MediaListQuery {
  q?: string;
  kind?: MediaLibraryKind;
  folder?: string;
  /** Comma-separated exact MIME types (server-side filter — used by the MediaPicker to respect each upload spot's accepted types). */
  mime?: string;
  limit?: number;
  offset?: number;
}

export interface MediaListResponse {
  items: MediaAssetView[];
  total: number;
  limit: number;
  offset: number;
}

export interface MediaRenameBody {
  original_filename: string;
}

export interface MediaMoveBody {
  folder: string;
}

export interface MediaTagsBody {
  tags: string[];
}

export interface MediaUploadResponse {
  asset: MediaAssetView;
}

export interface StorageSettingsView {
  driver: "r2" | "local";
  local_path: string | null;
  /** Name of the bound R2 bucket (mirrors wrangler.jsonc) — shown read-only on Settings → Storage. */
  r2_bucket: string;
  updated_at: string;
}

export interface StorageSettingsUpdateBody {
  driver?: "r2" | "local";
  /** Null clears the stored path (falls back to env/default). */
  local_path?: string | null;
}
