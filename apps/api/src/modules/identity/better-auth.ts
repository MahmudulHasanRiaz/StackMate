/**
 * Better Auth + Drizzle ORM + Cloudflare Hyperdrive configuration (ADR-0005, ADR-0006, ADR-0008).
 *
 * `createBetterAuth()` builds a REAL Better Auth instance (betterAuth() is
 * actually called) backed by the Drizzle adapter over PostgreSQL, using the
 * request-scoped cache-disabled Hyperdrive connection (`HYPERDRIVE_NO_CACHE`),
 * `usePlural: true` (matching `users`, `sessions`, `accounts`, `verifications`),
 * `cf-connecting-ip` for rate limiting on Cloudflare Workers, and `HttpOnly` +
 * `Secure` (staging/production only) + `SameSite=Lax` cookies.
 *
 * DB-DRIVEN AUTH (Auth + Email batch, 2026-11-16, ADR-0008): OAuth providers
 * and the two-factor plugin are configured from the database, not from
 * env. `createBetterAuth` takes the resolved config (loaded by
 * `loadAuthConfig`, 30s cache — see modules/auth-config/service.ts):
 * only providers enabled in Settings are registered, so the login page
 * shows exactly those. The two-factor plugin is always registered
 * (TOTP + encrypted backup codes); whether a user MUST set it up is a
 * per-role policy enforced by the identity service, not by the plugin.
 *
 * SECURITY — databaseHooks (verified against better-auth 1.7.23
 * `init-options.d.mts`; returning false blocks the creation):
 *  - `user.create.before` ALWAYS returns false. Better Auth never
 *    creates users in StackMate: every staff user is provisioned by
 *    bootstrap / an administrator / invitation acceptance, and OAuth
 *    LINKS to the existing row (by email — staff rows already carry
 *    `email_verified = true`, which the linking rules require). A
 *    non-staff Google/GitHub login therefore can never mint a user.
 *  - `session.create.before` returns false when the user's staff record
 *    is suspended. This is the OAuth equivalent of the suspension check
 *    in `signInStaffSession` (the credential path); without it a
 *    suspended staff member could mint a session through the OAuth
 *    callback. A missing staff_profiles row reads as active — the same
 *    rule the DrizzleStore uses (`asEnum(..., "active")`).
 *
 * `buildBetterAuthWorkerConfig()` below is CONFIG-ONLY: it returns the plain
 * settings object (kept for callers that need the values) and never creates
 * an auth instance. Use `createBetterAuth()` to get a working handler.
 *
 * Schema check (better-auth 1.7.23, verified against
 * node_modules/better-auth/dist + @better-auth/drizzle-adapter typings and
 * db/schema/auth.ts + db/migrations/0000): the four auth tables carry exactly
 * the columns the Drizzle adapter expects (users: id/name/email/emailVerified/
 * image/createdAt/updatedAt; sessions: id/expiresAt/token/createdAt/updatedAt/
 * ipAddress/userAgent/userId; accounts: id/accountId/providerId/userId/
 * accessToken/refreshToken/idToken/accessTokenExpiresAt/refreshTokenExpiresAt/
 * scope/password/createdAt/updatedAt; verifications: id/identifier/value/
 * expiresAt/createdAt/updatedAt). No schema change was needed.
 * Migration 0007 adds `users.two_factor_enabled` (the plugin's
 * `user.twoFactorEnabled`) and the `two_factor` table (the plugin's own
 * table — the adapter resolves model `twoFactor` via the plural
 * schema key `twoFactors`, with usePlural: true).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { twoFactor } from "better-auth/plugins/two-factor";
import { github, google } from "better-auth/social-providers";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { StackMateBindings, WorkerExecutionContext } from "../../env.ts";
import * as schema from "../../../../../db/schema/index.ts";
import {
  accounts,
  sessions,
  twoFactor as twoFactorTable,
  users,
  verifications,
} from "../../../../../db/schema/auth.ts";
import {
  findStaffStatusByUserId,
  type ResolvedAuthConfig,
} from "../auth-config/service.ts";

export interface BetterAuthWorkerConfig {
  appName: string;
  baseURL: string;
  basePath: string;
  secret: string;
  trustedOrigins: string[];
  databaseConnectionString: string;
  usePluralTables: true;
  ipAddressHeaders: string[];
  cookieAttributes: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
  };
}

/**
 * Build a real Better Auth instance over an already-constructed Drizzle
 * database (e.g. `DrizzleStore.drizzleDb`, or a lazily built `drizzle(pgClient)`).
 * The caller owns the database connection lifecycle; constructing the
 * instance itself opens no connection.
 */
