/**
 * MediaPicker (PLAN §31 / ADR-0011) — the shared "pick from the
 * library AND upload new" dialog used by EVERY upload spot in the
 * app (favicon, payment evidence, and any future spot).
 *
 * Browse/search the library with the same server-side search as the
 * Media Library page (`?q=` over the full dataset — never a filter
 * over a loaded page), or upload a new file from the same dialog; the
 * new file lands at the top of the grid and can be picked at once.
 * Clicking a file picks it (single-pick chooser) and closes.
 *
 * The picker returns the picked ASSET — it does not upload anything
 * to the caller's endpoint. Callers that keep their own upload
 * endpoint (favicon, payment evidence) fetch the bytes back with
 * `fetchMediaFile` and send them through their unchanged flow.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  File as FileIcon,
  FileArchive,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Upload,
} from "lucide-react";
import { ApiClientError } from "../lib/api-client";
import { Button, Dialog, Input, Select, useToast } from "./primitives";
import {
  fetchMediaFolders,
  fetchMediaList,
  formatBytes,
  mediaAcceptForKinds,
  MEDIA_KIND_LABELS,
  MEDIA_KINDS,
  uploadMediaFile,
  type MediaAssetView,
  type MediaLibraryKind,
} from "../lib/media";

export interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (asset: MediaAssetView) => void;
  /** Restrict the library to these kinds (e.g. ["image"] for the favicon). Empty = all kinds. */
  kinds?: MediaLibraryKind[];
  /**
   * Restrict the library to these exact MIME types (server-side).
   * Use this when the caller's endpoint accepts fewer types than the
   * whole kind (favicon: PNG/SVG only — ICO is not a library type;
   * evidence: PNG/JPEG/WEBP/PDF). When set, the kind filter is hidden
   * and uploads from the picker accept only these types too.
   */
  mimes?: string[];
  title?: string;
  /** Uploads from the picker go into this folder (default: root). */
  folder?: string;
}

const PICKER_PAGE_SIZE = 24;

/** Kind → lucide icon, shared with the Media Library section. */
export function mediaKindIcon(kind: MediaLibraryKind) {
  switch (kind) {
    case "image":
      return ImageIcon;
    case "video":
      return Film;
    case "audio":
      return Music;
    case "document":
      return FileText;
    case "archive":
      return FileArchive;
    default:
      return FileIcon;
  }
}

function kindIcon(kind: MediaLibraryKind) {
  return mediaKindIcon(kind);
}

