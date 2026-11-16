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
 *   PUT  /api/v1/admin/auth-config/smtp
 *   POST /api/v1/admin/auth-config/smtp/test
 *
 * Three groups, one page:
 *   OAuth providers — Google + GitHub. Enable/disable + client ID +
 *     client secret (write-only: encrypted at rest, never returned;
 *     the field is blank unless a new secret is entered). Only
 *     enabled providers appear on the sign-in page.
 *   Two-factor policy — default OFF. Per scope (global default + each
 *     role): off / optional / required. `required` forces setup at
 *     sign-in; the session is restricted until setup completes.
 *   SMTP / Email — provider-agnostic (any SMTP host). Password is
 *     write-only like the OAuth secret. "Send test email" sends a real
 *     test mail to the admin's own address and reports the honest
 *     result — success or the real error, never a fake success. When
 *     SMTP is not configured the page says so plainly: forgot
 *     password, invitation and 2FA-recovery emails cannot be sent.
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

interface SmtpSettingsView {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  tls_mode: "starttls" | "ssl" | "none";
  from_address: string;
  from_name: string;
  enabled: boolean;
  updated_at: string | null;
}

interface AuthConfig {
  oauth: OAuthProviderView[];
  two_factor_policy: { global: TwoFactorMode; roles: Record<string, TwoFactorMode> };
  smtp: SmtpSettingsView;
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
        <Field label="Client ID" required={enabled}>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="OAuth client ID"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Client secret"
          hint={
            provider.has_client_secret
              ? "A secret is stored (encrypted). Leave blank to keep it."
              : "Stored encrypted. Required to enable."
          }
        >
          <Input
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

function SmtpForm({ smtp, onSaved }: { smtp: SmtpSettingsView; onSaved: () => void }) {
  const [host, setHost] = useState(smtp.host);
  const [port, setPort] = useState(String(smtp.port));
  const [username, setUsername] = useState(smtp.username);
  const [password, setPassword] = useState("");
  const [tlsMode, setTlsMode] = useState(smtp.tls_mode);
  const [fromAddress, setFromAddress] = useState(smtp.from_address);
  const [fromName, setFromName] = useState(smtp.from_name);
  const [enabled, setEnabled] = useState(smtp.enabled);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testPending, setTestPending] = useState(false);
  const { toast } = useToast();
  const mutation = useAdminMutation<SmtpSettingsView, void>({
    mutationFn: () =>
      apiRequest<SmtpSettingsView>("/api/v1/admin/auth-config/smtp", {
        method: "PUT",
        body: JSON.stringify({
          host,
          port: Number(port),
          username,
          ...(password ? { password } : {}),
          tls_mode: tlsMode,
          from_address: fromAddress,
          from_name: fromName,
          enabled,
        }),
      }),
    invalidateKeys: [["auth-config"]],
    successTitle: "SMTP settings saved",
    onSuccess: () => {
      setPassword("");
      onSaved();
    },
  });
  const sendTest = async () => {
    setTestPending(true);
    setTestResult(null);
    try {
      await apiRequest<{ sent: boolean; to: string }>("/api/v1/admin/auth-config/smtp/test", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setTestResult({ ok: true, message: "Test email sent. Check your inbox." });
      toast({ title: "Test email sent", message: "Check your inbox for the StackMate test email." });
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Test email could not be sent.";
      setTestResult({ ok: false, message });
    } finally {
      setTestPending(false);
    }
  };
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      {!smtp.enabled ? (
        <Alert variant="info">
          Email is not configured. Forgot password, invitation and 2FA-recovery emails cannot be
          sent until SMTP is enabled here.
        </Alert>
      ) : null}
      <Switch
        label="Enabled"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <Field label="SMTP host" required={enabled}>
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.com"
          autoComplete="off"
        />
      </Field>
      <Field label="Port" required={enabled} hint="465 for implicit TLS, 587 for STARTTLS. Port 25 is blocked by Cloudflare Workers.">
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
        />
      </Field>
      <Field label="Username">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field
        label="Password"
        hint={
          smtp.has_password
            ? "A password is stored (encrypted). Leave blank to keep it."
            : "Stored encrypted."
        }
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={smtp.has_password ? "••••••••" : "SMTP password"}
          autoComplete="new-password"
        />
      </Field>
      <Field label="TLS mode">
        <Select value={tlsMode} onChange={(e) => setTlsMode(e.target.value as SmtpSettingsView["tls_mode"])}>
          <option value="starttls">STARTTLS (port 587)</option>
          <option value="ssl">SSL / implicit TLS (port 465)</option>
          <option value="none">None (plain, not recommended)</option>
        </Select>
      </Field>
      <Field label="From address" required={enabled}>
        <Input
          type="email"
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          placeholder="noreply@example.com"
          autoComplete="off"
        />
      </Field>
      <Field label="From name">
        <Input value={fromName} onChange={(e) => setFromName(e.target.value)} autoComplete="off" />
      </Field>
      {mutation.isError ? (
        <Alert variant="danger">
          {(mutation.error as ApiClientError)?.message ?? "Could not save SMTP settings."}
        </Alert>
      ) : null}
      {testResult ? (
        <Alert variant={testResult.ok ? "success" : "danger"}>{testResult.message}</Alert>
      ) : null}
      <div className="sm-form-actions">
        <Button type="submit" variant="accent" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save SMTP settings"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={testPending || !smtp.enabled}
          onClick={() => void sendTest()}
        >
          {testPending ? "Sending…" : "Send test email"}
        </Button>
      </div>
    </form>
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
  const config = query.data;
  const refetch = () => void query.refetch();
  return (
    <div className="sm-page">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Authentication" }]}
        title="Authentication"
        help="OAuth providers shown on the sign-in page, the two-factor policy, and the SMTP settings used for password resets, invitations and 2FA recovery."
      />
      <h2 className="sm-section-title">OAuth providers</h2>
      <div className="sm-grid-2">
        {config.oauth.map((p) => (
          <OAuthProviderCard key={p.provider} provider={p} onSaved={refetch} />
        ))}
      </div>
      <h2 className="sm-section-title">Two-factor authentication policy</h2>
      <p className="sm-muted">
        Default is off. <strong>Required</strong> forces staff with that role to set up two-factor
        authentication at sign-in before they can use the admin.
      </p>
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
      <h2 className="sm-section-title">Email (SMTP)</h2>
      <div className="sm-card">
        <SmtpForm smtp={config.smtp} onSaved={refetch} />
      </div>
    </div>
  );
}