export function createBetterAuth(
  env: StackMateBindings,
  drizzleDb: Parameters<typeof drizzleAdapter>[0],
  authConfig?: ResolvedAuthConfig
) {
  const config = buildBetterAuthWorkerConfig(env);
  const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
  // Social providers come from the DB (Settings → Authentication). A
  // provider is registered ONLY when enabled AND fully configured
  // (client ID + decrypted secret); a half-configured row registers
  // nothing, so the login page never offers a broken button.
  const socialProviders: Record<string, unknown> = {};
  for (const p of authConfig?.oauth ?? []) {
    if (!p.enabled || !p.clientId || !p.clientSecret) continue;
    if (p.provider === "google") {
      socialProviders.google = google({ clientId: p.clientId, clientSecret: p.clientSecret });
    } else if (p.provider === "github") {
      socialProviders.github = github({ clientId: p.clientId, clientSecret: p.clientSecret });
    }
  }
  return betterAuth({
    appName: config.appName,
    baseURL: config.baseURL,
    basePath: config.basePath,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    // Staff authentication is email + password. Without this, Better Auth
    // has no credential provider at all (sign-up/sign-in return
    // "Email and password sign up is not enabled"). Public self-registration
    // stays closed: app.ts blocks /api/auth/sign-up/* before the Better Auth
    // fallback, so a credential is created only server-side by
    // ensureBetterAuthIdentity (an `accounts` row for an existing staff
    // user — never signUpEmail, which would duplicate the `users` row).
    // A Better Auth user without a StackMate staff record has no roles
    // and cannot pass any admin authorization check anyway.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    socialProviders,
    plugins: [
      // TOTP (authenticator app) + backup codes. Backup codes MUST be
      // stored encrypted — the plugin's default is plaintext JSON
      // (encodeBackupCodes returns raw JSON without the option).
      twoFactor({
        issuer: "StackMate",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
    ],
    databaseHooks: {
      // Better Auth never creates users in StackMate (see the header
      // comment): staff users are provisioned by bootstrap / an
      // administrator / invitation acceptance, and OAuth links to the
      // existing row. Returning false here is the fail-closed guard for
      // the OAuth callback path — a non-staff Google/GitHub login can
      // never mint a user (or a session, below).
      user: {
        create: {
          before: async () => false,
        },
      },
      session: {
        create: {
          before: async (session) => {
            // The adapter's DB type is loose (`{[key: string]: any}`),
            // so the cast to the typed Drizzle db goes through unknown.
            const db = drizzleDb as unknown as NodePgDatabase<typeof schema>;
            const status = await findStaffStatusByUserId(db, session.userId).catch(
              () => null
            );
            // Suspended staff mint no session via OAuth (the credential
            // path checks this in signInStaffSession). A missing
            // staff_profiles row reads as active — the DrizzleStore's
            // rule — so only an explicit "suspended" blocks.
            if (status === "suspended") return false;
          },
        },
      },
    },
    // Staff sessions last 12h (matching the previous custom staff sessions)
    // instead of Better Auth's 7-day default; refreshed at most hourly.
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    database: drizzleAdapter(drizzleDb, {
      provider: "pg",
      // With usePlural the adapter expects the PLURAL camelCase keys
      // (users, sessions, accounts, verifications — and twoFactors for
      // the plugin's twoFactor model). The underlying Postgres table
      // stays `two_factor` (db/schema/auth.ts). Passing the singular
      // `twoFactor` key fails the adapter's schema check at sign-in
      // time ("Missing tables: twoFactors") — caught by the
      // better-auth-unified suite, 2026-11-16.
      schema: { users, sessions, accounts, verifications, twoFactors: twoFactorTable },
      usePlural: true,
    }),
    advanced: {
      // Verified against better-auth 1.7.23 typings
      // (@better-auth/core BetterAuthAdvancedOptions): the supported way to
      // name the client-IP header is advanced.ipAddress.ipAddressHeaders.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Pin the origin check ON in every environment (Auth + Email fix
      // batch). Better Auth defaults it to `isTest() ? true : false`,
      // and isTest() is true under vitest — via NODE_ENV=test AND via
      // TEST=true, which vitest sets — so the check was silently OFF
      // in every test while ON in production (Workers). That gap hid
      // the live 2FA 403: the suite never saw the origin check at all.
      // Explicit `false` changes nothing in production (isTest() is
      // already false there) — it only makes tests exercise the real
      // check, as a browser SPA would. Tests that POST to /api/auth/*
      // with a session cookie must therefore send an Origin header,
      // exactly like the real SPA does.
      disableOriginCheck: false,
      useSecureCookies: isProd,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
      },
    },
  });
}

/**
 * Origin of a configured URL, or null when it does not parse (a bad
 * env value must never crash auth construction).
 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Normalize ONE configured trusted origin to the bare origin Better
 * Auth actually compares against.
 *
 * Verified against the installed better-auth 1.7.23 dist
 * (dist/auth/trusted-origins.mjs): `matchesOriginPattern` compares a
 * non-wildcard pattern with EXACT string equality against
 * `getOrigin(url)` — the pattern is never normalized — while
 * `getTrustedOrigins` (dist/context/helpers.mjs) pushes
 * `options.trustedOrigins` RAW. A dashboard value copied with a
 * trailing slash or a path
 * (`https://stackmate-api-staging.ad-dawah.workers.dev/`) therefore
 * NEVER matches the browser's Origin header
 * (`https://stackmate-api-staging.ad-dawah.workers.dev`, no slash):
 * that is exactly the live 2FA failure (fix batch #2, 2026-11-16 —
 * batch #1 only normalized API_URL/APP_URL and left TRUSTED_ORIGINS
 * raw). `new URL().origin` also lower-cases the host and drops
 * default ports and paths, so every dashboard variation collapses
 * to the same bare origin.
 *
 * Wildcard patterns (`*` / `?` present) are Better Auth's own
 * matching syntax and are kept verbatim (trimmed): `new URL()`
 * rejects a bare `*.example.com` (no scheme), so running one through
 * originOf() would silently DROP a legitimate wildcard entry.
 */
function normalizeTrustedOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("*") || trimmed.includes("?")) return trimmed;
  return originOf(trimmed);
}

