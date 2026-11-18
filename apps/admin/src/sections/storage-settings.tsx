/**
 * Storage settings (PLAN §31 / ADR-0011) — Settings area.
 *
 * Route (registered in router.tsx, under the Settings shell):
 *   /settings/storage
 *
 * Endpoints used (both `users.manage`):
 *   GET /api/v1/admin/storage-settings
 *   PUT /api/v1/admin/storage-settings
 *
 * The driver choice is runtime-applied — no redeploy. Switching
 * drivers never orphans media library files (each file remembers its
 * own driver), but the favicon and payment evidence stored under the
 * previous driver become unreachable until you switch back — the page
 * warns about this explicitly and the switch is audit-logged.
 *
 * R2 is the only driver on Cloudflare Workers; Local is for
 * Docker/VPS deployments with a real filesystem (the API refuses
 * Local on Workers with an honest 503 instead of storing nowhere).
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, useAdminMutation } from "../lib/section-kit";
import {
  Alert,
  Button,
  CopyButton,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from "../components/primitives";
import {
  fetchStorageSettings,
  saveStorageSettings,
  type StorageSettingsView,
} from "../lib/media";

export function StorageSettingsSection() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "storage-settings"],
    queryFn: fetchStorageSettings,
  });
  if (isLoading) return <TableSkeleton rows={6} />;
  if (error || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load storage settings."}
        onRetry={() => void refetch()}
      />
    );
  }
  return <StorageSettingsForm initial={data} />;
}

function StorageSettingsForm({ initial }: { initial: StorageSettingsView }) {
  const [driver, setDriver] = useState<"r2" | "local">(initial.driver);
  const [localPath, setLocalPath] = useState(initial.local_path ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const changed =
    driver !== initial.driver || (driver === "local" && localPath.trim() !== (initial.local_path ?? ""));

  const saveMutation = useAdminMutation<StorageSettingsView, void>({
    mutationFn: () =>
      saveStorageSettings({
        driver,
        ...(driver === "local" ? { local_path: localPath.trim() === "" ? null : localPath.trim() } : {}),
      }),
    invalidateKeys: [["admin", "storage-settings"]],
    successTitle: "Storage settings saved",
    successMessage:
      driver === "r2"
        ? "New uploads go to Cloudflare R2."
        : "New uploads go to the local filesystem directory.",
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    saveMutation.mutate();
  }

  return (
    <div>
      <PageHeader
        title="Storage"
        breadcrumb={[{ label: "Settings" }, { label: "Storage" }]}
        help="Where uploaded files live. R2 is the Cloudflare object store (the only driver on Workers); Local stores files on the server's own disk for Docker/VPS deployments without Cloudflare. The choice applies immediately — no redeploy."
      />
      {formError ? <Alert variant="danger">{formError}</Alert> : null}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <Field label="Storage driver" hint="Applies to new uploads immediately. Existing files are unaffected — see the warning below.">
          <Select value={driver} onChange={(e) => setDriver(e.target.value as "r2" | "local")}>
            <option value="r2">Cloudflare R2 (recommended)</option>
            <option value="local">Local filesystem (Docker / VPS)</option>
          </Select>
        </Field>
        {driver === "r2" ? (
          <Field label="R2 bucket">
            <span className="sm-cell-line">
              <span className="sm-mono sm-cell-text">{initial.r2_bucket}</span>
              <CopyButton value={initial.r2_bucket} label="Copy bucket name" />
            </span>
          </Field>
        ) : null}
        {driver === "local" ? (
          <Field
            label="Local directory"
            hint="Directory on the server where files are stored, e.g. ./data/media (relative to the app working directory) or /var/lib/stackmate/media. Leave empty to use the default (./data/media). Unavailable on Cloudflare Workers — the API refuses Local there instead of storing nowhere."
          >
            <Input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="./data/media"
              maxLength={500}
              autoComplete="off"
            />
          </Field>
        ) : null}
        <Alert variant="warning">
          Switching drivers does not move files already stored. Media library files keep working —
          each file remembers the driver it was uploaded with. The favicon and payment evidence,
          however, follow the <em>current</em> driver: files stored under the previous driver become
          unreachable until you switch back. The switch is recorded in the audit log.
        </Alert>
        <div className="sm-form-actions">
          <Button type="submit" variant="accent" disabled={saveMutation.isPending || !changed}>
            {saveMutation.isPending ? "Saving…" : "Save storage settings"}
          </Button>
        </div>
      </form>
    </div>
  );
}
