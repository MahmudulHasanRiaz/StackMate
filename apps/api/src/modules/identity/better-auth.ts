/**
 * Better Auth + Drizzle ORM + Cloudflare Hyperdrive configuration (ADR-0005, ADR-0006).
 *
 * `createBetterAuth()` builds a REAL Better Auth instance (betterAuth() is
 * actually called) backed by the Drizzle adapter over PostgreSQL, using the
 * request-scoped cache-disabled Hyperdrive connection (`HYPERDRIVE_NO_CACHE`),
 * `usePlural: true` (matching `users`, `sessions`, `accounts`, `verifications`),
 * `cf-connecting-ip` for rate limiting on Cloudflare Workers, and `HttpOnly` +
 * `Secure` (staging/production only) + `SameSite=Lax` cookies.
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
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { StackMateBindings, WorkerExecutionContext } from "../../env.ts";
import {
  accounts,
  sessions,
  users,
  verifications,
} from "../../../../../db/schema/auth.ts";

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
  drizzleDb: Parameters<typeof drizzleAdapter>[0]
) {
  const config = buildBetterAuthWorkerConfig(env);
  const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
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
    // Staff sessions last 12h (matching the previous custom staff sessions)
    // instead of Better Auth's 7-day default; refreshed at most hourly.
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    database: drizzleAdapter(drizzleDb, {
      provider: "pg",
      schema: { users, sessions, accounts, verifications },
      usePlural: true,
    }),
    advanced: {
      // Verified against better-auth 1.7.23 typings
      // (@better-auth/core BetterAuthAdvancedOptions): the supported way to
      // name the client-IP header is advanced.ipAddress.ipAddressHeaders.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
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
    trustedOrigins: env.TRUSTED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
