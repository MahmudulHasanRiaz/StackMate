/**
 * Media library — shared admin helpers (PLAN §31 / ADR-0011).
 *
 * Types come from @stackmate/contracts (domains/media.ts). The API
 * helpers here are the single place the SPA talks to the media
 * endpoints, so the library section, the picker, and the two upload
 * spots (favicon, payment evidence) all share the same calls.
 *
 * Uploads are multipart FormData with a 5-minute client bound (a
 * 100 MB file needs longer than the 30s default). Picking a file for
 * the favicon / evidence spots does NOT copy it into the library —
 * it fetches the library bytes back through the authenticated
 * content URL and hands the caller a File, which the caller's own
 * (unchanged) base64 endpoint then stores under its own key.
 */
import { apiRequest } from "./api-client";
import type {
  MediaAssetView,
  MediaLibraryKind,
  MediaListResponse,
  StorageSettingsView,
} from "../../../../packages/contracts/src/index.ts";

export type { MediaAssetView, MediaLibraryKind, MediaListResponse, StorageSettingsView };

export const MEDIA_KINDS: readonly MediaLibraryKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
];

export const MEDIA_KIND_LABELS: Record<MediaLibraryKind, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
  archive: "Archives",
  other: "Other",
};

/** <input type="file" accept="…"> values per kind. */
export const MEDIA_ACCEPT_BY_KIND: Record<MediaLibraryKind, string> = {
  image: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg",
  video: "video/mp4,video/webm,.mp4,.webm",
  audio: "audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg",
  document: "application/pdf,.pdf",
  archive: "application/zip,.zip",
  other: "text/plain,text/csv,.txt,.csv",
};

/** Accept string for the library upload (all allowlisted types). */
export const MEDIA_UPLOAD_ACCEPT = MEDIA_KINDS.map((k) => MEDIA_ACCEPT_BY_KIND[k]).join(",");

/** Accept string for a kind restriction, or undefined (all types) when unrestricted. */
export function mediaAcceptForKinds(kinds?: MediaLibraryKind[]): string | undefined {
  if (!kinds || kinds.length === 0) return undefined;
  return kinds.map((k) => MEDIA_ACCEPT_BY_KIND[k]).join(",");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export interface MediaListParams {
  // `| undefined` is deliberate: the project uses
  // `exactOptionalPropertyTypes`, and callers pass `x || undefined`.
  q?: string | undefined;
  kind?: MediaLibraryKind | undefined;
  folder?: string | undefined;
  /** Exact MIME types to include (server-side filter). */
  mimes?: string[] | undefined;
  limit?: number;
  offset?: number;
}

export async function fetchMediaList(params: MediaListParams): Promise<MediaListResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.kind) search.set("kind", params.kind);
  if (params.folder !== undefined) search.set("folder", params.folder);
  if (params.mimes && params.mimes.length > 0) search.set("mime", params.mimes.join(","));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const query = search.toString();
  return apiRequest<MediaListResponse>(`/api/v1/admin/media${query ? `?${query}` : ""}`);
}

export async function fetchMediaFolders(): Promise<string[]> {
  const res = await apiRequest<{ folders: string[] }>("/api/v1/admin/media/folders");
  return res.folders;
}

/** Large files need longer than the 30s default client bound. */
const MEDIA_UPLOAD_TIMEOUT_MS = 300_000;

export async function uploadMediaFile(
  file: File,
  opts?: { folder?: string | undefined; tags?: string[] | undefined },
): Promise<MediaAssetView> {
  const form = new FormData();
  form.append("file", file);
  if (opts?.folder) form.append("folder", opts.folder);
  for (const tag of opts?.tags ?? []) form.append("tags", tag);
  return apiRequest<MediaAssetView>("/api/v1/admin/media", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
  });
}

export async function patchMediaAsset(
  id: string,
  body: {
    original_filename?: string | undefined;
    folder?: string | undefined;
    tags?: string[] | undefined;
  },
): Promise<MediaAssetView> {
  return apiRequest<MediaAssetView>(`/api/v1/admin/media/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteMediaAsset(id: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(`/api/v1/admin/media/${id}`, {
    method: "DELETE",
  });
}

/**
 * Fetch an asset's bytes through its authenticated content URL and
 * hand back a File (same filename + MIME). Used by the favicon and
 * payment-evidence spots, which keep their own upload endpoints.
 */
export async function fetchMediaFile(asset: MediaAssetView): Promise<File> {
  const res = await fetch(asset.content_url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Could not download ${asset.original_filename} from the media library.`);
  }
  const blob = await res.blob();
  return new File([blob], asset.original_filename, { type: asset.mime_type });
}

export async function fetchStorageSettings(): Promise<StorageSettingsView> {
  return apiRequest<StorageSettingsView>("/api/v1/admin/storage-settings");
}

export async function saveStorageSettings(body: {
  driver?: "r2" | "local";
  local_path?: string | null;
}): Promise<StorageSettingsView> {
  return apiRequest<StorageSettingsView>("/api/v1/admin/storage-settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
