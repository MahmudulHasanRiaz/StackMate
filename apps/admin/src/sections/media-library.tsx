/**
 * Media Library (PLAN §31 / ADR-0011) — the main-menu section.
 *
 * Route: /media (Product group, `media.view`).
 *
 * Endpoints used:
 *   GET    /api/v1/admin/media?q=&kind=&folder=&limit=&offset=
 *   GET    /api/v1/admin/media/folders
 *   POST   /api/v1/admin/media            (multipart FormData)
 *   GET    /api/v1/admin/media/:id
 *   PATCH  /api/v1/admin/media/:id        (rename / move / tags)
 *   DELETE /api/v1/admin/media/:id
 *   GET    /api/v1/admin/media/:id/content
 *
 * Search is server-side over the FULL dataset (owner hard rule,
 * PLAN §29): typing `q` re-queries the server — a match at row 500
 * is found, never only the loaded page. Grid + list views, folder
 * sidebar, preview drawer, bulk delete, empty states stay empty
 * (never invented).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  Folder,
  Images,
  LayoutGrid,
  List,
  Pencil,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiErrorMessage, PageHeader, useAdminMutation } from "../lib/section-kit";
import { ApiClientError } from "../lib/api-client";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Pagination,
  RowMenu,
  SearchableSelect,
  TableSkeleton,
  useConfirm,
  useToast,
} from "../components/primitives";
import { mediaKindIcon } from "../components/media-picker";
import {
  deleteMediaAsset,
  fetchMediaFolders,
  fetchMediaList,
  formatBytes,
  MEDIA_KIND_LABELS,
  MEDIA_KINDS,
  MEDIA_UPLOAD_ACCEPT,
  patchMediaAsset,
  uploadMediaFile,
  type MediaAssetView,
  type MediaLibraryKind,
} from "../lib/media";

const MEDIA_QUERY_KEY = ["admin", "media"] as const;
const FOLDERS_QUERY_KEY = ["admin", "media-folders"] as const;

function kindLabel(kind: MediaLibraryKind): string {
  return MEDIA_KIND_LABELS[kind];
}

function MediaThumb({ asset, size = 32 }: { asset: MediaAssetView; size?: number }) {
  const Icon = mediaKindIcon(asset.kind);
  if (asset.kind === "image") {
    return (
      <img
        src={asset.content_url}
        alt=""
        loading="lazy"
        width={size}
        height={size}
        className="sm-media-thumb-img"
      />
    );
  }
  if (asset.kind === "video") {
    return <video src={asset.content_url} preload="metadata" muted width={size} height={size} className="sm-media-thumb-img" />;
  }
  return <Icon size={18} strokeWidth={1.5} />;
}

export function MediaLibrarySection() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [kind, setKind] = useState<MediaLibraryKind | "">("");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MediaAssetView | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<MediaAssetView | null>(null);
  const [moveTarget, setMoveTarget] = useState<MediaAssetView | null>(null);
  const [tagsTarget, setTagsTarget] = useState<MediaAssetView | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  // Any filter change restarts at page 1.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, kind, folder]);

  const listQuery = useQuery({
    queryKey: [
      ...MEDIA_QUERY_KEY,
      { q: debouncedQ, kind: kind || undefined, folder, page, pageSize },
    ],
    queryFn: () =>
      fetchMediaList({
        q: debouncedQ || undefined,
        kind: kind || undefined,
        folder,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
  });

  const foldersQuery = useQuery({
    queryKey: FOLDERS_QUERY_KEY,
    queryFn: fetchMediaFolders,
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const folders = foldersQuery.data ?? [];

  const deleteMutation = useAdminMutation<{ deleted: boolean }, { id: string }>({
    mutationFn: ({ id }) => deleteMediaAsset(id).then(() => ({ deleted: true })),
    invalidateKeys: [MEDIA_QUERY_KEY, FOLDERS_QUERY_KEY],
    successTitle: "File deleted",
    onSuccess: (_data, variables) => {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(variables.id);
        return next;
      });
      if (detail?.id === variables.id) setDetail(null);
    },
  });

  const patchMutation = useAdminMutation<MediaAssetView, { id: string; body: Parameters<typeof patchMediaAsset>[1] }>({
    mutationFn: ({ id, body }) => patchMediaAsset(id, body),
    invalidateKeys: [MEDIA_QUERY_KEY, FOLDERS_QUERY_KEY],
    successTitle: "File updated",
    onSuccess: (data) => {
      if (detail?.id === data.id) setDetail(data);
      setRenameTarget(null);
      setMoveTarget(null);
      setTagsTarget(null);
    },
  });

  async function handleDelete(asset: MediaAssetView) {
    const ok = await confirm({
      title: "Delete file?",
      body: (
        <>
          This will permanently delete <strong>{asset.original_filename}</strong> from the
          library and from storage. This cannot be undone.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
      warning: `This will permanently delete ${asset.original_filename}. Are you sure you want to proceed?`,
    });
    if (ok) deleteMutation.mutate({ id: asset.id });
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Delete ${selected.size} file${selected.size === 1 ? "" : "s"}?`,
      body: (
        <>
          This will permanently delete {selected.size} file{selected.size === 1 ? "" : "s"} from
          the library and from storage. This cannot be undone.
        </>
      ),
      confirmLabel: "Delete all",
      danger: true,
      warning: `This will permanently delete ${selected.size} files. Are you sure you want to proceed?`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    let failed = 0;
    for (const id of selected) {
      try {
        await deleteMediaAsset(id);
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    await queryClient.invalidateQueries({ queryKey: MEDIA_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
    toast({
      title: failed === 0 ? "Files deleted" : "Some files could not be deleted",
      message:
        failed === 0
          ? `${selected.size} file${selected.size === 1 ? "" : "s"} deleted.`
          : `${failed} file${failed === 1 ? "" : "s"} failed to delete — try again.`,
      variant: failed === 0 ? "success" : "danger",
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = items.length > 0 && items.every((a) => selected.has(a.id));

  return (
    <div>
      <PageHeader
        title="Media Library"
        breadcrumb={[{ label: "Product" }, { label: "Media Library" }]}
        help="Every file the business uses — images, video, audio, documents, archives — in one private library. Files are stored in the selected storage driver (Settings → Storage) and served only through authenticated URLs. Search runs on the server over the whole library, so a file is found wherever it sits."
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setView(view === "grid" ? "list" : "grid")}
              aria-label={view === "grid" ? "Switch to list view" : "Switch to grid view"}
            >
              {view === "grid" ? <List size={14} /> : <LayoutGrid size={14} />} {view === "grid" ? "List" : "Grid"}
            </Button>
            <Button type="button" variant="primary" onClick={() => setUploadOpen(true)}>
              <Upload size={14} /> Upload
            </Button>
          </div>
        }
      />

      <div className="sm-media-layout">
        <aside className="sm-media-folders" aria-label="Folders">
          <div className="sm-media-folders-title">Folders</div>
          <button
            type="button"
            className={`sm-media-folder${folder === undefined ? " sm-media-folder-active" : ""}`}
            onClick={() => setFolder(undefined)}
          >
            <Folder size={14} /> All folders
          </button>
          <button
            type="button"
            className={`sm-media-folder${folder === "" ? " sm-media-folder-active" : ""}`}
            onClick={() => setFolder("")}
          >
            <Folder size={14} /> (root)
          </button>
          {folders
            .filter((f) => f !== "")
            .map((f) => (
              <button
                key={f}
                type="button"
                className={`sm-media-folder${folder === f ? " sm-media-folder-active" : ""}`}
                onClick={() => setFolder(f)}
                title={f}
              >
                <Folder size={14} /> {f}
              </button>
            ))}
        </aside>

        <div className="sm-media-main">
          <div className="sm-media-toolbar">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search files by name or tag…"
              aria-label="Search media library"
              autoComplete="off"
            />
            <div className="sm-media-kind-chips" role="group" aria-label="Filter by type">
              <button
                type="button"
                className={`sm-media-kind-chip${kind === "" ? " sm-media-kind-chip-active" : ""}`}
                onClick={() => setKind("")}
                aria-pressed={kind === ""}
              >
                All
              </button>
              {MEDIA_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`sm-media-kind-chip${kind === k ? " sm-media-kind-chip-active" : ""}`}
                  onClick={() => setKind(kind === k ? "" : k)}
                  aria-pressed={kind === k}
                >
                  {kindLabel(k)}
                </button>
              ))}
            </div>
          </div>

          {selected.size > 0 ? (
            <div className="sm-media-bulkbar">
              <span>
                {selected.size} selected
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={bulkDeleting}
                onClick={() => void handleBulkDelete()}
              >
                <Trash2 size={14} /> {bulkDeleting ? "Deleting…" : "Delete"}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}

          {listQuery.isPending ? (
            <TableSkeleton rows={5} />
          ) : listQuery.isError ? (
            <ErrorState
              message={apiErrorMessage(listQuery.error)}
              onRetry={() => void listQuery.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Images}
              title={debouncedQ || kind || folder !== undefined ? "No files match" : "No files yet"}
              body={
                debouncedQ || kind || folder !== undefined
                  ? "Try a different search or folder — or upload a file to the library."
                  : "Upload your first file — images, video, audio, PDFs, ZIPs and more, up to 100 MB each."
              }
              actionLabel="Upload a file"
              onAction={() => setUploadOpen(true)}
            />
          ) : view === "grid" ? (
            <div className="sm-media-grid">
              {items.map((asset) => {
                const Icon = mediaKindIcon(asset.kind);
                const checked = selected.has(asset.id);
                return (
                  <div
                    key={asset.id}
                    className={`sm-media-card-wrap${checked ? " sm-media-card-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="sm-media-card"
                      onClick={() => setDetail(asset)}
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
                        {asset.folder ? ` · ${asset.folder}` : ""}
                      </span>
                    </button>
                    <span className="sm-media-card-check">
                      <Checkbox
                        label=""
                        checked={checked}
                        onChange={() => toggleSelect(asset.id)}
                        aria-label={`Select ${asset.original_filename}`}
                      />
                    </span>
                    <span className="sm-media-card-menu">
                      <RowMenu
                        items={[
                          { label: "View details", onSelect: () => setDetail(asset) },
                          {
                            label: "Download",
                            onSelect: () => {
                              const a = document.createElement("a");
                              a.href = asset.content_url;
                              a.download = asset.original_filename;
                              a.click();
                            },
                          },
                          { label: "Rename", onSelect: () => setRenameTarget(asset) },
                          { label: "Move to folder", onSelect: () => setMoveTarget(asset) },
                          { label: "Edit tags", onSelect: () => setTagsTarget(asset) },
                          {
                            label: "Delete",
                            danger: true,
                            onSelect: () => void handleDelete(asset),
                          },
                        ]}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <Checkbox
                        label=""
                        checked={allSelected}
                        onChange={() => {
                          if (allSelected) {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              for (const a of items) next.delete(a.id);
                              return next;
                            });
                          } else {
                            setSelected((prev) => new Set([...prev, ...items.map((a) => a.id)]));
                          }
                        }}
                        aria-label="Select all files on this page"
                      />
                    </th>
                    <th>File</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Folder</th>
                    <th>Uploaded</th>
                    <th style={{ width: 48 }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((asset) => (
                    <tr key={asset.id}>
                      <td>
                        <Checkbox
                          label=""
                          checked={selected.has(asset.id)}
                          onChange={() => toggleSelect(asset.id)}
                          aria-label={`Select ${asset.original_filename}`}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="sm-media-row-file"
                          onClick={() => setDetail(asset)}
                        >
                          <span className="sm-media-row-thumb">
                            <MediaThumb asset={asset} />
                          </span>
                          <span className="sm-cell-line">{asset.original_filename}</span>
                        </button>
                      </td>
                      <td>
                        <span className="sm-cell-line">
                          {kindLabel(asset.kind)} · {asset.mime_type}
                        </span>
                      </td>
                      <td>
                        <span className="sm-cell-line">{formatBytes(asset.byte_size)}</span>
                      </td>
                      <td>
                        <span className="sm-cell-line">{asset.folder === "" ? "(root)" : asset.folder}</span>
                      </td>
                      <td>
                        <span className="sm-cell-line">
                          {new Date(asset.created_at).toLocaleDateString("en-GB")}
                        </span>
                      </td>
                      <td>
                        <RowMenu
                          items={[
                            { label: "View details", onSelect: () => setDetail(asset) },
                            {
                              label: "Download",
                              onSelect: () => {
                                const a = document.createElement("a");
                                a.href = asset.content_url;
                                a.download = asset.original_filename;
                                a.click();
                              },
                            },
                            { label: "Rename", onSelect: () => setRenameTarget(asset) },
                            { label: "Move to folder", onSelect: () => setMoveTarget(asset) },
                            { label: "Edit tags", onSelect: () => setTagsTarget(asset) },
                            {
                              label: "Delete",
                              danger: true,
                              onSelect: () => void handleDelete(asset),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > 0 ? (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          ) : null}
        </div>
      </div>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        folder={folder === undefined ? "" : folder}
        folders={folders}
      />
      <RenameDialog
        asset={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSave={(name) => {
          if (renameTarget) patchMutation.mutate({ id: renameTarget.id, body: { original_filename: name } });
        }}
        pending={patchMutation.isPending}
      />
      <MoveDialog
        asset={moveTarget}
        folders={folders}
        onClose={() => setMoveTarget(null)}
        onSave={(nextFolder) => {
          if (moveTarget) patchMutation.mutate({ id: moveTarget.id, body: { folder: nextFolder } });
        }}
        pending={patchMutation.isPending}
      />
      <TagsDialog
        asset={tagsTarget}
        onClose={() => setTagsTarget(null)}
        onSave={(tags) => {
          if (tagsTarget) patchMutation.mutate({ id: tagsTarget.id, body: { tags } });
        }}
        pending={patchMutation.isPending}
      />
      <Drawer open={detail !== null} onClose={() => setDetail(null)} title={detail?.original_filename ?? "File"}>
        {detail ? <MediaDetail asset={detail} onDelete={() => void handleDelete(detail)} onRename={() => setRenameTarget(detail)} onMove={() => setMoveTarget(detail)} onTags={() => setTagsTarget(detail)} /> : null}
      </Drawer>
    </div>
  );
}

type FileUploadStatus = {
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
};

/** Icon kind for a not-yet-uploaded local File (MIME prefix + extension). */
function kindOfFile(file: File): MediaLibraryKind {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/zip" || name.endsWith(".zip")) return "archive";
  if (type === "application/pdf" || type.startsWith("text/") || name.endsWith(".csv"))
    return "document";
  return "other";
}

