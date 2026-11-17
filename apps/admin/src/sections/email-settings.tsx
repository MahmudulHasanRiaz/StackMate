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
import { useEffect, useState, type FormEvent } from "react";
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
      <div className="sm-card" style={{ marginTop: 16 }}>
        <RemindersForm />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payment reminders (ADR-0009) — Settings → Email                     */
/* Offsets are days before a due date (installment due / renewal);     */
/* overdue offsets are days after a missed due date. Each reminder     */
/* is sent once per (installment/subscription, offset) by the cron     */
/* sweep; editing the offsets here takes effect on the next run.       */
/* ------------------------------------------------------------------ */
interface ReminderSettingsView {
  due_offsets_days: number[];
  overdue_offsets_days: number[];
  overdue_enabled: boolean;
  updated_at: string | null;
}

function parseOffsets(value: string): number[] | null {
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 90)) return null;
  return [...new Set(nums)].sort((a, b) => b - a);
}

function RemindersForm() {
  const query = useQuery({
    queryKey: ["reminder-settings"],
    queryFn: () =>
      apiRequest<ReminderSettingsView>("/api/v1/admin/reminder-settings"),
  });
  const [dueOffsets, setDueOffsets] = useState("7,1");
  const [overdueOffsets, setOverdueOffsets] = useState("1,3");
  const [overdueEnabled, setOverdueEnabled] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (query.data && !loaded) {
      setDueOffsets(query.data.due_offsets_days.join(","));
      setOverdueOffsets(query.data.overdue_offsets_days.join(","));
      setOverdueEnabled(query.data.overdue_enabled);
      setLoaded(true);
    }
  }, [query.data, loaded]);
  const mutation = useAdminMutation<ReminderSettingsView, void>({
    mutationFn: () =>
      apiRequest<ReminderSettingsView>("/api/v1/admin/reminder-settings", {
        method: "PUT",
        body: JSON.stringify({
          due_offsets_days: parseOffsets(dueOffsets) ?? [],
          overdue_offsets_days: parseOffsets(overdueOffsets) ?? [],
          overdue_enabled: overdueEnabled,
        }),
      }),
    invalidateKeys: [["reminder-settings"]],
    successTitle: "Reminder settings saved",
    onSuccess: () => setLoaded(false),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (parseOffsets(dueOffsets) === null)
      next.due_offsets_days = "Enter days before due, comma-separated (0–90), e.g. 7,1.";
    if (parseOffsets(overdueOffsets) === null)
      next.overdue_offsets_days = "Enter days after due, comma-separated (0–90), e.g. 1,3.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    mutation.mutate();
  };
  if (query.isPending) return <TableSkeleton rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        message={`Could not load reminder settings. ${(query.error as ApiClientError)?.message ?? "Try again."}`}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <form onSubmit={onSubmit} aria-label="Payment reminder settings">
      <h2 className="sm-card-title">Payment reminders</h2>
      <p className="sm-hint">
        Reminder emails go to the customer&apos;s email address. Due reminders
        fire before an installment due date or a subscription renewal;
        overdue reminders fire after a missed due date. Each reminder is
        sent once per due item and offset.
      </p>
      <Field
        label="Days before due"
        hint="Comma-separated days, e.g. 7,1 sends a reminder 7 days and 1 day before the due date."
        error={errors.due_offsets_days ?? ""}
      >
        <Input
          value={dueOffsets}
          onChange={(e) => setDueOffsets(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={Boolean(errors.due_offsets_days) || undefined}
        />
      </Field>
      <Switch
        label="Overdue reminders"
        checked={overdueEnabled}
        onChange={(e) => setOverdueEnabled(e.target.checked)}
      />
      <Field
        label="Days after due (overdue)"
        hint="Comma-separated days after a missed due date, e.g. 1,3."
        error={errors.overdue_offsets_days ?? ""}
      >
        <Input
          value={overdueOffsets}
          onChange={(e) => setOverdueOffsets(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          disabled={!overdueEnabled}
          aria-invalid={Boolean(errors.overdue_offsets_days) || undefined}
        />
      </Field>
      {mutation.isError ? (
        <Alert variant="danger">
          {(mutation.error as ApiClientError)?.message ?? "Could not save reminder settings."}
        </Alert>
      ) : null}
      <div className="sm-form-actions">
        <Button type="submit" variant="accent" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save reminder settings"}
        </Button>
      </div>
    </form>
  );
}
