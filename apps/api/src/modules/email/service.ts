/**
 * Email sending service (Auth + Email batch, ADR-0008).
 *
 * Provider-agnostic SMTP from the admin panel: settings are loaded from
 * the DB (see modules/auth-config/service.ts), the message goes out over
 * the minimal SMTP client (modules/email/smtp-client.ts) on
 * `cloudflare:sockets`. The `connect` implementation is injectable so
 * tests can use a mocked socket; production dynamically imports
 * `cloudflare:sockets` (never a static top-level import — vitest runs
 * in Node, where the module does not resolve).
 *
 * Honesty rule: `sendStackMateEmail` returns `{ sent, error? }` and
 * NEVER throws for a delivery failure, and NEVER reports success when
 * nothing was sent. Callers surface `error` verbatim (it contains no
 * credentials — see smtp-client.ts). When SMTP is not configured the
 * result is `{ sent: false, error: "Email is not configured…" }`.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import {
  loadSmtpSettings,
  type AuthConfigDeps,
  type ResolvedSmtpSettings,
} from "../auth-config/service.ts";
import {
  sendMailViaSmtp,
  SmtpError,
  type SmtpConnectFn,
  type SmtpMessage,
} from "./smtp-client.ts";

type Db = NodePgDatabase<typeof schema>;

export interface EmailDeps extends AuthConfigDeps {
  appUrl: string;
  /** Injected for tests; production uses the real `cloudflare:sockets` connect. */
  connectImpl?: SmtpConnectFn;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

const NOT_CONFIGURED = "Email is not configured. Set up SMTP in Settings → Email.";

async function resolveConnect(deps: EmailDeps): Promise<SmtpConnectFn> {
  if (deps.connectImpl) return deps.connectImpl;
  const mod = await import("cloudflare:sockets");
  return mod.connect as unknown as SmtpConnectFn;
}

function smtpConfigured(smtp: ResolvedSmtpSettings): boolean {
  return Boolean(smtp.enabled && smtp.host && smtp.from_address);
}

/**
 * Whether email can be sent at all (Auth + Email fix batch): SMTP
 * enabled with a host and a from address. Endpoints that mint a
 * token only to email it (forgot password, 2FA recovery) check this
 * FIRST and skip token creation when it is false — an undeliverable
 * token row is never created. The response stays the generic 200
 * either way, so nothing about the account is revealed.
 */
export async function isSmtpConfigured(db: Db, deps: AuthConfigDeps): Promise<boolean> {
  const smtp = await loadSmtpSettings(db, deps).catch(() => null);
  return smtp !== null && smtpConfigured(smtp);
}

export async function sendStackMateEmail(
  db: Db,
  deps: EmailDeps,
  message: Omit<SmtpMessage, "from" | "fromName">,
  /**
   * B-15: preloaded SMTP config (e.g. loaded ONCE by the cron handler
   * before the sweep loop). When given, `loadSmtpSettings` is skipped
   * — a 25-reminder sweep used to re-read + re-decrypt the SMTP row
   * per reminder. Additive: existing callers pass nothing and behave
   * exactly as before.
   */
  preloadedSmtp?: ResolvedSmtpSettings
): Promise<SendResult> {
  const smtp = preloadedSmtp ?? (await loadSmtpSettings(db, deps));
  if (!smtpConfigured(smtp)) {
    return { sent: false, error: NOT_CONFIGURED };
  }
  if (!smtp.password && smtp.username) {
    return { sent: false, error: "SMTP password is not configured." };
  }
  let connectImpl: SmtpConnectFn;
  try {
    connectImpl = await resolveConnect(deps);
  } catch {
    return { sent: false, error: "Email transport is unavailable in this environment." };
  }
  try {
    await sendMailViaSmtp(
      {
        host: smtp.host,
        port: smtp.port,
        username: smtp.username,
        password: smtp.password ?? "",
        tlsMode: smtp.tls_mode,
      },
      { ...message, from: smtp.from_address, fromName: smtp.from_name },
      connectImpl
    );
    return { sent: true };
  } catch (err) {
    if (err instanceof SmtpError) return { sent: false, error: err.message };
    return { sent: false, error: "Email could not be sent." };
  }
}