function UploadDialog({
  open,
  onClose,
  folder,
  folders,
}: {
  open: boolean;
  onClose: () => void;
  folder: string;
  folders: string[];
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [states, setStates] = useState<FileUploadStatus[]>([]);
  const [targetFolder, setTargetFolder] = useState(folder);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setFiles([]);
      setStates([]);
      setTargetFolder(folder);
      setCreatingFolder(false);
      setNewFolder("");
      setTags([]);
      setTagInput("");
      setDragOver(false);
    }
  }, [open, folder]);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}\0${f.size}\0${f.lastModified}`));
      const fresh = incoming.filter(
        (f) => !seen.has(`${f.name}\0${f.size}\0${f.lastModified}`),
      );
      if (fresh.length === 0) return prev;
      setStates((prevStates) => [
        ...prevStates,
        ...fresh.map(() => ({ status: "queued" as const })),
      ]);
      return [...prev, ...fresh];
    });
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setStates((prev) => prev.filter((_, i) => i !== index));
  }

  function addTag(value: string) {
    const tag = value.trim();
    if (tag === "") return;
    setTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag],
    );
  }

  const failedCount = states.filter((s) => s.status === "error").length;
  const doneCount = states.filter((s) => s.status === "done").length;

  async function handleUpload() {
    // Retry covers only the failed files; a fresh upload covers everything
    // not already done (a second click after a partial failure re-tries).
    const pending = files
      .map((file, index) => ({ file, index }))
      .filter(({ index }) => states[index]?.status !== "done");
    if (pending.length === 0 || uploading) return;
    setUploading(true);
    const uploadFolder = (creatingFolder ? newFolder.trim() : targetFolder.trim()) || undefined;
    let done = 0;
    let failed = 0;
    for (const { file, index } of pending) {
      setStates((prev) =>
        prev.map((s, i) => (i === index ? { status: "uploading" } : s)),
      );
      try {
        await uploadMediaFile(file, {
          folder: uploadFolder,
          tags: tags.length > 0 ? tags : undefined,
        });
        setStates((prev) => prev.map((s, i) => (i === index ? { status: "done" } : s)));
        done += 1;
      } catch (err) {
        const message =
          err instanceof ApiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : `Could not upload ${file.name}.`;
        setStates((prev) =>
          prev.map((s, i) => (i === index ? { status: "error", error: message } : s)),
        );
        failed += 1;
      }
    }
    setUploading(false);
    if (done > 0) {
      await queryClient.invalidateQueries({ queryKey: MEDIA_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
    }
    // Close only when everything succeeded; a failed file stays visible
    // with its own error row, and the button becomes Retry.
    if (failed === 0 && done > 0) {
      toast({
        title: done === 1 ? "File uploaded" : `${done} files uploaded`,
        message: "The new files are at the top of the library.",
        variant: "success",
      });
      onClose();
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Upload files" size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Files">
          <div
            className={`sm-media-dropzone${dragOver ? " sm-media-dropzone-over" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="Choose files to upload"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <Upload size={20} strokeWidth={2} />
            <span className="sm-media-dropzone-title">Drop files here</span>
            <span className="sm-media-dropzone-sub">
              or <span className="sm-media-dropzone-browse">browse</span> to choose files
            </span>
            <span className="sm-media-dropzone-hint">
              Images, video, audio, PDF, ZIP, text, CSV — up to 100 MB each.
            </span>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={MEDIA_UPLOAD_ACCEPT}
            style={{ display: "none" }}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              addFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
        </Field>
        {files.length > 0 ? (
          <ul className="sm-media-upload-list">
            {files.map((file, i) => {
              const state = states[i] ?? { status: "queued" as const };
              const Icon = mediaKindIcon(kindOfFile(file));
              return (
                <li
                  key={`${file.name}-${file.size}-${file.lastModified}`}
                  className="sm-media-upload-row"
                  data-state={state.status}
                >
                  <Icon size={16} strokeWidth={2} />
                  <span className="sm-media-upload-main">
                    <span className="sm-media-upload-name" title={file.name}>
                      {file.name}
                    </span>
                    {state.status === "error" && state.error ? (
                      <span className="sm-media-upload-error">{state.error}</span>
                    ) : null}
                  </span>
                  <span className="sm-media-upload-size">{formatBytes(file.size)}</span>
                  {state.status === "done" ? (
                    <Check size={16} strokeWidth={2} className="sm-media-upload-done" />
                  ) : null}
                  <button
                    type="button"
                    className="sm-media-upload-remove"
                    aria-label={`Remove ${file.name}`}
                    disabled={uploading || state.status === "uploading"}
                    onClick={() => removeFile(i)}
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <Field label="Folder">
          <SearchableSelect
            value={creatingFolder ? "__new__" : targetFolder}
            onChange={(value) => {
              if (value === "__new__") {
                setCreatingFolder(true);
                return;
              }
              setCreatingFolder(false);
              setTargetFolder(value);
            }}
            options={[
              { value: "", label: "Root folder" },
              ...folders
                .filter((f) => f !== "")
                .map((f) => ({ value: f, label: f })),
            ]}
            leadingOptions={[{ value: "__new__", label: "New folder…" }]}
            placeholder="Choose a folder"
            ariaLabel="Target folder"
          />
          {creatingFolder ? (
            <Input
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              placeholder="e.g. brand/logos"
              autoComplete="off"
              aria-label="New folder name"
            />
          ) : null}
        </Field>
        <Field label="Tags">
          {tags.length > 0 ? (
            <span className="sm-media-tag-chips">
              {tags.map((tag) => (
                <span key={tag} className="sm-media-tag-chip">
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </span>
          ) : null}
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
                setTagInput("");
              }
            }}
            onBlur={() => {
              if (tagInput.trim() !== "") {
                addTag(tagInput);
                setTagInput("");
              }
            }}
            placeholder="Add a tag…"
            autoComplete="off"
            aria-label="Add a tag"
          />
        </Field>
        <div className="sm-dialog-footer" style={{ padding: 0, border: 0 }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={files.length === 0 || uploading || doneCount === files.length}
            onClick={() => void handleUpload()}
          >
            {uploading
              ? "Uploading…"
              : failedCount > 0
                ? `Retry ${failedCount} failed file${failedCount === 1 ? "" : "s"}`
                : `Upload ${files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}` : ""}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RenameDialog({
  asset,
  onClose,
  onSave,
  pending,
}: {
  asset: MediaAssetView | null;
  onClose: () => void;
  onSave: (name: string) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(asset?.original_filename ?? "");
  useEffect(() => {
    setName(asset?.original_filename ?? "");
  }, [asset]);
  return (
    <Dialog open={asset !== null} onClose={onClose} title="Rename file">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Filename">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <div className="sm-dialog-footer" style={{ padding: 0, border: 0 }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending || name.trim() === "" || name === asset?.original_filename}
            onClick={() => onSave(name)}
          >
            {pending ? "Saving…" : "Rename"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function MoveDialog({
  asset,
  folders,
  onClose,
  onSave,
  pending,
}: {
  asset: MediaAssetView | null;
  folders: string[];
  onClose: () => void;
  onSave: (folder: string) => void;
  pending: boolean;
}) {
  const [nextFolder, setNextFolder] = useState(asset?.folder ?? "");
  useEffect(() => {
    setNextFolder(asset?.folder ?? "");
  }, [asset]);
  return (
    <Dialog open={asset !== null} onClose={onClose} title="Move to folder">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Folder" hint="Leave empty for the root folder. Type a new name to create a folder.">
          <Input
            value={nextFolder}
            onChange={(e) => setNextFolder(e.target.value)}
            placeholder="(root)"
            list="media-folders-move"
            autoComplete="off"
          />
          <datalist id="media-folders-move">
            {folders.map((f) => (
              <option key={f || "(root)"} value={f} />
            ))}
          </datalist>
        </Field>
        <div className="sm-dialog-footer" style={{ padding: 0, border: 0 }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending || nextFolder === asset?.folder}
            onClick={() => onSave(nextFolder)}
          >
            {pending ? "Saving…" : "Move"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TagsDialog({
  asset,
  onClose,
  onSave,
  pending,
}: {
  asset: MediaAssetView | null;
  onClose: () => void;
  onSave: (tags: string[]) => void;
  pending: boolean;
}) {
  const [tagsText, setTagsText] = useState(asset?.tags.join(", ") ?? "");
  useEffect(() => {
    setTagsText(asset?.tags.join(", ") ?? "");
  }, [asset]);
  return (
    <Dialog open={asset !== null} onClose={onClose} title="Edit tags">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Tags" hint="Comma-separated — up to 10 tags, letters, digits, '-' or '_'. Tags are searchable.">
          <Input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="logo, brand"
            autoComplete="off"
          />
        </Field>
        <div className="sm-dialog-footer" style={{ padding: 0, border: 0 }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" disabled={pending} onClick={() => onSave(tagsText.split(",").map((t) => t.trim()).filter(Boolean))}>
            {pending ? "Saving…" : "Save tags"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function MediaDetail({
  asset,
  onDelete,
  onRename,
  onMove,
  onTags,
}: {
  asset: MediaAssetView;
  onDelete: () => void;
  onRename: () => void;
  onMove: () => void;
  onTags: () => void;
}) {
  const Icon = mediaKindIcon(asset.kind);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="sm-media-detail-preview">
        {asset.kind === "image" ? (
          <img src={asset.content_url} alt={asset.original_filename} />
        ) : asset.kind === "video" ? (
          <video src={asset.content_url} controls preload="metadata" />
        ) : asset.kind === "audio" ? (
          <audio src={asset.content_url} controls preload="metadata" style={{ width: "100%" }} />
        ) : (
          <div className="sm-media-detail-icon">
            <Icon size={40} strokeWidth={1.5} />
            <span className="sm-muted">{asset.mime_type}</span>
          </div>
        )}
      </div>
      <dl className="sm-media-facts">
        <div>
          <dt>Filename</dt>
          <dd className="sm-mono">{asset.original_filename}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>
            {kindLabel(asset.kind)} · {asset.mime_type}
          </dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(asset.byte_size)}</dd>
        </div>
        {asset.width && asset.height ? (
          <div>
            <dt>Dimensions</dt>
            <dd>
              {asset.width} × {asset.height}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Folder</dt>
          <dd>{asset.folder === "" ? "(root)" : asset.folder}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{asset.tags.length > 0 ? asset.tags.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>{asset.driver === "r2" ? "Cloudflare R2" : "Local filesystem"}</dd>
        </div>
        <div>
          <dt>Uploaded</dt>
          <dd>{new Date(asset.created_at).toLocaleString("en-GB")}</dd>
        </div>
      </dl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <a
          className="sm-btn sm-btn-secondary"
          href={asset.content_url}
          download={asset.original_filename}
        >
          <Download size={14} /> Download
        </a>
        <Button type="button" variant="secondary" size="sm" onClick={onRename}>
          <Pencil size={14} /> Rename
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onMove}>
          <Folder size={14} /> Move
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onTags}>
          <Tag size={14} /> Tags
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onDelete}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>
    </div>
  );
}
