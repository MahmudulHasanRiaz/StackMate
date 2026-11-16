/**
 * General settings (Auth + Email batch, owner order 2026-11-16) — Settings area.
 *
 * Route (registered in router.tsx, under the Settings shell):
 *   /settings/general
 *
 * Endpoints used (all `users.manage`):
 *   GET  /api/v1/admin/general-settings
 *   PUT  /api/v1/admin/general-settings
 *   POST /api/v1/admin/general-settings/favicon
 *
 * Every setting renders somewhere visible — no dead stored values:
 *   App Name ......... sidebar/topbar brand + document-title fallback.
 *   App Title ........ the browser tab (document.title).
 *   App Description .. meta description + the login page tagline.
 *   Support Email .... the login page contact for staff who cannot sign in.
 *   Favicon .......... PNG/ICO/SVG, ≤256KB, stored in R2 (server-side key)
 *                      and served publicly at /api/v1/favicon; the tab icon
 *                      updates when it is uploaded or removed.
 * A save invalidates the public general-config query, so the new values
 * apply immediately with no reload and no redeploy.
 */
import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { PageHeader, useAdminMutation } from "../lib/section-kit";
import {
  GENERAL_CONFIG_QUERY_KEY,
  type GeneralConfig,
} from "../lib/general-config";
import {
  Alert,
  Button,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
  Textarea,
  useToast,
} from "../components/primitives";

interface GeneralSettingsView extends GeneralConfig {
  favicon_content_type: string | null;
  favicon_byte_size: number | null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>" — the API takes the payload only.
      resolve(result.split(",", 2)[1] ?? "");
    };
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

export function GeneralSettingsSection() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "general-settings"],
    queryFn: () =>
      apiRequest<GeneralSettingsView>("/api/v1/admin/general-settings"),
  });
  if (isLoading) return <TableSkeleton rows={6} />;
  if (error || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load general settings."}
        onRetry={() => void refetch()}
      />
    );
  }
  return <GeneralSettingsForm initial={data} />;
}

function GeneralSettingsForm({ initial }: { initial: GeneralSettingsView }) {
  const [appName, setAppName] = useState(initial.app_name);
  const [appTitle, setAppTitle] = useState(initial.app_title);
  const [appDescription, setAppDescription] = useState(initial.app_description);
  const [supportEmail, setSupportEmail] = useState(initial.support_email);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(initial.favicon_url);
  const [faviconInfo, setFaviconInfo] = useState(
    initial.favicon_content_type
      ? `${initial.favicon_content_type}${initial.favicon_byte_size != null ? ` · ${Math.round(initial.favicon_byte_size / 1024)} KB` : ""}`
      : null
  );
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const saveMutation = useAdminMutation<GeneralSettingsView, void>({
    mutationFn: () =>
      apiRequest<GeneralSettingsView>("/api/v1/admin/general-settings", {
        method: "PUT",
        body: JSON.stringify({
          app_name: appName,
          app_title: appTitle,
          app_description: appDescription,
          support_email: supportEmail,
        }),
      }),
    invalidateKeys: [GENERAL_CONFIG_QUERY_KEY],
    successTitle: "General settings saved",
    successMessage: "The new name, title, description, and support email are live now.",
  });

  const removeMutation = useAdminMutation<GeneralSettingsView, void>({
    mutationFn: () =>
      apiRequest<GeneralSettingsView>("/api/v1/admin/general-settings", {
        method: "PUT",
        body: JSON.stringify({ clear_favicon: true }),
      }),
    invalidateKeys: [GENERAL_CONFIG_QUERY_KEY],
    successTitle: "Favicon removed",
    onSuccess: () => {
      setFaviconUrl(null);
      setFaviconInfo(null);
    },
  });

  async function handleFaviconFile(file: File | undefined) {
    if (!file) return;
    setFormError(null);
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const stored = await apiRequest<{
        favicon_url: string;
        content_type: string;
        byte_size: number;
      }>("/api/v1/admin/general-settings/favicon", {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          content_type: file.type,
          content_base64: base64,
        }),
      });
      setFaviconUrl(`${stored.favicon_url}?v=${Date.now()}`);
      setFaviconInfo(
        `${stored.content_type} · ${Math.round(stored.byte_size / 1024)} KB`
      );
      toast({ title: "Favicon uploaded", message: "The browser tab icon updates now.", variant: "success" });
      // Refresh the public config so the new icon applies immediately.
      void queryClient.invalidateQueries({ queryKey: GENERAL_CONFIG_QUERY_KEY });
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Favicon upload failed."
      );
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    saveMutation.mutate();
  }

  return (
    <div>
      <PageHeader
        title="General"
        breadcrumb={[{ label: "Settings" }, { label: "General" }]}
        help="App-wide settings. Everything here is live as soon as you save — no redeploy. The name shows in the sidebar and as the tab-title fallback, the title is the browser tab, the description is the login page tagline and meta description, and the support email is the contact shown on the sign-in page."
      />
      {formError ? <Alert variant="danger">{formError}</Alert> : null}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <Field label="App name" hint="Sidebar and topbar brand. Shown when no tab title is set.">
          <Input
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            maxLength={120}
            required
            autoComplete="off"
          />
        </Field>
        <Field label="App title" hint="The browser tab title.">
          <Input
            value={appTitle}
            onChange={(e) => setAppTitle(e.target.value)}
            maxLength={120}
            required
            autoComplete="off"
          />
        </Field>
        <Field label="App description" hint="Short tagline — shown on the sign-in page and used as the meta description.">
          <Textarea
            value={appDescription}
            onChange={(e) => setAppDescription(e.target.value)}
            maxLength={500}
            rows={3}
          />
        </Field>
        <Field label="Support email" hint="Shown on the sign-in page for staff who cannot sign in. Leave empty to hide it.">
          <Input
            type="email"
            value={supportEmail}
            onChange={(e) => setSupportEmail(e.target.value)}
            maxLength={200}
            autoComplete="off"
            placeholder="support@example.com"
          />
        </Field>
        <Field label="Favicon" hint="PNG, ICO, or SVG, up to 256 KB. Stored in R2 and served at /api/v1/favicon.">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {faviconUrl ? (
              <img
                src={faviconUrl}
                alt="Current favicon"
                width={32}
                height={32}
                style={{ border: "1px solid var(--sm-border)", borderRadius: 4, background: "var(--sm-surface)" }}
              />
            ) : (
              <span className="sm-muted">No favicon uploaded</span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,.png,.ico,.svg"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleFaviconFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading…" : faviconUrl ? "Replace favicon" : "Upload favicon"}
            </Button>
            {faviconUrl ? (
              <Button
                type="button"
                variant="secondary"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
              >
                Remove
              </Button>
            ) : null}
          </div>
          {faviconInfo ? <div className="sm-muted" style={{ marginTop: 6 }}>{faviconInfo}</div> : null}
        </Field>
        <div className="sm-form-actions">
          <Button type="submit" variant="accent" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save general settings"}
          </Button>
        </div>
      </form>
    </div>
  );
}
