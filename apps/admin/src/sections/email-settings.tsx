/**
 * Email (SMTP) settings — Settings area.
 *
 * Route (registered in router.tsx, under the Settings shell):
 *   /settings/email
 *
 * Moved here from Settings → Authentication (SMTP timeout fix batch,
 * 2026-11-16, owner order: "SMTP Configuration alada menu howa uchit
 * na? Authentication er vitorei kno?"). SMTP is email delivery
 * (password resets, invitations, 2FA recovery, notifications), not
 * authentication — it gets its own Settings menu item. API paths are
 * UNCHANGED (same /api/v1/admin/auth-config endpoints); only the
 * page moved. Settings → Authentication keeps OAuth + 2FA policy.
 *
 * Endpoints used (all `users.manage`):
 *   GET  /api/v1/admin/auth-config
 *   PUT  /api/v1/admin/auth-config/smtp
 *   POST /api/v1/admin/auth-config/smtp/test
 *
 * The SMTP password is write-only (encrypted at rest, never returned).
 * "Send test email" sends a real test mail to the admin's own address
 * and reports the honest result — success or the real error, never a
 * fake success. When SMTP is not configured the page says so plainly.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { PageHeader, useAdminMutation } from "../lib/section-kit";
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
  smtp: SmtpSettingsView;
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

export function EmailSettingsSection() {
  const query = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => apiRequest<AuthConfig>("/api/v1/admin/auth-config"),
  });
  if (query.isPending) return <TableSkeleton rows={5} />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        message={`Could not load email settings. ${(query.error as ApiClientError)?.message ?? "Try again."}`}
        onRetry={() => void query.refetch()}
      />
    );
  }
  // Defensive normalization (same pattern as the Authentication page):
  // the endpoint always returns the full view, but the page must never
  // crash on a partial shape.
  const smtp: SmtpSettingsView = query.data.smtp ?? {
    host: "",
    port: 587,
    username: "",
    has_password: false,
    tls_mode: "starttls",
    from_address: "",
    from_name: "StackMate",
    enabled: false,
    updated_at: null,
  };
  const refetch = () => void query.refetch();
  return (
    <div className="sm-page">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Email" }]}
        title="Email"
        help="Provider-agnostic SMTP settings used for password resets, invitations and 2FA recovery. The test email goes only to your own address."
      />
      <div className="sm-card">
        <SmtpForm smtp={smtp} onSaved={refetch} />
      </div>
    </div>
  );
}
