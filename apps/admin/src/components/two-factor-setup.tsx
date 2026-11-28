/**
 * Two-factor (TOTP) setup + disable (Auth + Email batch, ADR-0008).
 *
 * Flow (Better Auth twoFactor plugin, endpoints under /api/auth):
 *   1. POST /two-factor/enable { password } → { totpURI, backupCodes }
 *      — the plugin returns the RAW body (no app `{ data }` envelope),
 *      so every call here uses `rawApiRequest`, never `apiRequest`
 *      (which unwraps `.data` and would return undefined — the enable
 *      call broke on exactly that until the headless audit caught it).
 *   2. Show the QR code (qrcode-generator, SVG) + the secret for manual
 *      entry, then verify one code:
 *      POST /two-factor/verify-totp { code } → 2FA is on.
 *   3. Backup codes (from step 1) are shown ONCE, after verification —
 *      the server stores them encrypted and never returns them again.
 *   Disable: POST /two-factor/disable { password }.
 *
 * Used in two places: the Profile dialog (optional setup) and the
 * forced-setup wizard (required by policy — `forced` hides the close
 * path and the caller reloads the principal on done).
 */
import { useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { rawApiRequest, ApiClientError } from "../lib/api-client";
import { useIdempotencyKey } from "../lib/section-kit";
import { Alert, Button, Field, Input } from "./primitives";

function qrSvg(totpUri: string): string {
  const qr = qrcode(0, "M");
  qr.addData(totpUri);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0 });
}

function secretFromUri(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function TwoFactorSetup({
  forced,
  onDone,
  onCancel,
}: {
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<"password" | "verify" | "backup">("password");
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [savedCodes, setSavedCodes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const svg = useMemo(() => (totpUri ? qrSvg(totpUri) : ""), [totpUri]);
  const secret = useMemo(() => secretFromUri(totpUri), [totpUri]);

  // A-04: one key per setup instance — a retried enable replays the
  // same TOTP secret + backup codes instead of generating new ones
  // the user never sees.
  const enableKey = useIdempotencyKey();
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await rawApiRequest<{ totpURI: string; backupCodes: string[] }>(
        "/api/auth/two-factor/enable",
        { method: "POST", body: JSON.stringify({ password }), idempotencyKey: enableKey }
      );
      setTotpUri(res.totpURI);
      setBackupCodes(res.backupCodes ?? []);
      setStep("verify");
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not start two-factor setup."
      );
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await rawApiRequest("/api/auth/two-factor/verify-totp", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setStep("backup");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "backup") {
    return (
      <div className="sm-stack">
        <Alert variant="success" role="status">
          Two-factor authentication is on.
        </Alert>
        <p className="sm-hint" style={{ margin: 0 }}>
          Save these backup codes somewhere safe — each works once if you lose your
          authenticator. They are shown only here, never again.
        </p>
        <ul className="sm-backup-codes">
          {backupCodes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <label className="sm-check-label">
          <input
            type="checkbox"
            className="sm-checkbox"
            checked={savedCodes}
            onChange={(e) => setSavedCodes(e.target.checked)}
          />
          I saved my backup codes
        </label>
        <Button variant="accent" disabled={!savedCodes} onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div className="sm-stack">
        {forced ? (
          <Alert variant="warning">
            Two-factor authentication is required for your role. Set it up to continue.
          </Alert>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <p className="sm-hint" style={{ margin: 0 }}>
          Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password),
          then enter the 6-digit code it shows.
        </p>
        {svg ? (
          <div
            className="sm-qr"
            role="img"
            aria-label="QR code for the authenticator app"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : null}
        {secret ? (
          <p className="sm-hint" style={{ margin: 0 }}>
            Can&apos;t scan? Enter this secret manually: <code>{secret}</code>
          </p>
        ) : null}
        <form onSubmit={verify} className="sm-stack">
          <Field label="Authenticator code" required htmlFor="sm-2fa-code">
            <Input
              id="sm-2fa-code"
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button variant="accent" type="submit" loading={busy}>
            Verify and turn on
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={enable} className="sm-stack">
      {forced ? (
        <Alert variant="warning">
          Two-factor authentication is required for your role. Set it up to continue.
        </Alert>
      ) : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}
      <p className="sm-hint" style={{ margin: 0 }}>
        Two-factor authentication adds a 6-digit code from your authenticator app to sign-in.
        Enter your current password to start setup.
      </p>
      <Field label="Current password" required htmlFor="sm-2fa-password">
        <Input
          id="sm-2fa-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button variant="accent" type="submit" loading={busy}>
        Continue
      </Button>
      {!forced && onCancel ? (
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

export function TwoFactorDisable({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A-04: one key per dialog instance — a retried disable replays.
  const disableKey = useIdempotencyKey();
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await rawApiRequest("/api/auth/two-factor/disable", {
        method: "POST",
        body: JSON.stringify({ password }),
        idempotencyKey: disableKey,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not turn off two-factor.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={disable} className="sm-stack">
      {error ? <Alert variant="danger">{error}</Alert> : null}
      <p className="sm-hint" style={{ margin: 0 }}>
        Turning off two-factor authentication removes the authenticator requirement from your
        account. Enter your current password to confirm.
      </p>
      <Field label="Current password" required htmlFor="sm-2fa-disable-password">
        <Input
          id="sm-2fa-disable-password"
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
      <Button variant="secondary" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