/**
 * CONFIG-ONLY helper: returns the plain Better Auth settings for this env.
 * It does NOT create an auth instance — use `createBetterAuth()` for that.
 */
export function buildBetterAuthWorkerConfig(
  env: StackMateBindings,
  _ctx?: WorkerExecutionContext
): BetterAuthWorkerConfig {
  const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
  return {
    appName: "StackMate",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    // The same-origin admin SPA POSTs to /api/auth/* (two-factor
    // setup/verify/disable, OAuth) through Better Auth's router, whose
    // originCheckMiddleware 403s any POST whose Origin is not trusted
    // (Auth + Email fix batch: the live 2FA password gate 403'd with
    // the correct password — in vitest the check is skipped, isTest(),
    // so the suite never saw it). Better Auth auto-trusts the baseURL
    // origin, but BETTER_AUTH_URL can go stale; the app's own
    // deployment origins (API_URL / APP_URL — the Worker URL the SPA
    // is served from) are always trusted too, so a stale baseURL can
    // never lock the same-origin SPA out of its own auth endpoints.
    // These are the app's own deployment URLs, not user input — no
    // cross-site origin is trusted by this.
    //
    // NORMALIZATION (2FA origin fix batch #2, 2026-11-16): EVERY
    // entry goes through normalizeTrustedOrigin (see above). Batch #1
    // normalized only API_URL/APP_URL and left the TRUSTED_ORIGINS
    // entries raw — a dashboard value with a trailing slash or path
    // then never matched the browser's bare Origin header, and the
    // live 2FA gate kept 403ing with INVALID_ORIGIN. BETTER_AUTH_URL
    // is included explicitly as well (never rely on Better Auth
    // auto-trusting baseURL alone): if it is the only var naming the
    // deployment, the SPA still gets in. Wildcards are preserved
    // verbatim by the normalizer.
    trustedOrigins: Array.from(
      new Set(
        [
          ...(env.TRUSTED_ORIGINS ?? "")
            .split(",")
            .map(normalizeTrustedOrigin),
          originOf(env.BETTER_AUTH_URL),
          originOf(env.API_URL),
          originOf(env.APP_URL),
        ].filter((o): o is string => o !== null)
      )
    ),
    // Always use the cache-disabled Hyperdrive binding for auth & session consistency
    databaseConnectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
    usePluralTables: true,
    ipAddressHeaders: ["cf-connecting-ip"],
    cookieAttributes: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
    },
  };
}
