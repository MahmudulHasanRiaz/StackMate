/**
 * Public pages (Auth + Email batch, ADR-0008) — no session required.
 *
 * These render OUTSIDE the principal gate: RootComponent checks
 * window.location.pathname first and renders the matching page
 * instead of the AuthScreen / app shell (see router.tsx).
 *
 *   /reset-password?token=…       — forgot-password reset form
 *   /accept-invitation?token=…    — invitation acceptance (name + password)
 *   /two-factor-recovery?token=…  — 2FA recovery: email form when no
 *                                    token, password confirm when one
 *                                    is present
 *
 * The token is the credential here, so an invalid/expired token is a
 * plain 422 with the message — nothing to enumerate.
 */
import { useState, type FormEvent } from "react";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { Alert, Button, Field, Input } from "./primitives";

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function PublicShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="sm-auth">
      <section className="sm-auth-card" aria-labelledby="public-heading">
        <h1 id="public-heading" className="sm-page-title">
          {title}
        </h1>
        {children}
        <p style={{ marginTop: 16 }}>
          <a href="/">Back to sign-in</a>
        </p>
      </section>
    </main>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(tokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setFieldError("Password must be at least 10 characters.");
      return;
    }
    if (password !== confirm) {
      setFieldError("Passwords do not match.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      await apiRequest("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: password }),
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "Could not reset the password."));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <PublicShell title="Reset password">
        <Alert variant="danger">
          This reset link is missing its token. Use the link from the reset email.
        </Alert>
      </PublicShell>
    );
  }
  return (
    <PublicShell title="Reset password">
      {done ? (
        <Alert variant="success" role="status">
          Your password was reset. Sign in with the new password.
        </Alert>
      ) : (
        <form className="sm-auth-form" onSubmit={submit}>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field label="New password" required error={fieldError} htmlFor="sm-reset-password">
            <Input
              id="sm-reset-password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password" required htmlFor="sm-reset-confirm">
            <Input
              id="sm-reset-confirm"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <Button variant="accent" type="submit" loading={busy}>
            Reset password
          </Button>
        </form>
      )}
    </PublicShell>
  );
}

export function AcceptInvitationPage() {
  const [token] = useState(tokenFromUrl);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 1) {
      setFieldError("Name is required.");
      return;
    }
    if (password.length < 10) {
      setFieldError("Password must be at least 10 characters.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      await apiRequest("/api/auth/accept-invitation", {
        method: "POST",
        body: JSON.stringify({ token, name: name.trim(), password }),
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "Could not accept the invitation."));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <PublicShell title="Accept invitation">
        <Alert variant="danger">
          This invitation link is missing its token. Use the link from the invitation email.
        </Alert>
      </PublicShell>
    );
  }
  return (
    <PublicShell title="Accept invitation">
      {done ? (
        <Alert variant="success" role="status">
          Invitation accepted. Sign in with your new account.
        </Alert>
      ) : (
        <form className="sm-auth-form" onSubmit={submit}>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field label="Name" required htmlFor="sm-invite-name">
            <Input
              id="sm-invite-name"
              type="text"
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Password"
            required
            error={fieldError}
            hint="At least 10 characters"
            htmlFor="sm-invite-password"
          >
            <Input
              id="sm-invite-password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button variant="accent" type="submit" loading={busy}>
            Accept invitation
          </Button>
        </form>
      )}
    </PublicShell>
  );
}

export function TwoFactorRecoveryPage() {
  const [token] = useState(tokenFromUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);

  const requestLink = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiRequest("/api/auth/two-factor/recover", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, "Could not send the recovery link."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiRequest("/api/auth/two-factor/recover/confirm", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "Could not recover two-factor authentication."));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <PublicShell title="Recover two-factor authentication">
        {sent ? (
          <Alert variant="success" role="status">
            If 2FA is enabled for that email, a recovery link has been sent. Check your inbox.
          </Alert>
        ) : (
          <form className="sm-auth-form" onSubmit={requestLink}>
            {error ? <Alert variant="danger">{error}</Alert> : null}
            <p className="sm-hint" style={{ margin: 0 }}>
              Lost your authenticator device? We will email you a recovery link. You will still
              need your password — this only turns off two-factor authentication, it does not
              change your password.
            </p>
            <Field label="Email" required htmlFor="sm-recovery-email">
              <Input
                id="sm-recovery-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button variant="accent" type="submit" loading={busy}>
              Send recovery link
            </Button>
          </form>
        )}
      </PublicShell>
    );
  }
  return (
    <PublicShell title="Recover two-factor authentication">
      {done ? (
        <Alert variant="success" role="status">
          Two-factor authentication is off for your account. Sign in with your password, then set
          up two-factor again from your profile.
        </Alert>
      ) : (
        <form className="sm-auth-form" onSubmit={confirm}>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <p className="sm-hint" style={{ margin: 0 }}>
            Enter your password to turn off two-factor authentication for your account.
          </p>
          <Field label="Password" required htmlFor="sm-recovery-password">
            <Input
              id="sm-recovery-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button variant="accent" type="submit" loading={busy}>
            Turn off two-factor
          </Button>
        </form>
      )}
    </PublicShell>
  );
}