export function MediaPicker({ open, onClose, onSelect, kinds, mimes, title, folder }: MediaPickerProps) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const allowedKinds = kinds && kinds.length > 0 ? kinds : [...MEDIA_KINDS];
  const [kind, setKind] = useState<MediaLibraryKind | "">(
    allowedKinds.length === 1 ? allowedKinds[0]! : "",
  );
  const [currentFolder, setCurrentFolder] = useState(folder ?? "");
  const [visible, setVisible] = useState(PICKER_PAGE_SIZE);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  // Reset the browser state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setQ("");
      setDebouncedQ("");
      setKind(allowedKinds.length === 1 ? allowedKinds[0]! : "");
      setCurrentFolder(folder ?? "");
      setVisible(PICKER_PAGE_SIZE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const listQuery = useQuery({
    queryKey: [
      "admin",
      "media-picker",
      { q: debouncedQ, kind: kind || undefined, mimes, folder: currentFolder, limit: visible },
    ],
    queryFn: () =>
      fetchMediaList({
        q: debouncedQ || undefined,
        // A mime restriction replaces the kind filter (the two would
        // fight: a mime outside the chosen kind yields an empty list).
        kind: mimes ? undefined : kind || undefined,
        mimes,
        folder: currentFolder,
        limit: visible,
        offset: 0,
      }),
    enabled: open,
  });

  const foldersQuery = useQuery({
    queryKey: ["admin", "media-folders"],
    queryFn: fetchMediaFolders,
    enabled: open,
  });

  async function handleFiles(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setUploading(true);
    let done = 0;
    let failed = 0;
    for (const file of list) {
      // A mime restriction (favicon / evidence) applies to uploads from
      // the picker too — drag-and-drop bypasses the file input's accept
      // attribute, so enforce it here before the upload starts.
      if (mimes && mimes.length > 0 && !mimes.includes(file.type.toLowerCase())) {
        failed += 1;
        toast({
          title: "Wrong file type",
          message: `${file.name} is ${file.type || "an unknown type"} — this spot accepts ${mimes.join(", ")} only.`,
          variant: "danger",
        });
        continue;
      }
      try {
        await uploadMediaFile(file, { folder: currentFolder || undefined });
        done += 1;
      } catch (err) {
        failed += 1;
        toast({
          title: "Upload failed",
          message:
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : `Could not upload ${file.name}.`,
          variant: "danger",
        });
      }
    }
    setUploading(false);
    if (done > 0) {
      await queryClient.invalidateQueries({ queryKey: ["admin", "media"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "media-folders"] });
      toast({
        title: done === 1 ? "File uploaded" : `${done} files uploaded`,
        message:
          failed > 0
            ? `${failed} file${failed === 1 ? "" : "s"} failed — see the errors above.`
            : "The new file is at the top of the library — click it to pick it.",
        variant: "success",
      });
    }
  }

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const accept = mimes && mimes.length > 0 ? mimes.join(",") : mediaAcceptForKinds(kinds);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? "Choose from media library"}
      size="md"
      className="sm-media-picker-dialog"
    >
      <div
        className={`sm-media-picker${dragOver ? " sm-media-picker-dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <div className="sm-media-picker-toolbar">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files by name or tag…"
            aria-label="Search media library"
            autoComplete="off"
          />
          {allowedKinds.length > 1 && !mimes ? (
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as MediaLibraryKind | "");
                setVisible(PICKER_PAGE_SIZE);
              }}
              aria-label="Filter by type"
            >
              <option value="">All types</option>
              {allowedKinds.map((k) => (
                <option key={k} value={k}>
                  {MEDIA_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            value={currentFolder}
            onChange={(e) => {
              setCurrentFolder(e.target.value);
              setVisible(PICKER_PAGE_SIZE);
            }}
            aria-label="Filter by folder"
          >
            <option value="">All folders</option>
            {(foldersQuery.data ?? []).map((f) => (
              <option key={f} value={f}>
                {f === "" ? "(root)" : f}
              </option>
            ))}
          </Select>
        </div>

        {listQuery.isPending ? (
          <p className="sm-muted" style={{ padding: "24px 0", textAlign: "center" }}>
            Loading media…
          </p>
        ) : listQuery.isError ? (
          <p className="sm-muted" style={{ padding: "24px 0", textAlign: "center" }}>
            {listQuery.error instanceof Error
              ? listQuery.error.message
              : "Could not load the media library."}{" "}
            <Button variant="secondary" size="sm" onClick={() => void listQuery.refetch()}>
              Retry
            </Button>
          </p>
        ) : items.length === 0 ? (
          <p className="sm-muted" style={{ padding: "24px 0", textAlign: "center" }}>
            {debouncedQ || kind || currentFolder
              ? "No files match — try a different search, or upload one below."
              : "The library is empty — upload your first file below."}
          </p>
        ) : (
          <>
            <div className="sm-media-grid sm-media-grid-picker">
              {items.map((asset) => {
                const Icon = kindIcon(asset.kind);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className="sm-media-card"
                    onClick={() => {
                      onSelect(asset);
                      onClose();
                    }}
                    title={`${asset.original_filename} · ${formatBytes(asset.byte_size)}`}
                  >
                    <span className="sm-media-thumb">
                      {asset.kind === "image" ? (
                        <img src={asset.content_url} alt="" loading="lazy" />
                      ) : asset.kind === "video" ? (
                        <video src={asset.content_url} preload="metadata" muted />
                      ) : (
                        <Icon size={28} strokeWidth={1.5} />
                      )}
                    </span>
                    <span className="sm-media-card-name">{asset.original_filename}</span>
                    <span className="sm-media-card-meta">
                      {formatBytes(asset.byte_size)}
                      {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            {total > items.length ? (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setVisible((v) => v + PICKER_PAGE_SIZE)}
                >
                  Show more ({total - items.length} remaining)
                </Button>
              </div>
            ) : null}
          </>
        )}

        <div className="sm-media-picker-upload">
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} /> {uploading ? "Uploading…" : "Upload new"}
          </Button>
          <span className="sm-muted">
            {dragOver
              ? "Drop files to upload them"
              : `Uploads go to ${currentFolder === "" ? "the root folder" : `“${currentFolder}”`} · up to 100 MB each`}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
