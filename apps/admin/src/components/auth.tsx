/**
 * Auth screens (design spec §4.4).
 *
 * Sign-in and first-admin setup. Rules enforced here:
 *  - A failed attempt ALWAYS shows the actual error (Alert, role="alert")
 *    — never fails silently (the browser test's silent first click).
 *  - The submit button is disabled + shows a spinner while the request
 *    is in flight.
 *  - The setup form appears ONLY when GET /api/v1/setup-status positively
 *    says setup is required; any fetch error fails closed to sign-in.
 *
 * Auth + Email batch (ADR-0008):
 *  - OAuth buttons render ONLY for providers enabled in Settings
 *    (GET /api/v1/auth-config, public, no secrets). A click POSTs to
 *    /api/auth/sign-in/social with redirect: "manual" and navigates
 *    the top-level window to the provider URL Better Auth returns.
 *    After the callback the app reloads and RootComponent loads /me;
 *    a failed OAuth lands back with ?error=… and is shown here.
 *  - Forgot password: public form → POST /api/auth/forgot-password.
 *    When SMTP is configured the response is the same generic message
 *    and the UI repeats it — it never says whether the email exists.
 *    When SMTP is NOT configured (GET /api/v1/auth-config says
 *    email_configured: false) the form says so plainly instead of
 *    the fake "a reset link has been sent" — the configured state is
 *    public, the account's existence never is.
 *  - 2FA: when sign-in returns { two_factor_redirect: true } the
 *    password was right but TOTP is on — the TOTP prompt replaces the
 *    sign-in form (code, or a backup code). Verify calls the Better
 *    Auth two-factor endpoints, then loads /me to finish sign-in.
 */
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest, rawApiRequest, ApiClientError } from "../lib/api-client";
import { useGeneralConfig } from "../lib/general-config";
import { Alert, Button, Field, Input, Skeleton } from "./primitives";
import type { StaffPrincipalDto } from "./shell";