export interface BoundedEmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface BoundedEmailResult {
  message: BoundedEmailMessage;
  result: SendResult;
}

/**
 * B-15: send a batch of emails with bounded concurrency (default 4).
 * Each message resolves to its own SendResult — one failure never
 * aborts the rest, and the caller marks only the sent ones (sweep
 * reminders are retried on the next run when not marked). The SMTP
 * config is loaded ONCE here (or taken from `preloadedSmtp`)
 * instead of once per message.
 */
export async function sendEmailsBounded(
  db: Db,
  deps: EmailDeps,
  messages: BoundedEmailMessage[],
  options?: { concurrency?: number; preloadedSmtp?: ResolvedSmtpSettings }
): Promise<BoundedEmailResult[]> {
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 10));
  const smtp = options?.preloadedSmtp ?? (await loadSmtpSettings(db, deps));
  const results: BoundedEmailResult[] = new Array(messages.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, messages.length) },
    async () => {
      while (next < messages.length) {
        const idx = next;
        next += 1;
        const message = messages[idx]!;
        results[idx] = {
          message,
          result: await sendStackMateEmail(
            db,
            deps,
            { to: message.to, subject: message.subject, text: message.text },
            smtp
          ),
        };
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export function buildPasswordResetEmail(
  appUrl: string,
  token: string
): { subject: string; text: string; html: string } {
  const url = `${appUrl.replace(/\/+$/, "")}/reset-password?token=${token}`;
  return {
    subject: "Reset your StackMate password",
    text: [
      "You asked to reset your StackMate staff password.",
      "",
      `Reset it here (valid for 1 hour, single use): ${url}`,
      "",
      "If you did not ask for this, ignore this email — your password stays unchanged.",
    ].join("\n"),
    html: [
      "<p>You asked to reset your StackMate staff password.</p>",
      `<p><a href="${url}">Reset your password</a> (valid for 1 hour, single use).</p>`,
      "<p>If you did not ask for this, ignore this email — your password stays unchanged.</p>",
    ].join("\n"),
  };
}

export function buildInvitationEmail(
  appUrl: string,
  token: string,
  roles: string[]
): { subject: string; text: string; html: string } {
  const url = `${appUrl.replace(/\/+$/, "")}/accept-invitation?token=${token}`;
  const roleText = roles.length > 0 ? ` (roles: ${roles.join(", ")})` : "";
  return {
    subject: "You are invited to StackMate",
    text: [
      `You have been invited to join StackMate as a staff member${roleText}.`,
      "",
      `Accept the invitation here (valid for 7 days): ${url}`,
      "",
      "If you were not expecting this, ignore this email.",
    ].join("\n"),
    html: [
      `<p>You have been invited to join StackMate as a staff member${roleText}.</p>`,
      `<p><a href="${url}">Accept the invitation</a> (valid for 7 days).</p>`,
      "<p>If you were not expecting this, ignore this email.</p>",
    ].join("\n"),
  };
}

export function buildTwoFactorRecoveryEmail(
  appUrl: string,
  token: string
): { subject: string; text: string; html: string } {
  const url = `${appUrl.replace(/\/+$/, "")}/two-factor-recovery?token=${token}`;
  return {
    subject: "Recover your StackMate two-factor authentication",
    text: [
      "You asked to recover access to your StackMate account because you lost your authenticator device.",
      "",
      `Continue here (valid for 1 hour, single use): ${url}`,
      "You will need to enter your password. This only disables two-factor authentication — it does not change your password.",
      "",
      "If you did not ask for this, ignore this email — your two-factor authentication stays on.",
    ].join("\n"),
    html: [
      "<p>You asked to recover access to your StackMate account because you lost your authenticator device.</p>",
      `<p><a href="${url}">Recover two-factor authentication</a> (valid for 1 hour, single use).</p>`,
      "<p>You will need to enter your password. This only disables two-factor authentication — it does not change your password.</p>",
      "<p>If you did not ask for this, ignore this email — your two-factor authentication stays on.</p>",
    ].join("\n"),
  };
}

export function buildTestEmail(): { subject: string; text: string; html: string } {
  return {
    subject: "StackMate test email",
    text: "This is a test email from StackMate. Your SMTP settings work.",
    html: "<p>This is a test email from StackMate. Your SMTP settings work.</p>",
  };
}
