/**
 * Authentication settings (Auth + Email batch, ADR-0008) — Settings area.
 *
 * Route (registered in router.tsx, under the Settings shell):
 *   /settings/authentication
 *
 * Endpoints used (all `users.manage`):
 *   GET  /api/v1/admin/auth-config
 *   PUT  /api/v1/admin/auth-config/oauth
 *   PUT  /api/v1/admin/auth-config/two-factor-policy
 *
 * Two groups, one page:
 *   OAuth providers — Google + GitHub. Enable/disable + client ID +
 *     client secret (write-only: encrypted at rest, never returned;
 *     the field is blank unless a new secret is entered). Only
 *     enabled providers appear on the sign-in page.
 *   Two-factor policy — default OFF. Per scope (global default + each
 *     role): off / optional / required. `required` forces setup at
 *     sign-in; the session is restricted until setup completes.
 *
 * SMTP moved out (SMTP timeout fix batch, 2026-11-16, owner order):
 * email delivery is not authentication — it lives at
 * Settings → Email (`sections/email-settings.tsx`). The API paths are
 * unchanged; only the page moved.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { PageHeader, useAdminMutation } from "../lib/section-kit";
import { humanizeType } from "../lib/resolve-names";
import {
  Alert,
  Button,
  ErrorState,
  Field,
  Input,
  Select,
  Switch,
  TableSkeleton,
  useToast,
} from "../components/primitives";

type TwoFactorMode = "off" | "optional" | "required";

interface OAuthProviderView {
  provider: "google" | "github";
  enabled: boolean;
  client_id: string | null;
  has_client_secret: boolean;
  updated_at: string | null;
}

interface AuthConfig {
  oauth: OAuthProviderView[];
  two_factor_policy: { global: TwoFactorMode; roles: Record<string, TwoFactorMode> };
}

/** The 8 roles seeded by migration 0001 (same list the API validates). */
const ROLE_KEYS = [
  "super_admin",
  "admin",
  "finance_manager",
  "license_manager",
  "marketing_manager",
  "product_manager",
  "support_staff",
  "read_only",
] as const;

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

const MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "optional", label: "Optional" },
  { value: "required", label: "Required" },
];

function OAuthProviderCard({ provider, onSaved }: { provider: OAuthProviderView; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [clientId, setClientId] = useState(provider.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const mutation = useAdminMutation<OAuthProviderView, void>({
    mutationFn: () =>
      apiRequest<OAuthProviderView>("/api/v1/admin/auth-config/oauth", {
        method: "PUT",
        body: JSON.stringify({
          provider: provider.provider,
          enabled,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }),
      }),
    invalidateKeys: [["auth-config"]],
    successTitle: `${PROVIDER_LABELS[provider.provider]} saved`,
    onSuccess: () => {
      setClientSecret("");
      setError(null);
      onSaved();
    },
  });
  const dirty =
    enabled !== provider.enabled ||
    clientId !== (provider.client_id ?? "") ||
    clientSecret.length > 0;
  return (
    <div className="sm-card">
      <div className="sm-card-title">{PROVIDER_LABELS[provider.provider]}</div>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Switch
          label="Enabled — show on the sign-in page"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <Field label="Client ID" required={enabled} htmlFor={`oauth-client-id-${provider.provider}`}>
          <Input
            id={`oauth-client-id-${provider.provider}`}
            name="client_id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="OAuth client ID"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Client secret"
          htmlFor={`oauth-client-secret-${provider.provider}`}
          hint={
            provider.has_client_secret
              ? "A secret is stored (encrypted). Leave blank to keep it."
              : "Stored encrypted. Required to enable."
          }
        >
          <Input
            id={`oauth-client-secret-${provider.provider}`}
            name="client_secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={provider.has_client_secret ? "••••••••" : "OAuth client secret"}
            autoComplete="new-password"
          />
        </Field>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {mutation.isError ? (
          <Alert variant="danger">
            {(mutation.error as ApiClientError)?.message ?? "Could not save the provider."}
          </Alert>
        ) : null}
        <Button type="submit" variant="accent" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}

function TwoFactorPolicyRow({
  scope,
  label,
  mode,
  onSaved,
}: {
  scope: string;
  label: string;
  mode: TwoFactorMode;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<TwoFactorMode>(mode);
  const mutation = useAdminMutation<{ global: TwoFactorMode; roles: Record<string, TwoFactorMode> }, void>({
    mutationFn: () =>
      apiRequest<{ global: TwoFactorMode; roles: Record<string, TwoFactorMode> }>(
        "/api/v1/admin/auth-config/two-factor-policy",
        { method: "PUT", body: JSON.stringify({ scope, mode: value }) }
      ),
    invalidateKeys: [["auth-config"]],
    successTitle: `2FA policy saved for ${label}`,
    onSuccess: () => onSaved(),
  });
  return (
    <div className="sm-policy-row">
      <span className="sm-policy-label">{label}</span>
      <Select
        id={`2fa-policy-${scope}`}
        name="two_factor_mode"
        value={value}
        onChange={(e) => setValue(e.target.value as TwoFactorMode)}
        aria-label={`Two-factor policy for ${label}`}
      >
        {MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        disabled={value === mode || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

export function AuthSettingsSection() {
  const query = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => apiRequest<AuthConfig>("/api/v1/admin/auth-config"),
  });
  if (query.isPending) return <TableSkeleton rows={5} />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        message={`Could not load authentication settings. ${(query.error as ApiClientError)?.message ?? "Try again."}`}
        onRetry={() => void query.refetch()}
      />
    );
  }
  // Defensive normalization (Auth + Email fix batch): the endpoint
  // always returns the full view (see toAuthConfigView), but the page
  // must never crash on a partial shape — the live page fell to the
  // error boundary on `config.two_factor_policy.global` when the
  // endpoint returned camelCase `twoFactorPolicy`. Every section
  // below reads from this normalized object.
  const config: AuthConfig = {
    oauth: query.data.oauth ?? [],
    two_factor_policy: {
      global: query.data.two_factor_policy?.global ?? "off",
      roles: query.data.two_factor_policy?.roles ?? {},
    },
  };
  const refetch = () => void query.refetch();
  return (
    <div className="sm-page">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Authentication" }]}
        title="Authentication"
        help="OAuth providers shown on the sign-in page and the two-factor policy. Two-factor is off by default; Required forces staff with that role to set up two-factor at sign-in before they can use the admin. Email (SMTP) settings live under Settings → Email."
      />
      <h2 className="sm-section-title">OAuth providers</h2>
      <div className="sm-grid-2">
        {config.oauth.map((p) => (
          <OAuthProviderCard key={p.provider} provider={p} onSaved={refetch} />
        ))}
      </div>
      <h2 className="sm-section-title">Two-factor authentication policy</h2>
      <div className="sm-card">
        <TwoFactorPolicyRow
          scope="global"
          label="All roles (default)"
          mode={config.two_factor_policy.global}
          onSaved={refetch}
        />
        {ROLE_KEYS.map((key) => (
          <TwoFactorPolicyRow
            key={key}
            scope={key}
            label={humanizeType(key)}
            mode={config.two_factor_policy.roles[key] ?? config.two_factor_policy.global}
            onSaved={refetch}
          />
        ))}
      </div>
    </div>
  );
}