type SetupStatus = "loading" | "required" | "not-required";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function AuthScreen({
  onSignedIn,
}: {
  onSignedIn: (principal: StaffPrincipalDto) => void;
}) {
  // General Settings (Auth + Email batch): the login page shows the
  // configured app name, description tagline, and support contact.
  const { data: generalConfig } = useGeneralConfig();
  const appName = generalConfig?.app_name ?? "StackMate";
  const [setupStatus, setSetupStatus] = useState<SetupStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");

  // Forgot password
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  // Whether password-reset email can be sent at all (Auth + Email fix
  // batch): when SMTP is not configured the forgot form must say so
  // plainly instead of the fake "a reset link has been sent". null =
  // not known yet (config fetch pending/failed) — the form behaves as
  // before, and the endpoint stays generic-200 either way.
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);

  // Two-factor challenge (after a password-correct sign-in)
  const [twoFactorPending, setTwoFactorPending] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ setup_required: boolean }>("/api/v1/setup-status")
      .then((res) => {
        if (!cancelled) setSetupStatus(res.setup_required ? "required" : "not-required");
      })
      .catch(() => {
        if (!cancelled) setSetupStatus("not-required");
      });
    // Public login config: which OAuth providers to show, and whether
    // email is configured. Any failure fails closed to email/password
    // only (emailConfigured stays null — the forgot form keeps its
    // generic behaviour).
    apiRequest<{ oauth_providers: string[]; email_configured?: boolean }>("/api/v1/auth-config")
      .then((res) => {
        if (!cancelled) {
          setOauthProviders(res.oauth_providers ?? []);
          if (typeof res.email_configured === "boolean") {
            setEmailConfigured(res.email_configured);
          }
        }
      })
      .catch(() => {});
    // An OAuth callback failure lands back here with ?error=… — show it
    // once, then clear it from the URL so a refresh does not repeat it.
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    if (oauthError) {
      setError(
        oauthError === "access_denied"
          ? "Sign-in with that account was denied. Use a staff Google or GitHub account."
          : `Sign-in failed: ${oauthError}`,
      );
      params.delete("error");
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.replaceState(null, "", next);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSigningIn(true);
    try {
      const res = await apiRequest<{
        principal: StaffPrincipalDto;
        two_factor_redirect?: boolean;
      }>("/api/auth/sign-in", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (res.two_factor_redirect) {
        setTwoFactorPending(true);
        setTotpCode("");
        return;
      }
      onSignedIn(res.principal);
    } catch (err) {
      setError(errorMessage(err, "Sign-in failed"));
    } finally {
      setSigningIn(false);
    }
  }

  async function handleVerifyTotp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setVerifying(true);
    try {
      const endpoint = useBackupCode
        ? "/api/auth/two-factor/verify-backup-code"
        : "/api/auth/two-factor/verify-totp";
      const body = { code: totpCode };
      await rawApiRequest(endpoint, { method: "POST", body: JSON.stringify(body) });
      // Verify set the session cookie (fetch sends credentials) — load
      // the principal to finish sign-in.
      const me = await apiRequest<StaffPrincipalDto>("/api/v1/admin/me");
      onSignedIn(me);
    } catch (err) {
      setError(errorMessage(err, "Verification failed"));
    } finally {
      setVerifying(false);
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setForgotBusy(true);
    try {
      await apiRequest("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: forgotEmail }),
      });
      setForgotSent(true);
    } catch (err) {
      // The endpoint is generic-200 by design; an error here is a
      // transport failure, not an unknown email — say so plainly.
      setError(errorMessage(err, "Could not send the reset request"));
    } finally {
      setForgotBusy(false);
    }
  }

  async function handleOAuth(provider: string) {
    setError(null);
    setOauthBusy(provider);
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        redirect: "manual",
        body: JSON.stringify({
          provider,
          callbackURL: `${window.location.origin}/`,
        }),
      });
      const location = res.headers.get("Location") ?? res.headers.get("location");
      if (location) {
        window.location.href = location;
        return;
      }
      // Better Auth may answer 200 with the URL in the body instead.
      const data = (await res.json().catch(() => null)) as { url?: string } | null;
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(`Could not start ${PROVIDER_LABELS[provider] ?? provider} sign-in.`);
    } catch (err) {
      setError(errorMessage(err, "Could not start sign-in."));
    } finally {
      setOauthBusy(null);
    }
  }

  async function handleSetup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSettingUp(true);
    try {
      await apiRequest("/api/auth/bootstrap-super-admin", {
        method: "POST",
        body: JSON.stringify({
          name: setupName,
          email: setupEmail,
          password: setupPassword,
          setupToken,
        }),
      });
      setNotice("First admin created. Sign in with the new account.");
      setSetupStatus("not-required");
      setEmail(setupEmail);
      setPassword("");
      setSetupToken("");
    } catch (err) {
      setError(errorMessage(err, "Setup failed"));
    } finally {
      setSettingUp(false);
    }
  }

  return (
    <main className="sm-auth">
      <section className="sm-auth-card" aria-labelledby="auth-heading">
        <h1 id="auth-heading" className="sm-page-title">
          {setupStatus === "required" ? "Set up your first admin" : `${appName} Staff Sign In`}
        </h1>
        {generalConfig?.app_description ? (
          <p className="sm-muted" style={{ margin: "8px 0 0" }}>
            {generalConfig.app_description}
          </p>
        ) : null}
        {notice ? (
          <Alert variant="success" role="status">
            {notice}
          </Alert>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {setupStatus === "loading" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 20 }}>
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={32} width="50%" />
          </div>
        ) : setupStatus === "required" ? (
          <form className="sm-auth-form" onSubmit={handleSetup}>
            <p className="sm-hint" style={{ margin: 0 }}>
              No admin account exists yet. Create the first one — this form
              appears only once. The setup token is the secret set by the
              owner in the Cloudflare dashboard (Worker secret SETUP_TOKEN).
            </p>
            <Field label="Name" required htmlFor="sm-setup-name">
              <Input
                id="sm-setup-name"
                type="text"
                required
                value={setupName}
                onChange={(e) => setSetupName(e.target.value)}
              />
            </Field>
            <Field label="Email" required htmlFor="sm-setup-email">
              <Input
                id="sm-setup-email"
                type="email"
                required
                value={setupEmail}
                onChange={(e) => setSetupEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" required htmlFor="sm-setup-password" hint="At least 10 characters">
              <Input
                id="sm-setup-password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
              />
            </Field>
            <Field label="Setup token" required htmlFor="sm-setup-token">
              <Input
                id="sm-setup-token"
                type="password"
                required
                autoComplete="off"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
              />
            </Field>
            <Button variant="accent" type="submit" loading={settingUp}>
              Create first admin
            </Button>
          </form>
        ) : twoFactorPending ? (
          <form className="sm-auth-form" onSubmit={handleVerifyTotp}>
            <p className="sm-hint" style={{ margin: 0 }}>
              Two-factor authentication is on for this account. Enter the
              6-digit code from your authenticator app
              {useBackupCode ? " or one of your backup codes" : ""}.
            </p>
            <Field
              label={useBackupCode ? "Backup code" : "Authenticator code"}
              required
              htmlFor="sm-totp"
            >
              <Input
                id="sm-totp"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
              />
            </Field>
            <Button variant="accent" type="submit" loading={verifying}>
              Verify
            </Button>
            <button
              type="button"
              className="sm-link-button"
              onClick={() => {
                setUseBackupCode((v) => !v);
                setTotpCode("");
              }}
            >
              {useBackupCode ? "Use an authenticator code instead" : "Use a backup code instead"}
            </button>
            <button
              type="button"
              className="sm-link-button"
              onClick={() => {
                setTwoFactorPending(false);
                setPassword("");
              }}
            >
              Back to sign-in
            </button>
          </form>
        ) : showForgot ? (
          <form className="sm-auth-form" onSubmit={handleForgot}>
            {forgotSent ? (
              <Alert variant="success" role="status">
                If an account exists for that email, a reset link has been sent. Check your inbox.
              </Alert>
            ) : emailConfigured === false ? (
              <>
                <Alert variant="warning" role="status">
                  Email is not configured for this admin yet, so password-reset emails cannot be
                  sent. Contact your administrator to set up SMTP in Settings → Authentication →
                  Email, or to reset your password.
                </Alert>
              </>
            ) : (
              <>
                <Field label="Email" required htmlFor="sm-forgot-email">
                  <Input
                    id="sm-forgot-email"
                    type="email"
                    required
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                  />
                </Field>
                <Button variant="accent" type="submit" loading={forgotBusy}>
                  Send reset link
                </Button>
              </>
            )}
            <button
              type="button"
              className="sm-link-button"
              onClick={() => {
                setShowForgot(false);
                setForgotSent(false);
              }}
            >
              Back to sign-in
            </button>
          </form>
        ) : (
          <form className="sm-auth-form" onSubmit={handleSignIn}>
            {oauthProviders.length > 0 ? (
              <>
                {oauthProviders.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="secondary"
                    loading={oauthBusy === provider}
                    onClick={() => void handleOAuth(provider)}
                  >
                    {PROVIDER_LABELS[provider] ?? `Continue with ${provider}`}
                  </Button>
                ))}
                <div className="sm-auth-divider" aria-hidden="true">
                  <span>or sign in with email</span>
                </div>
              </>
            ) : null}
            <Field label="Email" required htmlFor="sm-email">
              <Input
                id="sm-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" required htmlFor="sm-password">
              <Input
                id="sm-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button variant="accent" type="submit" loading={signingIn}>
              Sign In
            </Button>
            <button
              type="button"
              className="sm-link-button"
              onClick={() => {
                setShowForgot(true);
                setForgotEmail(email);
              }}
            >
              Forgot password?
            </button>
            {generalConfig?.support_email ? (
              <p className="sm-muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
                Can&apos;t sign in? Contact{" "}
                <a href={`mailto:${generalConfig.support_email}`}>{generalConfig.support_email}</a>.
              </p>
            ) : null}
          </form>
        )}
      </section>
    </main>
  );
}
