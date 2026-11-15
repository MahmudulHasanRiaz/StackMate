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
 */
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { Alert, Button, Field, Input, Skeleton } from "./primitives";
import type { StaffPrincipalDto } from "./shell";

type SetupStatus = "loading" | "required" | "not-required";

export function AuthScreen({
  onSignedIn,
}: {
  onSignedIn: (principal: StaffPrincipalDto) => void;
}) {
  const [setupStatus, setSetupStatus] = useState<SetupStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ setup_required: boolean }>("/api/v1/setup-status")
      .then((res) => {
        if (!cancelled) setSetupStatus(res.setup_required ? "required" : "not-required");
      })
      .catch(() => {
        if (!cancelled) setSetupStatus("not-required");
      });
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
      const res = await apiRequest<{ principal: StaffPrincipalDto }>("/api/auth/sign-in", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onSignedIn(res.principal);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Sign-in failed",
      );
    } finally {
      setSigningIn(false);
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
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Setup failed",
      );
    } finally {
      setSettingUp(false);
    }
  }

  return (
    <main className="sm-auth">
      <section className="sm-auth-card" aria-labelledby="auth-heading">
        <h1 id="auth-heading" className="sm-page-title">
          {setupStatus === "required" ? "Set up your first admin" : "StackMate Staff Sign In"}
        </h1>
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
            <Button variant="primary" type="submit" loading={settingUp}>
              Create first admin
            </Button>
          </form>
        ) : (
          <form className="sm-auth-form" onSubmit={handleSignIn}>
            <Field label="Email" required htmlFor="sm-email">
              <Input
                id="sm-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" required htmlFor="sm-password">
              <Input
                id="sm-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button variant="primary" type="submit" loading={signingIn}>
              Sign In
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
