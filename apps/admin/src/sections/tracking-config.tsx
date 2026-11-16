/**
 * Tracking configuration — pixel groups (Settings area).
 *
 * Route (registered in router.tsx, under the Settings shell):
 *   /settings/tracking
 *
 * Endpoints used (all `tracking.manage`):
 *   GET    /api/v1/admin/integrated-sites
 *   GET    /api/v1/admin/integrated-sites/:siteId/tracking
 *   POST   /api/v1/admin/integrated-sites/:siteId/tracking
 *   PATCH  /api/v1/admin/integrated-sites/:siteId/tracking/:configId
 *   DELETE /api/v1/admin/integrated-sites/:siteId/tracking/:configId
 *
 * A pixel group is one (provider, pixel_id) configuration for one
 * site (migration 0006). Several groups per provider are allowed —
 * e.g. two Meta pixels on the same site. The CAPI token is
 * write-only: it is encrypted at rest and never returned by any
 * read endpoint, so the edit form leaves the token blank and only
 * re-encrypts when a new token is supplied.
 *
 * HONESTY NOTE — Meta CAPI delivery is a STUB in the current API:
 * events are recorded locally, no call to Meta is made (Batch 4).
 * TikTok has no delivery at all yet — its groups only store
 * configuration. This page never claims a delivery reached its
 * destination.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, Pencil, Plus, Trash2 } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey } from "../lib/query";
import {
  PageHeader,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Checkbox,
  DateCell,
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RowMenu,
  Select,
  StatusBadge,
  Switch,
  TableSkeleton,
  Toolbar,
  useConfirm,
} from "../components/primitives";
import type { IntegratedSite, TrackingConfig } from "./integrations";

/* Events the API accepts (packages/contracts — ALLOWED_TRACKING_EVENTS). */
/* "Purchase" is listed here but can only ever be emitted after        */
/* server-verified payment approval — never by a browser or external   */
/* caller (API spec §17.4).                                            */
const TRACKING_EVENTS = [
  "PageView",
  "ViewContent",
  "Lead",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
] as const;

const PROVIDER_LABELS: Record<TrackingConfig["provider"], string> = {
  meta: "Meta",
  tiktok: "TikTok",
};

