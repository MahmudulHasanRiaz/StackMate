/**
 * Email verification requests (OD-06) — the route-facing helper over
 * Better Auth's BUILT-IN emailVerification flow.
 *
 * Verified against better-auth 1.7.23
 * (dist/api/routes/email-verification.mjs):
 *  - The verification token is a STATELESS JWT signed with
 *    BETTER_AUTH_SECRET (payload { email, userId }, 1h expiry) —
 *    NOT a `verifications`-table row. `auth.api.sendVerificationEmail`
 *    mints the JWT and hands the full verify URL
 *    (`{baseURL}/verify-email?token=...&callbackURL=...`) to the
 *    `sendVerificationEmail` callback configured in
 *    modules/identity/better-auth.ts, which sends it via the existing
 *    SMTP service. No row is created, so there is nothing to clean
 *    up; a resend simply mints a fresh JWT and the old one lapses.
 *    (The brief's note that "Better Auth creates the verifications
 *    row when sendVerificationEmail is called" is WRONG for 1.7.23 —
 *    email-verification.mjs never touches the verifications table;
 *    it only reads/updates the `users` row.)
 *  - GET /api/auth/verify-email?token=... flips users.emailVerified
 *    to true and redirects to the callbackURL on success.
 *
 * Honesty rule (same as sendStackMateEmail): this helper returns
 * `{ sent, error? }` and NEVER throws for a delivery failure, and
 * NEVER reports success when nothing was sent. Better Auth's own
 * POST /send-verification-email endpoint deliberately answers
 * `{ status: true }` for unknown / already-verified addresses
 * (anti-enumeration, with a 500ms floor) — this helper does its own
 * pre-checks instead and reports honestly. The ROUTE decides what
 * the HTTP caller sees (Worker 2 should keep the outward answer
 * generic), so no account existence leaks through this return value.
 *
 * SMTP is checked FIRST (isSmtpConfigured, the same gate the
 * forgot-password flow uses): when SMTP is not configured no token
 * is minted and nothing is sent.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../../../db/schema/index.ts";
import { users as baUsers } from "../../../../../db/schema/auth.ts";
import type { StackMateBindings } from "../../env.ts";
import { isSmtpConfigured } from "../email/service.ts";
import type { createBetterAuth } from "./better-auth.ts";

/** A real Better Auth instance (see modules/identity/better-auth.ts). */
export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

type Db = NodePgDatabase<typeof schema>;

export interface VerificationEmailResult {
  sent: boolean;
  error?: string;
}

/**
 * Where a verified user lands: the SPA sign-in screen, which reads
 * `?verified=1` (Worker 3 owns that side). The flag must be part of
 * the callbackURL itself — Better Auth redirects to the callbackURL
 * verbatim on success, adding nothing.
 */
export function buildVerificationCallbackUrl(env: Pick<StackMateBindings, "APP_URL">): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/?verified=1`;
}

/**
 * Mint a verification token for `email` and send the verification
 * link via the configured SMTP service. Only an existing,
 * still-unverified staff user receives an email.
 */
export async function requestVerificationEmail(input: {
  db: Db;
  env: StackMateBindings;
  auth: BetterAuthInstance;
  email: string;
}): Promise<VerificationEmailResult> {
  const { db, env, auth } = input;
  const email = input.email.trim().toLowerCase();
  if (!email) {
    return { sent: false, error: "Email is required." };
  }

  // 1. SMTP first: when it is not configured no token is minted and
  //    nothing is sent (same gate as the forgot-password flow).
  const smtpReady = await isSmtpConfigured(db, {
    encryptionKey: env.ENCRYPTION_KEY_V1,
    keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
  }).catch(() => false);
  if (!smtpReady) {
    return {
      sent: false,
      error: "Email is not configured. Set up SMTP in Settings → Email.",
    };
  }

  // 2. Only an existing, still-unverified user gets an email. (The
  //    users row is the single source of truth — the staff record in
  //    store.state and the Better Auth user are the SAME row.)
  let userRow: { emailVerified: boolean } | undefined;
  try {
    const rows = await db
      .select({ emailVerified: baUsers.emailVerified })
      .from(baUsers)
      .where(eq(baUsers.email, email))
      .limit(1);
    userRow = rows[0];
  } catch {
    return { sent: false, error: "Email could not be sent." };
  }
  if (!userRow) {
    return { sent: false, error: "No unverified account exists for that email." };
  }
  if (userRow.emailVerified) {
    return { sent: false, error: "Email is already verified." };
  }

  // 3. Mint the JWT + send. The sendVerificationEmail callback in
  //    createBetterAuth THROWS on SMTP failure (by design — otherwise
  //    a failed send would still answer { status: true }); that throw
  //    is caught here and reported honestly, never re-thrown. With no
  //    `asResponse`/`request` on the call, dispatch returns the parsed
  //    { status: true } on success and throws APIError on failure
  //    (dist/api/dispatch.mjs).
  try {
    const sendVerificationEmail = auth.api.sendVerificationEmail as unknown as (opts: {
      body: { email: string; callbackURL: string };
      headers: Headers;
    }) => Promise<{ status?: boolean }>;
    await sendVerificationEmail({
      body: { email, callbackURL: buildVerificationCallbackUrl(env) },
      headers: new Headers(),
    });
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message : "Email could not be sent.",
    };
  }
}