/* ------------------------------------------------------------------ */
/* Section: site picker + groups table                                 */
/* ------------------------------------------------------------------ */
export function TrackingConfigSection() {
  const [siteId, setSiteId] = useState("");
  const navigate = useNavigate();
  const sitesQuery = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );
  const sites = sitesQuery.data ?? [];
  const site = sites.find((s) => s.id === siteId);

  return (
    <section aria-labelledby="tracking-config-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Tracking" }]}
        title="Tracking"
        help="Pixel groups — Meta Pixel + Conversions API, TikTok, and more"
      />
      <Alert variant="warning">
        Meta delivery is not live yet. An event marked “Processed
        (recorded)” was recorded locally — no call to Meta has been made.
        Real Meta CAPI delivery is Batch 4. TikTok has no delivery yet;
        its groups only store configuration.
      </Alert>
      {sitesQuery.isPending ? (
        <TableSkeleton rows={3} />
      ) : sitesQuery.isError ? (
        <div className="sm-table-wrap">
          <ErrorState
            message={
              sitesQuery.error instanceof Error
                ? sitesQuery.error.message
                : "Could not load integrated sites."
            }
            onRetry={() => void sitesQuery.refetch()}
          />
        </div>
      ) : sites.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No integrated sites yet"
          body="Register a site first — a pixel group belongs to one site."
          actionLabel="Register a site"
          onAction={() => navigate({ to: "/settings/websites" })}
        />
      ) : (
        <>
          <Toolbar>
            <Select
              aria-label="Integrated site"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              <option value="">Choose a site…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Toolbar>
          {site ? (
            <TrackingGroups site={site} />
          ) : (
            <EmptyState
              icon={BarChart3}
              title="Choose a site"
              body="Pixel groups are per-site. Pick a site above to see and manage its groups."
            />
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Groups table for one site                                           */
/* ------------------------------------------------------------------ */
function TrackingGroups({ site }: { site: IntegratedSite }) {
  const [dialog, setDialog] = useState<
    | null
    | { mode: "create" }
    | { mode: "edit"; config: TrackingConfig }
  >(null);
  const confirm = useConfirm();

  const query = useAdminDetail<{ items: TrackingConfig[] }>(
    "tracking-configs",
    site.id,
    `/api/v1/admin/integrated-sites/${site.id}/tracking`,
  );
  const groups = query.data?.items ?? [];

  const toggle = useAdminMutation<TrackingConfig, { id: string; status: string }>({
    mutationFn: ({ id, status }) =>
      apiRequest<TrackingConfig>(
        `/api/v1/admin/integrated-sites/${site.id}/tracking/${id}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      ),
    invalidateKeys: [detailKey("tracking-configs", site.id)],
    successTitle: "Pixel group updated",
  });

  const remove = useAdminMutation<TrackingConfig, string>({
    mutationFn: (configId) =>
      apiRequest<TrackingConfig>(
        `/api/v1/admin/integrated-sites/${site.id}/tracking/${configId}`,
        { method: "DELETE" },
      ),
    invalidateKeys: [detailKey("tracking-configs", site.id)],
    successTitle: "Pixel group deleted",
  });

  if (query.isPending) return <TableSkeleton rows={4} />;
  if (query.isError) {
    return (
      <div className="sm-table-wrap">
        <ErrorState
          message={
            query.error instanceof Error
              ? query.error.message
              : "Could not load pixel groups."
          }
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  return (
    <div>
      <Toolbar>
        <Button
          variant="accent"
          icon={Plus}
          onClick={() => setDialog({ mode: "create" })}
        >
          Create pixel group
        </Button>
      </Toolbar>
      {groups.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No pixel groups yet"
          body={`No tracking is configured for ${site.name}. Create a group to attach a Meta pixel or a TikTok pixel.`}
          actionLabel="Create pixel group"
          onAction={() => setDialog({ mode: "create" })}
        />
      ) : (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Provider</th>
                <th>Pixel ID</th>
                <th>Status</th>
                <th>Enabled</th>
                <th>Test code</th>
                <th>Events</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.label ?? g.pixel_id}</td>
                  <td>{PROVIDER_LABELS[g.provider]}</td>
                  <td>
                    <span className="sm-mono">{g.pixel_id}</span>
                  </td>
                  <td>
                    <StatusBadge status={g.status} />
                  </td>
                  <td>
                    <Switch
                      label={g.status === "enabled" ? "On" : "Off"}
                      checked={g.status === "enabled"}
                      disabled={toggle.isPending}
                      onChange={(e) =>
                        toggle.mutate({
                          id: g.id,
                          status: e.target.checked ? "enabled" : "disabled",
                        })
                      }
                    />
                  </td>
                  <td>
                    <span className="sm-mono">{g.test_event_code ?? "—"}</span>
                  </td>
                  <td>{g.enabled_events.join(", ")}</td>
                  <td>
                    <DateTimeCell value={g.updated_at} />
                  </td>
                  <td>
                    <RowMenu
                      items={[
                        {
                          icon: Pencil,
                          label: "Edit",
                          onSelect: () =>
                            setDialog({ mode: "edit", config: g }),
                        },
                        {
                          icon: Trash2,
                          label: "Delete",
                          danger: true,
                          onSelect: () =>
                            void (async () => {
                              const ok = await confirm({
                                title: "Delete pixel group?",
                                body: (
                                  <div>
                                    <p>
                                      {g.label ?? g.pixel_id} (
                                      {PROVIDER_LABELS[g.provider]}) will be
                                      permanently deleted and will stop
                                      receiving events for {site.name}. The
                                      stored CAPI token is deleted with it.
                                    </p>
                                  </div>
                                ),
                                confirmLabel: "Delete",
                                danger: true,
                                warning: `${g.label ?? g.pixel_id} (${PROVIDER_LABELS[g.provider]}) will be permanently deleted.`,
                              });
                              if (ok) remove.mutate(g.id);
                            })(),
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
      {dialog ? (
        <TrackingGroupDialog
          site={site}
          mode={dialog.mode}
          config={dialog.mode === "edit" ? dialog.config : null}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit dialog                                                */
/* ------------------------------------------------------------------ */
function TrackingGroupDialog({
  site,
  mode,
  config,
  onClose,
}: {
  site: IntegratedSite;
  mode: "create" | "edit";
  config: TrackingConfig | null;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<TrackingConfig["provider"]>(
    config?.provider ?? "meta",
  );
  const [label, setLabel] = useState(config?.label ?? "");
  const [pixelId, setPixelId] = useState(config?.pixel_id ?? "");
  const [token, setToken] = useState("");
  const [testCode, setTestCode] = useState(config?.test_event_code ?? "");
  const [events, setEvents] = useState<string[]>(
    config ? [...config.enabled_events] : [],
  );
  const [enabled, setEnabled] = useState(
    config ? config.status === "enabled" : true,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useAdminMutation<TrackingConfig, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TrackingConfig>(
        `/api/v1/admin/integrated-sites/${site.id}/tracking`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [detailKey("tracking-configs", site.id)],
    successTitle: "Pixel group created",
    onSuccess: () => onClose(),
  });

  const update = useAdminMutation<TrackingConfig, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TrackingConfig>(
        `/api/v1/admin/integrated-sites/${site.id}/tracking/${config!.id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    invalidateKeys: [detailKey("tracking-configs", site.id)],
    successTitle: "Pixel group updated",
    onSuccess: () => onClose(),
  });

  const toggleEvent = (event: string) =>
    setEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event],
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (pixelId.trim().length < 4)
      next.pixel_id = "Pixel ID must be at least 4 characters.";
    if (mode === "create" && token.trim().length < 8)
      next.access_token = "Access token must be at least 8 characters.";
    if (mode === "create" && token.trim().length === 0)
      next.access_token = "Access token is required.";
    if (events.length === 0)
      next.enabled_events = "Select at least one event.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    if (mode === "create") {
      create.mutate({
        provider,
        label: label.trim() || undefined,
        pixel_id: pixelId.trim(),
        access_token: token.trim(),
        test_event_code: testCode.trim() || undefined,
        enabled_events: events,
        status: enabled ? "enabled" : "disabled",
      });
      return;
    }

    // Edit: send only what changed — the API 422s a no-op body, and
    // omitting access_token keeps the stored token (rotated_at
    // untouched). A token is re-encrypted only when one is supplied.
    const body: Record<string, unknown> = {};
    if (provider !== config!.provider) body.provider = provider;
    if (label.trim() !== (config!.label ?? "")) {
      body.label = label.trim() || null;
    }
    if (pixelId.trim() !== config!.pixel_id) body.pixel_id = pixelId.trim();
    if (token.trim().length > 0) body.access_token = token.trim();
    if (testCode.trim() !== (config!.test_event_code ?? "")) {
      body.test_event_code = testCode.trim() || null;
    }
    const sorted = (list: string[]) => [...list].sort();
    if (
      JSON.stringify(sorted(events)) !==
      JSON.stringify(sorted(config!.enabled_events))
    ) {
      body.enabled_events = events;
    }
    if ((enabled ? "enabled" : "disabled") !== config!.status) {
      body.status = enabled ? "enabled" : "disabled";
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    update.mutate(body);
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        mode === "create"
          ? `Create pixel group — ${site.name}`
          : `Edit pixel group — ${config!.label ?? config!.pixel_id}`
      }
    >
      <form onSubmit={submit}>
        <div className="sm-form-grid">
          <Field label="Site">
            <Input value={site.name} disabled />
          </Field>
          <Field label="Provider" required>
            <Select
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as TrackingConfig["provider"])
              }
            >
              <option value="meta">Meta</option>
              <option value="tiktok">TikTok</option>
            </Select>
          </Field>
          <Field label="Group label" hint="Shown in the list; falls back to the pixel ID.">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Main store pixel"
              maxLength={120}
            />
          </Field>
          <Field label="Pixel ID" required error={errors.pixel_id}>
            <Input
              value={pixelId}
              onChange={(e) => setPixelId(e.target.value)}
              placeholder="e.g. 123456789012345"
            />
          </Field>
          <Field
            label="CAPI access token"
            required={mode === "create"}
            error={errors.access_token}
            hint={
              mode === "edit"
                ? "Leave empty to keep the current token. A new token is encrypted and replaces it."
                : "Encrypted at rest. Never shown again after saving."
            }
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              placeholder={
                mode === "edit" ? "•••••••• (unchanged)" : "EAAB…"
              }
            />
          </Field>
          <Field label="Test event code" hint="Meta test-events code; leave empty when not testing.">
            <Input
              value={testCode}
              onChange={(e) => setTestCode(e.target.value)}
              placeholder="e.g. TEST12345"
            />
          </Field>
          <Field
            label="Enabled events"
            required
            error={errors.enabled_events}
            hint="Purchase is emitted only after server-verified payment approval."
          >
            <div className="sm-stack">
              {TRACKING_EVENTS.map((event) => (
                <Checkbox
                  key={event}
                  label={event}
                  checked={events.includes(event)}
                  onChange={() => toggleEvent(event)}
                />
              ))}
            </div>
          </Field>
          <Field label="Status">
            <Switch
              label={enabled ? "Enabled" : "Disabled"}
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
          </Field>
        </div>
        <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" type="submit" loading={pending}>
            {mode === "create" ? "Create group" : "Save changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
