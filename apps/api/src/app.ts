/**
 * StackMate Central API Application (Hono / Cloudflare Workers Fetch Standard).
 *
 * Composes:
 * 1. Environment validation (`resolveRuntimeConfig`).
 * 2. Correlation / Request ID (`X-Request-ID`).
 * 3. Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`).
 * 4. Origin-verified CORS & CSRF defense on cookie-authenticated mutations.
 * 5. Route-class Rate Limiting (`429 RATE_LIMIT_EXCEEDED`).
 * 6. Trust-boundary authentication & RBAC enforcement:
 *    - `/api/auth/*`
 *    - `/api/v1/admin/*`
 *    - `/api/v1/public/sites/:siteKey/*`
 *    - `/api/v1/integrations/sites/:siteKey/*`
 *    - `/api/v1/licenses/*`
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createCollectionEnvelope,
  createErrorEnvelope,
  createSuccessEnvelope,
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  SchemaValidationError,
} from "../../../packages/contracts/src/index.ts";
import {
  resolveRuntimeConfig,
  type StackMateBindings,
  type WorkerExecutionContext,
} from "./env.ts";
import { verifyCheckoutAccessToken } from "./platform/crypto/index.ts";
import { StackMateDataStore } from "./platform/db/store.ts";
import { createBetterAuth } from "./modules/identity/better-auth.ts";
import {
  buildInvitationEmail,
  buildPasswordResetEmail,
  buildTestEmail,
  buildTwoFactorRecoveryEmail,
  isSmtpConfigured,
  sendStackMateEmail,
  type SendResult,
} from "./modules/email/service.ts";
import {
  loadAuthConfig,
  saveOAuthProvider,
  saveSmtpSettings,
  saveTwoFactorPolicy,
  toAuthConfigView,
  type ResolvedAuthConfig,
} from "./modules/auth-config/service.ts";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  publicViewOf,
  saveGeneralSettings,
  storeFavicon,
} from "./modules/general-settings/service.ts";
import { AppError } from "./shared/errors.ts";
import {
  isTimestampInOverviewRange,
  parseOverviewRange,
} from "./modules/analytics/overview-range.ts";
import {
  acceptStaffInvitation,
  assertStaffPermission,
  bootstrapInitialSuperAdmin,
  changeStaffPassword,
  createPasswordResetToken,
  createRoleByAdmin,
  createStaffInvitationByAdmin,
  createStaffUserByAdmin,
  ensureBetterAuthIdentity,
  isSuperAdminProvisioned,
  recoverTwoFactorByToken,
  resetStaffPasswordByToken,
  resolveStaffPrincipal,
  revokeStaffInvitationByAdmin,
  signInStaffSession,
  signOutStaffSession,
  storePasswordResetToken,
  storeSupportsBetterAuth,
  type StaffPrincipal,
  updateRoleByAdmin,
  updateStaffUserRoles,
  updateOwnProfile,
} from "./modules/identity/service.ts";
import {
  archiveProductFeatureByAdmin,
  createNewPackageVersion,
  createPackagePrice,
  createProduct,
  createProductFeature,
  createProductFeaturesBulk,
  createProductPackageWithDraftVersion,
  disablePackagePriceByAdmin,
  publishPackageVersion,
  retirePackageVersionByAdmin,
  updatePackagePriceByAdmin,
  updateProductFeatureByAdmin,
  updateProductMetadata,
  updateProductPackageByAdmin,
  updateProductStatus,
  withFeatureUsage,
} from "./modules/catalog/service.ts";
import {
  computeCustomerFinancials,
  computeOrderPaid,
  computeOrderRemaining,
  createCustomerAddressByAdmin,
  createCustomerByAdmin,
  createCustomerReportByAdmin,
  deleteCustomerAddressByAdmin,
  listCustomerAddresses,
  listCustomerReports,
  splitCustomerContactByAdmin,
  toCustomerAddressDto,
  updateCustomerAddressByAdmin,
  updateCustomerByAdmin,
} from "./modules/customers/service.ts";
import {
  cancelOrderByAdmin,
  cancelOrderInTx,
  completeOrderByAdmin,
  createInvoiceForOrderByAdmin,
  createOrderByAdmin,
  createPublicCheckoutOrder,
  voidInvoiceByAdmin,
} from "./modules/commerce/service.ts";
import {
  approvePaymentSubmissionByStaff,
  createPaymentMethodByAdmin,
  createPaymentProviderByAdmin,
  recordManualPaymentClaimByAdmin,
  rejectPaymentSubmissionByStaff,
  setPaymentMethodEnabledByAdmin,
  submitManualPaymentClaim,
  toPublicPaymentMethodDto,
  updateInstallmentByAdmin,
  updatePaymentMethodByAdmin,
  updatePaymentProviderByAdmin,
  uploadPrivatePaymentEvidence,
} from "./modules/payments/service.ts";
import {
  generateSubscriptionRenewalInvoice,
  transitionSubscriptionStatus,
} from "./modules/subscriptions/service.ts";
import {
  activateLicenseInstallation,
  appendLicenseEntitlementSnapshotByAdmin,
  createManualLicenseGrantByAdmin,
  deactivateLicenseActivationByAdmin,
  deactivateLicenseInstallation,
  transitionLicenseStatusByAdmin,
  validateLicenseInstallation,
} from "./modules/licensing/service.ts";
import {
  assignProductToSiteByAdmin,
  authenticateSignedServerRequest,
  createSiteCredentialByAdmin,
  deleteSiteDomainByAdmin,
  generateDomainVerificationChallengeByAdmin,
  registerIntegratedSiteByAdmin,
  registerSiteDomainByAdmin,
  removeProductFromSiteByAdmin,
  revokeIntegratedSiteByAdmin,
  revokeSiteCredentialByAdmin,
  rotateSiteServerCredentialByAdmin,
  suspendIntegratedSiteByAdmin,
  updateIntegratedSiteByAdmin,
  verifySiteDomainByAdmin,
} from "./modules/integrations/service.ts";
import {
  configureSiteTrackingByAdmin,
  createTrackingConfigByAdmin,
  deleteTrackingConfigByAdmin,
  ingestExternalTrackingEvent,
  updateTrackingConfigByAdmin,
} from "./modules/tracking/service.ts";
import {
  deleteWebhookEndpointByAdmin,
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
  replayOutboxEventByAdmin,
  testWebhookEndpointByAdmin,
} from "./modules/webhooks/service.ts";
import { appendAuditLog, resolveAuditResourceDisplayName } from "./modules/audit/service.ts";
import {
  addTicketCommentByAdmin,
  assignTicketByAdmin,
  createTicketByAdmin,
  transitionTicketByAdmin,
  updateTicketByAdmin,
} from "./modules/tickets/service.ts";
import {
  assignLeadByAdmin,
  convertLeadByAdmin,
  createLeadByAdmin,
  ingestLead,
  transitionLeadByAdmin,
  updateLeadByAdmin,
} from "./modules/leads/service.ts";
import {
  getReminderSettings,
  saveReminderSettings,
} from "./modules/reminders/service.ts";
import { searchGlobal } from "./modules/search/service.ts";
import {
  markSweepRemindersSent,
  runRenewalExpirySweep,
} from "./modules/renewal/sweep.ts";

interface RouteMatch {
  params: Record<string, string>;
}

function matchPath(pattern: string, pathname: string): RouteMatch | null {
  const patParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    const p = patParts[i]!;
    const actual = pathParts[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(actual);
    } else if (p !== actual) {
      return null;
    }
  }
  return { params };
}

function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (
      rawName === "stackmate_session" ||
      rawName === "__Host-stackmate_session" ||
      rawName === "better-auth.session_token" ||
      // Staging/production set the session cookie with the __Secure-
      // prefix (useSecureCookies: isProd). Without this name the app
      // CSRF gate below never sees the cookie live and never enforces
      // (ADR-0008 decision 10).
      rawName === "__Secure-better-auth.session_token"
    ) {
      return rest.join("=").trim();
    }
  }
  return null;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Constant-time setup-token comparison for the first-admin bootstrap
 * gate. Both values are SHA-256 hashed first, so the comparison itself
 * runs over fixed-length digests and leaks neither the token nor its
 * length through timing.
 */
function setupTokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Per-request store factory: builds (or returns) the store for one request
 * from the already-resolved env. Used by the Worker entrypoint so every
 * request gets a fresh DrizzleStore instead of a module-level shared store.
 */
export type StackMateStoreFactory = (
  env: StackMateBindings,
  ctx?: WorkerExecutionContext
) => Promise<StackMateDataStore>;

export interface StackMateAppInstance {
  /**
   * The construction-time store, when the app was built with an injected
   * (or default in-memory) store. `null` in `storeFactory` mode: there is
   * no single store — one is resolved per request via the factory.
   */
  readonly store: StackMateDataStore | null;
  fetch(
    request: Request,
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<Response>;
  scheduled(
    event: { cron?: string; scheduledTime?: number },
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<{ claimed: number; delivered: number; retrying: number; dead_lettered: number }>;
}

export function createStackMateApp(
  existingStore?: StackMateDataStore
): StackMateAppInstance;
export function createStackMateApp(options: {
  storeFactory: StackMateStoreFactory;
}): StackMateAppInstance;
export function createStackMateApp(
  existingStoreOrOptions?: StackMateDataStore | { storeFactory: StackMateStoreFactory }
): StackMateAppInstance {
  const storeFactory =
    existingStoreOrOptions && "storeFactory" in existingStoreOrOptions
      ? existingStoreOrOptions.storeFactory
      : undefined;
  const injectedStore = storeFactory
    ? undefined
    : ((existingStoreOrOptions as StackMateDataStore | undefined) ??
      new StackMateDataStore());
  const rateLimitBuckets = new Map<string, { count: number; resetAtMs: number }>();

  function checkRateLimit(bucketKey: string, maxRequests: number, windowMs = 60_000): void {
    const now = Date.now();
    const entry = rateLimitBuckets.get(bucketKey);
    if (!entry || now >= entry.resetAtMs) {
      rateLimitBuckets.set(bucketKey, { count: 1, resetAtMs: now + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      throw new AppError(
        "RATE_LIMIT_EXCEEDED",
        "Too many requests. Please retry after the rate-limit window resets.",
        429
      );
    }
  }

  function buildStandardHeaders(
    requestId: string,
    origin: string | null,
    trustedOrigins: string[],
    extraHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-ID": requestId,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      ...extraHeaders,
    };
    if (origin && trustedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Vary"] = "Origin";
    }
    return headers;
  }

  /**
   * Resolve the store for one request. In `storeFactory` mode the factory
   * decides (Worker entrypoint: fresh DrizzleStore per request). Otherwise
   * the construction-time injected/default store is returned.
   */
  async function resolveRequestStore(
    env: StackMateBindings,
    ctx?: WorkerExecutionContext
  ): Promise<StackMateDataStore> {
    if (storeFactory) return storeFactory(env, ctx);
    if (!injectedStore) {
      throw new AppError("INTERNAL_ERROR", "No data store is configured for this request.", 500);
    }
    return injectedStore;
  }

  /**
   * End a factory-owned (per-request) store's resources. Only the
   * DrizzleStore owns anything closeable (its request-scoped pg
   * Client); the in-memory store has no dispose/close and this is a
   * no-op for it. Called only for storeFactory mode, where the factory
   * created the store for this request — an injected store's lifetime
   * belongs to its owner and is never closed here. Never throws: a
   * close failure must not mask the request's response (or the cron
   * result). Without this, every request would leak one pg connection
   * per Worker isolate until Neon/Hyperdrive rejects new connects.
   */
  async function closeRequestStore(store: StackMateDataStore): Promise<void> {
    const dispose = (
      store as unknown as { dispose?: () => Promise<void> }
    ).dispose;
    if (typeof dispose === "function") {
      await dispose.call(store).catch(() => {});
    }
  }

  /**
   * Build the Better Auth instance for one request from the request's store.
   * A DrizzleStore exposes its `drizzleDb` directly. Any other store (the
   * in-memory test adapter) gets a lazily created `pg` Client + drizzle()
   * over the Hyperdrive uncached connection string — constructing a `pg`
   * Client and calling drizzle() opens NO connection, so Better Auth paths
   * that never query (e.g. GET /api/auth/ok) need no live database.
   */
  async function getBetterAuth(env: StackMateBindings, store: StackMateDataStore) {
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    // DB-driven auth config (ADR-0008): the Better Auth instance is
    // built per request from the current Settings (OAuth providers +
    // 2FA plugin), cached 30s and invalidated on Settings save. A
    // Settings change takes effect without a redeploy.
    let authConfig: ResolvedAuthConfig | undefined;
    if (maybeDrizzle.drizzleDb) {
      authConfig = await loadAuthConfig(
        maybeDrizzle.drizzleDb as Parameters<typeof loadAuthConfig>[0],
        { encryptionKey: env.ENCRYPTION_KEY_V1, keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION },
        env.HYPERDRIVE_NO_CACHE.connectionString
      ).catch(() => undefined);
    }
    if (maybeDrizzle.drizzleDb) {
      return createBetterAuth(
        env,
        maybeDrizzle.drizzleDb as Parameters<typeof createBetterAuth>[1],
        authConfig
      );
    }
    const { Client } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const client = new Client({
      connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
    });
    return createBetterAuth(env, drizzle(client), authConfig);
  }

  /**
   * Send one StackMate email (forgot password, invitation, 2FA
   * recovery, SMTP test). Adapts the store/env to the email service's
   * (db, deps, message) shape. On a store without a database there is
   * no SMTP config — returns the honest not-configured result instead
   * of throwing, so callers can keep the token_once / generic-200
   * paths. Never throws for a delivery failure.
   */
  async function sendEmailViaSmtp(
    store: StackMateDataStore,
    env: StackMateBindings,
    message: { to: string; subject: string; text: string; html?: string }
  ): Promise<SendResult> {
    const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
      | Parameters<typeof sendStackMateEmail>[0]
      | undefined;
    if (!db) {
      return {
        sent: false,
        error: "Email is not configured. Set up SMTP in Settings → Email.",
      };
    }
    return sendStackMateEmail(
      db,
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        appUrl: env.APP_URL,
      },
      message
    );
  }

  async function handleRequest(
    store: StackMateDataStore,
    request: Request,
    env: StackMateBindings,
    _ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const callerReqId = request.headers.get("X-Request-ID")?.trim();
    const requestId =
      callerReqId && /^[a-zA-Z0-9_-]{6,64}$/.test(callerReqId)
        ? `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`
        : `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const trustedOrigins = env.TRUSTED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const originHeader = request.headers.get("Origin");
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...buildStandardHeaders(requestId, originHeader, trustedOrigins),
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-StackMate-Site-Key, X-StackMate-Key-Id, X-StackMate-Timestamp, X-StackMate-Nonce, X-StackMate-Content-SHA256, X-StackMate-Signature",
        },
      });
    }

    const clientIp =
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-real-ip") ??
      "127.0.0.1";

    const jsonResponse = <T>(data: T, status = 200, extraHeaders?: Record<string, string>) =>
      new Response(JSON.stringify(createSuccessEnvelope(data, requestId)), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins, extraHeaders),
      });

    // Like jsonResponse, but appends multiple Set-Cookie values (e.g. the
    // signed Better Auth session cookie). Set-Cookie values must never be
    // joined with ", " — cookie Expires dates contain commas.
    const jsonResponseWithCookies = <T>(
      data: T,
      status = 200,
      cookies: string[] = [],
      extraHeaders?: Record<string, string>
    ) => {
      const headers = new Headers(
        buildStandardHeaders(requestId, originHeader, trustedOrigins, extraHeaders)
      );
      for (const cookie of cookies) headers.append("Set-Cookie", cookie);
      return new Response(JSON.stringify(createSuccessEnvelope(data, requestId)), {
        status,
        headers,
      });
    };

    const collectionResponse = <T>(
      items: T[],
      nextCursor: string | null = null,
      status = 200
    ) =>
      new Response(JSON.stringify(createCollectionEnvelope(items, nextCursor, requestId)), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
      });

    // Server-side list search (PLAN §29 / ADR-0010): `?q=` filters a list
    // over the FULL dataset on the server — never over a loaded page —
    // and `?limit=` caps the result AFTER filtering. The store loads the
    // full table snapshot per request by design, so filtering `store.state`
    // here is filtering the whole table; if the store ever paginates at
    // the DB layer, these filters must move into SQL.
    // `q` is trimmed + lowercased once here; every caller matches with
    // `includes` on already-lowercased haystacks.
    const parseListQuery = (params: URLSearchParams): { q: string; limit: number | null } => {
      const q = params.get("q")?.trim().toLowerCase() ?? "";
      const rawLimit = Number(params.get("limit"));
      const limit =
        Number.isFinite(rawLimit) && rawLimit >= 1
          ? Math.min(Math.floor(rawLimit), 100)
          : null;
      return { q, limit };
    };
    const applyListLimit = <T>(items: T[], limit: number | null): T[] =>
      limit === null ? items : items.slice(0, limit);
    const includesQuery = (haystack: string | null | undefined, q: string): boolean =>
      !q ? true : (haystack ?? "").toLowerCase().includes(q);
    // Digits-only queries (e.g. a phone fragment) also match the digit
    // form of a stored phone, so "0170000" finds "+880 1700-000…" rows.
    const matchesPhoneQuery = (
      phone: string | null | undefined,
      normalizedPhone: string | null | undefined,
      q: string,
    ): boolean => {
      if (!q) return true;
      if (includesQuery(phone, q)) return true;
      const digits = q.replace(/\D/g, "");
      if (!digits) return false;
      return (normalizedPhone ?? "").replace(/\D/g, "").includes(digits);
    };

    try {
      // Reject oversized JSON bodies (> 6 MB)
      const contentLength = Number(request.headers.get("Content-Length") ?? "0");
      if (contentLength > 6 * 1024 * 1024) {
        throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
      }

      // 1. Health & Readiness Endpoints
      if (method === "GET" && (pathname === "/api/v1/health" || pathname === "/api/v1/ready")) {
        return jsonResponse({
          status: "ok",
          service: "stackmate-api",
          environment: env.APP_ENV,
          default_currency: env.DEFAULT_CURRENCY,
          default_timezone: env.DEFAULT_TIMEZONE,
          hyperdrive: {
            uncached_binding_configured: Boolean(env.HYPERDRIVE_NO_CACHE?.connectionString),
            cached_binding_configured: Boolean(env.HYPERDRIVE_CACHED?.connectionString),
            query_metrics: store.queryMetrics,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // First-admin setup status (public, reveals exactly one bit):
      // true while no super_admin exists yet, false afterwards. The admin
      // SPA uses it to decide whether to show the first-time setup form
      // instead of the sign-in form. It never reveals users, counts, or
      // whether a setup token is configured.
      if (method === "GET" && pathname === "/api/v1/setup-status") {
        const provisioned = await isSuperAdminProvisioned(store);
        return jsonResponse({ setup_required: !provisioned });
      }

      // Public login-page config (Auth + Email batch, ADR-0008): which
      // OAuth providers the login page may show, and whether email
      // (forgot password / invitations / 2FA recovery) is configured.
      // No secrets, no user data — a provider is listed only when it is
      // enabled AND has a stored client id; the secret never leaves the
      // server. Same source of truth as the Better Auth instance.
      if (method === "GET" && pathname === "/api/v1/auth-config") {
        const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
        if (!maybeDrizzle.drizzleDb) {
          return jsonResponse({ oauth_providers: [], email_configured: false });
        }
        const config = await loadAuthConfig(
          maybeDrizzle.drizzleDb as Parameters<typeof loadAuthConfig>[0],
          { encryptionKey: env.ENCRYPTION_KEY_V1, keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION },
          env.HYPERDRIVE_NO_CACHE.connectionString
        ).catch(() => undefined);
        return jsonResponse({
          oauth_providers: (config?.oauth ?? [])
            .filter((p) => p.enabled && p.clientId)
            .map((p) => p.provider),
          email_configured: config?.smtp.enabled ?? false,
        });
      }

      // Public general config (Auth + Email batch, General Settings):
      // the app-wide settings the SPA applies at boot (brand, tab title,
      // favicon, login-page tagline + support contact). No secrets, no
      // user data — the same public-config pattern as /api/v1/auth-config.
      if (method === "GET" && pathname === "/api/v1/general-config") {
        const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
        if (!maybeDrizzle.drizzleDb) {
          return jsonResponse({ ...DEFAULT_GENERAL_SETTINGS });
        }
        const row = await loadGeneralSettings(
          maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0]
        ).catch(() => null);
        return jsonResponse(publicViewOf(row));
      }

      // Public favicon: streams the R2 object the General Settings
      // favicon points at. 404 when no favicon is uploaded (the SPA then
      // keeps its built-in default). Cacheable — the object key contains
      // the content hash, so a re-upload changes the key.
      if (method === "GET" && pathname === "/api/v1/favicon") {
        const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
        if (!maybeDrizzle.drizzleDb) throw new AppError("NOT_FOUND", "No favicon is configured.", 404);
        const row = await loadGeneralSettings(
          maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0]
        ).catch(() => null);
        if (!row?.faviconObjectKey) {
          throw new AppError("NOT_FOUND", "No favicon is configured.", 404);
        }
        const bucket = (store as unknown as { r2Bucket?: unknown }).r2Bucket as
          | { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null> }
          | undefined;
        const obj = await bucket?.get(row.faviconObjectKey);
        if (!obj) throw new AppError("NOT_FOUND", "Favicon not found.", 404);
        const bytes = await obj.arrayBuffer();
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": row.faviconContentType ?? "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }

      // 2. Authentication Routes (/api/auth/*)
      if (pathname.startsWith("/api/auth")) {
        checkRateLimit(`auth:${clientIp}`, 60);

        if (method === "POST" && pathname === "/api/auth/bootstrap-super-admin") {
          // TOKEN-GATED first-admin bootstrap (Security, 2026-11-15 — the
          // open endpoint it replaces let anyone who found the URL claim
          // a fresh instance, so it must never ship to production):
          //  - SETUP_TOKEN unset/empty => the endpoint does not exist:
          //    404 identical to an unknown route, so a prober cannot
          //    tell it apart from any other missing path.
          //  - SETUP_TOKEN set but the request's setupToken is missing or
          //    wrong => 403 with a generic message (no hint about the
          //    configured token). Compared in constant time.
          //  - Single-use is unchanged: bootstrapInitialSuperAdmin throws
          //    409 once a super_admin exists. Password >= 10 chars,
          //    auth rate limiting, and Better Auth provisioning are
          //    unchanged. The token is the operator-set Worker secret
          //    SETUP_TOKEN (Cloudflare dashboard, never in code).
          const configuredSetupToken = env.SETUP_TOKEN?.trim() ?? "";
          if (!configuredSetupToken) {
            throw new AppError(
              "NOT_FOUND",
              `Route '${method} ${pathname}' not found.`,
              404
            );
          }
          const body = (await request.json()) as {
            name?: string;
            email?: string;
            password?: string;
            setupToken?: string;
          };
          if (!body.setupToken || !setupTokenMatches(body.setupToken, configuredSetupToken)) {
            throw new AppError(
              "FORBIDDEN",
              "Setup token is missing or invalid.",
              403
            );
          }
          if (!body.name || !body.email || !body.password) {
            throw new AppError(
              "VALIDATION_ERROR",
              "name, email, and password are required.",
              422
            );
          }
          const created = await bootstrapInitialSuperAdmin(store, {
            name: body.name,
            email: body.email,
            password: body.password,
            requestId,
          });
          // Provision the Better Auth identity for the same email, so the
          // first sign-in goes through Better Auth directly. Best-effort:
          // if provisioning fails here, sign-in lazily migrates the
          // account (see identity/service.ts) and never duplicates it.
          if (storeSupportsBetterAuth(store)) {
            await ensureBetterAuthIdentity(store, {
              userId: created.user.id,
              email: body.email,
              password: body.password,
            }).catch(() => {});
          }
          return jsonResponse(created, 201);
        }

        if (method === "POST" && pathname === "/api/auth/sign-in") {
          const body = (await request.json()) as { email?: string; password?: string };
          if (!body.email || !body.password) {
            throw new AppError("VALIDATION_ERROR", "email and password are required.", 422);
          }
          const auth = storeSupportsBetterAuth(store)
            ? await getBetterAuth(env, store)
            : null;
          const signedIn = await signInStaffSession(
            store,
            {
              email: body.email,
              password: body.password,
              ipAddress: clientIp,
              userAgent: request.headers.get("User-Agent"),
              requestId,
            },
            auth
          );
          const payload = {
            session_token: signedIn.session_token,
            expires_at: signedIn.expires_at,
            principal: signedIn.principal,
          };
          // 2FA challenge (Auth + Email batch): the password was right
          // but TOTP is on — no session exists yet, so the SPA shows the
          // TOTP prompt instead of signing in. The plugin's verification
          // cookie is forwarded in set_cookie, as in the normal path.
          if (signedIn.two_factor_redirect) {
            const challengePayload = {
              two_factor_redirect: true,
              principal: signedIn.principal,
            };
            if (auth) {
              return jsonResponseWithCookies(challengePayload, 200, signedIn.set_cookie);
            }
            return jsonResponse(challengePayload, 200);
          }
          if (auth) {
            // Better Auth path: forward the signed session cookie(s) it issued.
            return jsonResponseWithCookies(payload, 200, signedIn.set_cookie);
          }
          const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
          const cookieName = isProd ? "__Host-stackmate_session" : "stackmate_session";
          const cookieValue = `${cookieName}=${signedIn.session_token}; Path=/; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`;
          return jsonResponse(payload, 200, { "Set-Cookie": cookieValue });
        }

        if (method === "POST" && pathname === "/api/auth/sign-out") {
          const cookieHeader = request.headers.get("Cookie");
          const bearerToken = extractBearerToken(request.headers.get("Authorization"));
          const auth = storeSupportsBetterAuth(store)
            ? await getBetterAuth(env, store)
            : null;
          const result = await signOutStaffSession(store, {
            auth,
            cookieHeader,
            bearerToken,
          });
          return jsonResponseWithCookies({ signed_out: true }, 200, [
            ...result.set_cookie,
            "stackmate_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
          ]);
        }

        if (method === "GET" && pathname === "/api/auth/session") {
          const auth = storeSupportsBetterAuth(store)
            ? await getBetterAuth(env, store)
            : null;
          const principal = await resolveStaffPrincipal(store, {
            auth,
            cookieHeader: request.headers.get("Cookie"),
            bearerToken: extractBearerToken(request.headers.get("Authorization")),
          });
          if (!principal) {
            throw new AppError("UNAUTHORIZED", "No active staff session.", 401);
          }
          return jsonResponse({ principal });
        }

        if (method === "POST" && pathname === "/api/auth/change-password") {
          const body = (await request.json()) as {
            current_password?: string;
            new_password?: string;
          };
          if (!body.current_password || !body.new_password) {
            throw new AppError(
              "VALIDATION_ERROR",
              "current_password and new_password are required.",
              422
            );
          }
          const auth = storeSupportsBetterAuth(store)
            ? await getBetterAuth(env, store)
            : null;
          const principal = await resolveStaffPrincipal(store, {
            auth,
            cookieHeader: request.headers.get("Cookie"),
            bearerToken: extractBearerToken(request.headers.get("Authorization")),
          });
          if (!principal) {
            throw new AppError("UNAUTHORIZED", "No active staff session.", 401);
          }
          const changed = await changeStaffPassword(store, principal, {
            auth,
            cookieHeader: request.headers.get("Cookie"),
            currentPassword: body.current_password,
            newPassword: body.new_password,
            requestId,
          });
          return jsonResponse(changed, 200);
        }

        if (method === "POST" && pathname === "/api/auth/accept-invitation") {
          // Public invitation acceptance (Batch 1): no session required —
          // the invitation token IS the credential. Rate-limited like
          // sign-in (60/min per IP, checked at the top of this block).
          // No email is sent anywhere in this flow: invitations are
          // created by an admin who delivers the one-time link to the
          // invitee out of band (there is no email system yet — Batch 5).
          const body = (await request.json()) as {
            token?: string;
            name?: string;
            password?: string;
          };
          if (!body.token || !body.name || !body.password) {
            throw new AppError(
              "VALIDATION_ERROR",
              "token, name, and password are required.",
              422
            );
          }
          const accepted = await acceptStaffInvitation(
            store,
            {
              token: body.token,
              name: body.name,
              password: body.password,
            },
            requestId
          );
          // Provision the Better Auth identity for the same email, so the
          // invitee can sign in directly. Best-effort, as in bootstrap:
          // if provisioning fails here, sign-in lazily migrates.
          if (storeSupportsBetterAuth(store)) {
            await ensureBetterAuthIdentity(store, {
              userId: accepted.user.id,
              email: accepted.user.email,
              password: body.password,
            }).catch(() => {});
          }
          return jsonResponse(accepted, 201);
        }

        // Forgot password (Auth + Email batch, ADR-0008): public, generic
        // 200 for every outcome (unknown email, suspended account, no
        // SMTP config) so the endpoint cannot enumerate staff. A token is
        // created and an email sent ONLY when the account exists, is
        // active, and SMTP is configured; the response never says which
        // of those failed. Per-email 60s cooldown via the same in-memory
        // rate-limit map (best-effort — an attacker learns nothing either
        // way). On a store without a database (in-memory test adapter)
        // there is no SMTP config and no token table — the generic 200
        // is returned with nothing sent.
        if (method === "POST" && pathname === "/api/auth/forgot-password") {
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          if (email) {
            const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
            const user = store.state.users.find(
              (u) => u.email.toLowerCase() === email && u.status === "active"
            );
            if (user && maybeDrizzle.drizzleDb) {
              try {
                // Auth + Email fix batch: when SMTP is not configured
                // no token is minted and nothing is sent — an
                // undeliverable token row is never created. The
                // generic 200 below is the only answer either way, so
                // the endpoint still reveals nothing about the account.
                const emailReady = await isSmtpConfigured(
                  maybeDrizzle.drizzleDb as Parameters<typeof isSmtpConfigured>[0],
                  {
                    encryptionKey: env.ENCRYPTION_KEY_V1,
                    keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
                  }
                ).catch(() => false);
                if (emailReady) {
                  const token = createPasswordResetToken(store, user.id, "password_reset");
                  await storePasswordResetToken(
                    store, user.id, "password_reset", token.tokenHash, token.expiresAt
                  );
                  await sendEmailViaSmtp(store, env, {
                    to: user.email,
                    ...buildPasswordResetEmail(env.APP_URL, token.rawToken),
                  }).catch(() => {});
                }
              } catch {
                // Fail closed + silent: the generic 200 below is the only
                // answer, whatever happened inside.
              }
            }
          }
          return jsonResponse({
            message:
              "If an account exists for that email, a reset link has been sent. Check your inbox.",
          });
        }

        // Reset password with a forgot-password token (single-use, 1h).
        // Returns 422 for an invalid/expired/used token — the token is
        // the credential here, so a generic message would hide nothing.
        // Does NOT disable 2FA: a compromised mailbox must not defeat it.
        if (method === "POST" && pathname === "/api/auth/reset-password") {
          const body = (await request.json().catch(() => ({}))) as {
            token?: string;
            new_password?: string;
          };
          if (!body.token || !body.new_password) {
            throw new AppError("VALIDATION_ERROR", "token and new_password are required.", 422);
          }
          const result = await resetStaffPasswordByToken(store, {
            token: body.token,
            newPassword: body.new_password,
            requestId,
          });
          return jsonResponse({ user_id: result.user_id, email: result.email });
        }

        // 2FA recovery (Auth + Email batch): two steps, same token shape
        // as password reset but a different purpose (a reset token cannot
        // disable 2FA and vice versa). Step 1 issues a recovery token by
        // email; step 2 verifies the password and disables 2FA. Both
        // steps are generic: step 1 always returns 200, step 2 returns
        // 422 for a bad/expired token and 401 for a wrong password.
        if (method === "POST" && pathname === "/api/auth/two-factor/recover") {
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          if (email) {
            const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
            const user = store.state.users.find(
              (u) => u.email.toLowerCase() === email && u.status === "active"
            );
            if (user && user.two_factor_enabled && maybeDrizzle.drizzleDb) {
              try {
                // Same rule as forgot-password (fix batch): no token is
                // minted when SMTP is not configured. Generic 200 below
                // either way.
                const emailReady = await isSmtpConfigured(
                  maybeDrizzle.drizzleDb as Parameters<typeof isSmtpConfigured>[0],
                  {
                    encryptionKey: env.ENCRYPTION_KEY_V1,
                    keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
                  }
                ).catch(() => false);
                if (emailReady) {
                  const token = createPasswordResetToken(store, user.id, "two_factor_recovery");
                  await storePasswordResetToken(
                    store, user.id, "two_factor_recovery", token.tokenHash, token.expiresAt
                  );
                  await sendEmailViaSmtp(store, env, {
                    to: user.email,
                    ...buildTwoFactorRecoveryEmail(env.APP_URL, token.rawToken),
                  }).catch(() => {});
                }
              } catch {
                // Generic 200 below, whatever happened inside.
              }
            }
          }
          return jsonResponse({
            message:
              "If 2FA is enabled for that email, a recovery link has been sent. Check your inbox.",
          });
        }
        if (method === "POST" && pathname === "/api/auth/two-factor/recover/confirm") {
          const body = (await request.json().catch(() => ({}))) as {
            token?: string;
            password?: string;
          };
          if (!body.token || !body.password) {
            throw new AppError("VALIDATION_ERROR", "token and password are required.", 422);
          }
          const auth = await getBetterAuth(env, store);
          const result = await recoverTwoFactorByToken(
            store,
            { token: body.token, password: body.password, requestId },
            auth
          );
          return jsonResponse({ user_id: result.user_id, email: result.email });
        }

        // Public self-registration is CLOSED: staff accounts are created
        // only by bootstrap / an administrator. The Better Auth sign-up
        // endpoint is reachable server-side only (see
        // ensureBetterAuthIdentity). Block it here, before the fallback.
        if (
          pathname === "/api/auth/sign-up" ||
          pathname.startsWith("/api/auth/sign-up/")
        ) {
          throw new AppError(
            "FORBIDDEN",
            "Public self-registration is disabled. Staff accounts are provisioned by an administrator.",
            403
          );
        }

        // Direct Better Auth email sign-in is CLOSED for the same reason:
        // POST /api/auth/sign-in above is the only sign-in path. It
        // requires a StackMate staff record and rejects suspended staff
        // BEFORE any session is issued; the raw Better Auth route
        // (/api/auth/sign-in/email) checks neither, so a suspended user
        // could mint a live session through it. Admin routes re-check
        // staff status on every request, so that session could not call
        // the admin API — but the bypass is closed anyway, defence in
        // depth. Internal server-side calls use auth.api.signInEmail
        // directly and are unaffected.
        //
        // EXCEPTION (Auth + Email batch): /api/auth/sign-in/social is
        // open — it is the OAuth entry point. The databaseHooks in
        // better-auth.ts (user.create.before always false,
        // session.create.before rejects suspended staff) are the gate
        // there: a non-staff Google/GitHub login can never mint a user
        // or a session.
        if (
          pathname.startsWith("/api/auth/sign-in/") &&
          pathname !== "/api/auth/sign-in/social"
        ) {
          throw new AppError(
            "FORBIDDEN",
            "Use POST /api/auth/sign-in. Direct Better Auth sign-in routes are disabled.",
            403
          );
        }

        // Fallback: every other /api/auth/* path is handled by real Better Auth.
        //
        // UNIFIED SESSIONS (2026-11-15, Fix 2): staff sign-in, session
        // validation, sign-out and password change above all go through
        // Better Auth sessions (Drizzle `sessions` table). The custom
        // identity service only maps a Better Auth user to StackMate
        // roles/permissions and enforces suspension. The only remaining
        // seam is the in-memory test adapter (no Postgres, no Better
        // Auth) — see modules/identity/service.ts header.
        const auth = await getBetterAuth(env, store);
        return auth.handler(request);
      }

      // 3. License Client API (/api/v1/licenses/*)
      if (pathname.startsWith("/api/v1/licenses")) {
        checkRateLimit(`licenses:${clientIp}`, 120);

        // Security rule (API Spec §6.5 & §25.2): Reject license_key in URL query string
        if (url.searchParams.has("license_key") || url.searchParams.has("key")) {
          throw new AppError(
            "VALIDATION_ERROR",
            "License credentials must never be passed in URL query parameters.",
            400
          );
        }

        if (method === "GET" && pathname === "/api/v1/licenses/signing-keys") {
          const keys = Array.from(store.signingKeys.values()).map((k) => k.publicKeyJwk);
          return jsonResponse({ keys });
        }

        if (method === "POST" && pathname === "/api/v1/licenses/activate") {
          const body = await request.json();
          const result = await activateLicenseInstallation(store, body, {
            verifierSecret: env.LICENSE_VERIFIER_SECRET,
            issuerUrl: env.API_URL,
          });
          return jsonResponse(result, 200);
        }

        if (method === "POST" && pathname === "/api/v1/licenses/validate") {
          const body = await request.json();
          const result = await validateLicenseInstallation(store, body, {
            verifierSecret: env.LICENSE_VERIFIER_SECRET,
            issuerUrl: env.API_URL,
          });
          return jsonResponse(result, 200);
        }

        if (method === "POST" && pathname === "/api/v1/licenses/deactivate") {
          const body = await request.json();
          const result = await deactivateLicenseInstallation(store, body, {
            verifierSecret: env.LICENSE_VERIFIER_SECRET,
          });
          return jsonResponse(result, 200);
        }
      }

      // 4. Public Website & Checkout API (/api/v1/public/*)
      if (pathname.startsWith("/api/v1/public/")) {
        checkRateLimit(`public:${clientIp}`, 120);
        const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();

        const mProducts = matchPath("/api/v1/public/sites/:siteKey/products", pathname);
        if (method === "GET" && mProducts) {
          const siteKey = mProducts.params.siteKey!;
          if (siteKeyHeader && siteKeyHeader !== siteKey) {
            throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
          }
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);

          // Uses Hyperdrive cached read path (ADR-0005)
          store.queryMetrics.cachedQueries += 1;
          const allowedProducts = store.state.products
            .filter((p) => p.status === "active" && site.product_ids.includes(p.id))
            .map((p) => ({
              slug: p.slug,
              code: p.code,
              name: p.name,
              description: p.description,
              product_type: p.product_type,
              website_url: p.website_url,
              documentation_url: p.documentation_url,
            }));
          return collectionResponse(allowedProducts);
        }

        const mPackages = matchPath(
          "/api/v1/public/sites/:siteKey/products/:productSlug/packages",
          pathname
        );
        if (method === "GET" && mPackages) {
          const { siteKey, productSlug } = mPackages.params as {
            siteKey: string;
            productSlug: string;
          };
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
          const product = store.state.products.find(
            (p) => p.slug === productSlug && p.status === "active"
          );
          if (!product || !site.product_ids.includes(product.id)) {
            throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
          }

          store.queryMetrics.cachedQueries += 1;
          const packages = store.state.product_packages
            .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
            .map((pkg) => {
              const publishedVer = store.state.package_versions.find(
                (v) => v.id === pkg.current_version_id && v.status === "published"
              );
              if (!publishedVer) return null;
              const prices = store.state.package_prices
                .filter(
                  (pr) => pr.package_version_id === publishedVer.id && pr.status === "active"
                )
                .map((pr) => ({
                  id: pr.id,
                  price_key: pr.price_key,
                  price_kind: pr.price_kind,
                  amount_minor: pr.amount_minor,
                  currency_code: pr.currency_code,
                  interval_unit: pr.interval_unit,
                  interval_count: pr.interval_count,
                  trial_days: pr.trial_days,
                  setup_fee_minor: pr.setup_fee_minor,
                }));
              return {
                package_key: pkg.package_key,
                name: pkg.name,
                description: pkg.description,
                package_version_id: publishedVer.id,
                version_number: publishedVer.version_number,
                features: publishedVer.features.map((f) => ({
                  feature_key: f.feature_key_snapshot,
                  value_type: f.value_type_snapshot,
                  entitlement_value: f.entitlement_value,
                  unit: f.unit_snapshot,
                })),
                prices,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

          return collectionResponse(packages);
        }

        // Batch 1: single-product detail for a site's public catalogue —
        // same authorization as the product list (active site, active
        // product, product assigned to the site), plus its published
        // packages with active prices.
        const mProductPublic = matchPath(
          "/api/v1/public/sites/:siteKey/products/:productSlug",
          pathname
        );
        if (method === "GET" && mProductPublic) {
          const { siteKey, productSlug } = mProductPublic.params as {
            siteKey: string;
            productSlug: string;
          };
          if (siteKeyHeader && siteKeyHeader !== siteKey) {
            throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
          }
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
          const product = store.state.products.find(
            (p) => p.slug === productSlug && p.status === "active"
          );
          if (!product || !site.product_ids.includes(product.id)) {
            throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
          }
          store.queryMetrics.cachedQueries += 1;
          const packages = store.state.product_packages
            .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
            .map((pkg) => {
              const publishedVer = store.state.package_versions.find(
                (v) => v.id === pkg.current_version_id && v.status === "published"
              );
              if (!publishedVer) return null;
              return {
                package_key: pkg.package_key,
                name: pkg.name,
                description: pkg.description,
                package_version_id: publishedVer.id,
                version_number: publishedVer.version_number,
                features: publishedVer.features.map((f) => ({
                  feature_key: f.feature_key_snapshot,
                  value_type: f.value_type_snapshot,
                  entitlement_value: f.entitlement_value,
                  unit: f.unit_snapshot,
                })),
                prices: store.state.package_prices
                  .filter(
                    (pr) => pr.package_version_id === publishedVer.id && pr.status === "active"
                  )
                  .map((pr) => ({
                    id: pr.id,
                    price_key: pr.price_key,
                    price_kind: pr.price_kind,
                    amount_minor: pr.amount_minor,
                    currency_code: pr.currency_code,
                    interval_unit: pr.interval_unit,
                    interval_count: pr.interval_count,
                    trial_days: pr.trial_days,
                    setup_fee_minor: pr.setup_fee_minor,
                  })),
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);
          return jsonResponse({
            slug: product.slug,
            code: product.code,
            name: product.name,
            description: product.description,
            product_type: product.product_type,
            website_url: product.website_url,
            documentation_url: product.documentation_url,
            features: store.state.product_features
              .filter((f) => f.product_id === product.id && f.status === "active")
              .map((f) => ({
                feature_key: f.feature_key,
                name: f.name,
                description: f.description,
                value_type: f.value_type,
                unit: f.unit,
                default_value: f.default_value,
              })),
            packages,
          });
        }

        // Batch 1: single published package-version detail for a site.
        // Only published versions of active packages of active, assigned
        // products are visible — anything else is 404, never a leak.
        const mPackagePublic = matchPath(
          "/api/v1/public/sites/:siteKey/packages/:packageVersionId",
          pathname
        );
        if (method === "GET" && mPackagePublic) {
          const { siteKey, packageVersionId } = mPackagePublic.params as {
            siteKey: string;
            packageVersionId: string;
          };
          if (siteKeyHeader && siteKeyHeader !== siteKey) {
            throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
          }
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
          const version = store.state.package_versions.find(
            (v) => v.id === packageVersionId && v.status === "published"
          );
          if (!version) throw new AppError("NOT_FOUND", "Published package version not found.", 404);
          const pkg = store.state.product_packages.find(
            (p) => p.id === version.package_id && p.status === "active"
          );
          if (!pkg) throw new AppError("NOT_FOUND", "Published package version not found.", 404);
          const product = store.state.products.find(
            (p) => p.id === pkg.product_id && p.status === "active"
          );
          if (!product || !site.product_ids.includes(product.id)) {
            throw new AppError("NOT_FOUND", "Published package version not found for this site.", 404);
          }
          store.queryMetrics.cachedQueries += 1;
          return jsonResponse({
            package_key: pkg.package_key,
            name: pkg.name,
            description: pkg.description,
            package_version_id: version.id,
            version_number: version.version_number,
            product_slug: product.slug,
            product_code: product.code,
            features: version.features.map((f) => ({
              feature_key: f.feature_key_snapshot,
              value_type: f.value_type_snapshot,
              entitlement_value: f.entitlement_value,
              unit: f.unit_snapshot,
            })),
            prices: store.state.package_prices
              .filter((pr) => pr.package_version_id === version.id && pr.status === "active")
              .map((pr) => ({
                id: pr.id,
                price_key: pr.price_key,
                price_kind: pr.price_kind,
                amount_minor: pr.amount_minor,
                currency_code: pr.currency_code,
                interval_unit: pr.interval_unit,
                interval_count: pr.interval_count,
                trial_days: pr.trial_days,
                setup_fee_minor: pr.setup_fee_minor,
              })),
          });
        }

        const mCheckoutCreate = matchPath(
          "/api/v1/public/sites/:siteKey/checkout/orders",
          pathname
        );
        if (method === "POST" && mCheckoutCreate) {
          const siteKey = mCheckoutCreate.params.siteKey!;
          if (!siteKeyHeader || siteKeyHeader !== siteKey) {
            throw new AppError(
              "UNAUTHORIZED",
              "Matching X-StackMate-Site-Key header is required.",
              401
            );
          }
          const idempotencyKey = request.headers.get("Idempotency-Key");
          if (!idempotencyKey) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Idempotency-Key header is required for checkout order creation.",
              400
            );
          }
          const rawBody = await request.json();
          const result = await createPublicCheckoutOrder(store, {
            siteKey,
            idempotencyKey,
            checkoutTokenSecret: env.CHECKOUT_TOKEN_SECRET,
            rawBody,
            requestId,
          });
          const { replayed: _, ...payload } = result;
          return jsonResponse(payload, result.replayed ? 200 : 201);
        }

        const mOrderDetail = matchPath(
          "/api/v1/public/sites/:siteKey/checkout/orders/:publicReference",
          pathname
        );
        if (method === "GET" && mOrderDetail) {
          const { siteKey, publicReference } = mOrderDetail.params as {
            siteKey: string;
            publicReference: string;
          };
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
          const bearer = extractBearerToken(request.headers.get("Authorization"));
          if (!bearer) {
            throw new AppError("UNAUTHORIZED", "Checkout access token is required.", 401);
          }
          const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
          if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
            throw new AppError(
              "FORBIDDEN",
              "Checkout access token is not valid for this order or site.",
              403
            );
          }
          const order = store.state.orders.find(
            (o) => o.id === tokenClaims.oid && o.public_reference === publicReference
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

          return jsonResponse({
            public_reference: order.public_reference,
            order_number: order.order_number,
            status: order.status,
            payment_status: order.payment_status,
            currency_code: order.currency_code,
            subtotal_minor: order.subtotal_minor,
            discount_minor: order.discount_minor,
            tax_minor: order.tax_minor,
            total_minor: order.total_minor,
            created_at: order.created_at,
            created_date_display: formatDisplayDateDDMMYYYY(order.created_at, env.DEFAULT_TIMEZONE),
            items: order.items.map((it) => ({
              product_name: it.product_name_snapshot,
              package_name: it.package_name_snapshot,
              quantity: it.quantity,
              line_total_minor: it.line_total_minor,
            })),
          });
        }

        const mOrderPaymentMethods = matchPath(
          "/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-methods",
          pathname
        );
        if (method === "GET" && mOrderPaymentMethods) {
          const { siteKey, publicReference } = mOrderPaymentMethods.params as {
            siteKey: string;
            publicReference: string;
          };
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
          const bearer = extractBearerToken(request.headers.get("Authorization"));
          if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
          const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
          if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
            throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
          }

          const activeMethods = store.state.payment_methods
            .filter((m) => m.is_enabled)
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((m) => toPublicPaymentMethodDto(store, m));
          return collectionResponse(activeMethods);
        }

        const mEvidenceUpload = matchPath(
          "/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-evidence",
          pathname
        );
        if (method === "POST" && mEvidenceUpload) {
          const { siteKey, publicReference } = mEvidenceUpload.params as {
            siteKey: string;
            publicReference: string;
          };
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
          const bearer = extractBearerToken(request.headers.get("Authorization"));
          if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
          const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
          if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
            throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
          }
          const order = store.state.orders.find((o) => o.id === tokenClaims.oid);
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

          const body = (await request.json()) as {
            filename?: string;
            content_type?: string;
            content_base64?: string;
          };
          if (!body.filename || !body.content_type || !body.content_base64) {
            throw new AppError(
              "VALIDATION_ERROR",
              "filename, content_type, and content_base64 are required.",
              422
            );
          }
          const bytes = new Uint8Array(Buffer.from(body.content_base64, "base64"));
          // Fail closed in staging/production: payment evidence must land in
          // the real R2 bucket. A DrizzleStore without a bucket serves an
          // in-memory bucket (usesInMemoryBucket) where evidence would be
          // lost on restart and invisible to every other instance.
          const maybeBucket = store as unknown as {
            usesInMemoryBucket?: boolean;
          };
          if (
            (env.APP_ENV === "production" || env.APP_ENV === "staging") &&
            maybeBucket.usesInMemoryBucket
          ) {
            throw new AppError(
              "INTERNAL_ERROR",
              "Payment-evidence upload is unavailable: no real R2 bucket is configured for this environment.",
              503
            );
          }
          const asset = await uploadPrivatePaymentEvidence(store, {
            orderId: order.id,
            customerId: order.customer_id,
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: env.R2_BUCKET_NAME,
          });
          return jsonResponse(
            {
              evidence_asset_id: asset.id,
              original_filename: asset.original_filename,
              content_type: asset.content_type,
              byte_size: asset.byte_size,
              checksum_sha256: asset.checksum_sha256,
              visibility: asset.visibility,
            },
            201
          );
        }

        const mSubmitPayment = matchPath(
          "/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-submissions",
          pathname
        );
        if (method === "POST" && mSubmitPayment) {
          const { siteKey, publicReference } = mSubmitPayment.params as {
            siteKey: string;
            publicReference: string;
          };
          const site = store.state.integrated_sites.find(
            (s) => s.site_key === siteKey && s.status === "active"
          );
          if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
          const bearer = extractBearerToken(request.headers.get("Authorization"));
          if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
          const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
          if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
            throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
          }
          const idempotencyKey = request.headers.get("Idempotency-Key");
          if (!idempotencyKey) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Idempotency-Key header is required for payment submission.",
              400
            );
          }
          const rawBody = await request.json();
          const submitted = await submitManualPaymentClaim(store, {
            orderPublicReference: publicReference,
            idempotencyKey,
            rawBody,
          });
          const { replayed: _, ...payload } = submitted;
          return jsonResponse(payload, submitted.replayed ? 200 : 201);
        }

        const mPublicTrack = matchPath(
          "/api/v1/public/sites/:siteKey/tracking/events",
          pathname
        );
        if (method === "POST" && mPublicTrack) {
          const siteKey = mPublicTrack.params.siteKey!;
          const rawBody = await request.json();
          const result = await ingestExternalTrackingEvent(store, siteKey, rawBody);
          return jsonResponse(result, 202);
        }

        throw new AppError("FORBIDDEN", "Public site credentials cannot access this route.", 403);
      }

      // 5. Server-to-Server Signed Integration API (/api/v1/integrations/*)
      if (pathname.startsWith("/api/v1/integrations/")) {
        checkRateLimit(`integrations:${clientIp}`, 120);

        const mServerProducts = matchPath(
          "/api/v1/integrations/sites/:siteKey/products",
          pathname
        );
        if (method === "GET" && mServerProducts) {
          const siteKey = mServerProducts.params.siteKey!;
          const { site } = await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "catalog.read",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: "",
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const items = store.state.products.filter(
            (p) => p.status === "active" && site.product_ids.includes(p.id)
          );
          return collectionResponse(items);
        }

        const mServerOrders = matchPath(
          "/api/v1/integrations/sites/:siteKey/orders",
          pathname
        );
        if (method === "POST" && mServerOrders) {
          const siteKey = mServerOrders.params.siteKey!;
          const rawBodyText = await request.text();
          await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "checkout.create",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: rawBodyText,
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const idempotencyKey = request.headers.get("Idempotency-Key");
          if (!idempotencyKey) {
            throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is required.", 400);
          }
          const parsedJson = JSON.parse(rawBodyText);
          const result = await createPublicCheckoutOrder(store, {
            siteKey,
            idempotencyKey,
            checkoutTokenSecret: env.CHECKOUT_TOKEN_SECRET,
            rawBody: parsedJson,
            requestId,
          });
          const { replayed: _, ...payload } = result;
          return jsonResponse(payload, result.replayed ? 200 : 201);
        }

        const mServerOrderGet = matchPath(
          "/api/v1/integrations/sites/:siteKey/orders/:publicReference",
          pathname
        );
        if (method === "GET" && mServerOrderGet) {
          const { siteKey, publicReference } = mServerOrderGet.params as {
            siteKey: string;
            publicReference: string;
          };
          const { site } = await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "orders.read:own",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: "",
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          // BOLA protection: site can ONLY read orders belonging to its own integrated_site_id
          const order = store.state.orders.find(
            (o) => o.public_reference === publicReference && o.integrated_site_id === site.id
          );
          if (!order) {
            throw new AppError("NOT_FOUND", "Order not found for this integrated site.", 404);
          }
          return jsonResponse({
            public_reference: order.public_reference,
            order_number: order.order_number,
            status: order.status,
            payment_status: order.payment_status,
            currency_code: order.currency_code,
            total_minor: order.total_minor,
            created_at: order.created_at,
          });
        }

        // Batch 1: signed server-side packages read for a site's own
        // product (scope catalog.read). Same published-only projection as
        // the public packages list, behind HMAC authentication.
        const mServerPackages = matchPath(
          "/api/v1/integrations/sites/:siteKey/products/:productSlug/packages",
          pathname
        );
        if (method === "GET" && mServerPackages) {
          const { siteKey, productSlug } = mServerPackages.params as {
            siteKey: string;
            productSlug: string;
          };
          const { site } = await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "catalog.read",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: "",
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const product = store.state.products.find(
            (p) => p.slug === productSlug && p.status === "active"
          );
          if (!product || !site.product_ids.includes(product.id)) {
            throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
          }
          const packages = store.state.product_packages
            .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
            .map((pkg) => {
              const publishedVer = store.state.package_versions.find(
                (v) => v.id === pkg.current_version_id && v.status === "published"
              );
              if (!publishedVer) return null;
              return {
                package_key: pkg.package_key,
                name: pkg.name,
                description: pkg.description,
                package_version_id: publishedVer.id,
                version_number: publishedVer.version_number,
                features: publishedVer.features.map((f) => ({
                  feature_key: f.feature_key_snapshot,
                  value_type: f.value_type_snapshot,
                  entitlement_value: f.entitlement_value,
                  unit: f.unit_snapshot,
                })),
                prices: store.state.package_prices
                  .filter(
                    (pr) => pr.package_version_id === publishedVer.id && pr.status === "active"
                  )
                  .map((pr) => ({
                    id: pr.id,
                    price_key: pr.price_key,
                    price_kind: pr.price_kind,
                    amount_minor: pr.amount_minor,
                    currency_code: pr.currency_code,
                    interval_unit: pr.interval_unit,
                    interval_count: pr.interval_count,
                    trial_days: pr.trial_days,
                    setup_fee_minor: pr.setup_fee_minor,
                  })),
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);
          return collectionResponse(packages);
        }

        // Batch 1: signed server-side order cancel (scope orders.cancel:own).
        // BOLA: the site can only cancel its own orders. Uses the same
        // transactional core as the admin cancel, so the guards (paid /
        // completed / under-verification) apply identically.
        const mServerOrderCancel = matchPath(
          "/api/v1/integrations/sites/:siteKey/orders/:publicReference/cancel",
          pathname
        );
        if (method === "POST" && mServerOrderCancel) {
          const { siteKey, publicReference } = mServerOrderCancel.params as {
            siteKey: string;
            publicReference: string;
          };
          const rawBodyText = await request.text();
          const { site } = await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "orders.cancel:own",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: rawBodyText,
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const body = (JSON.parse(rawBodyText || "{}")) as { reason?: string };
          const cancelled = await store.withTransaction((state) => {
            const order = state.orders.find(
              (o) => o.public_reference === publicReference && o.integrated_site_id === site.id
            );
            if (!order) {
              throw new AppError("NOT_FOUND", "Order not found for this integrated site.", 404);
            }
            return cancelOrderInTx(state, order, {
              actorType: "integration",
              integratedSiteId: site.id,
              reason: body.reason ?? "Cancelled by integrated site.",
              requestId,
            });
          });
          return jsonResponse({
            public_reference: cancelled.public_reference,
            order_number: cancelled.order_number,
            status: cancelled.status,
            cancelled_at: cancelled.cancelled_at,
          });
        }

        const mServerTracking = matchPath(
          "/api/v1/integrations/sites/:siteKey/tracking/events",
          pathname
        );
        if (method === "POST" && mServerTracking) {
          const siteKey = mServerTracking.params.siteKey!;
          const rawBodyText = await request.text();
          await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "tracking.events.write",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: rawBodyText,
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const res = await ingestExternalTrackingEvent(
            store,
            siteKey,
            JSON.parse(rawBodyText)
          );
          return jsonResponse(res, 202);
        }

        // Customer+Order batch (ADR-0009): lead ingestion from connected
        // websites. Same S2S HMAC auth as the other integration
        // endpoints (scope leads.create) — the brief's "wpi_ Bearer
        // token" does not exist in this codebase; the HMAC scheme is
        // the real one. A Lead tracking event is recorded + queued
        // through the existing pipeline; Meta CAPI delivery itself is
        // a known stub and is never claimed.
        const mServerLeads = matchPath(
          "/api/v1/integrations/sites/:siteKey/leads",
          pathname
        );
        if (method === "POST" && mServerLeads) {
          const siteKey = mServerLeads.params.siteKey!;
          const rawBodyText = await request.text();
          const { site } = await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "leads.create",
            keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
            timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
            nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
            contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
            signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
            method,
            host: url.host,
            rawPathAndQuery: `${url.pathname}${url.search}`,
            rawBody: rawBodyText,
            encryptionKey: env.ENCRYPTION_KEY_V1,
          });
          const result = await ingestLead(store, site, JSON.parse(rawBodyText));
          return jsonResponse(result, result.created ? 201 : 200);
        }
      }

      // 6. Staff Admin API (/api/v1/admin/*)
      if (pathname.startsWith("/api/v1/admin")) {
        // Never allow a public site key to authenticate an admin request
        if (
          request.headers.has("X-StackMate-Site-Key") &&
          !request.headers.has("Cookie") &&
          !request.headers.has("Authorization")
        ) {
          throw new AppError(
            "FORBIDDEN",
            "Public site keys cannot access staff administration endpoints.",
            403
          );
        }

        const sessionCookie = parseSessionCookie(request.headers.get("Cookie"));
        const bearerToken = extractBearerToken(request.headers.get("Authorization"));

        // CSRF protection for cookie-authenticated state-changing requests
        if (
          sessionCookie &&
          method !== "GET" &&
          method !== "HEAD" &&
          originHeader &&
          !trustedOrigins.includes(originHeader)
        ) {
          throw new AppError(
            "FORBIDDEN",
            `Cross-origin state-changing request from untrusted origin '${originHeader}' blocked by CSRF policy.`,
            403
          );
        }

        const auth = storeSupportsBetterAuth(store)
          ? await getBetterAuth(env, store)
          : null;
        const principal: StaffPrincipal | null = await resolveStaffPrincipal(store, {
          auth,
          cookieHeader: request.headers.get("Cookie"),
          bearerToken,
        });
        if (!principal) {
          throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
        }

        // RESTRICTED SESSION (Auth + Email batch, ADR-0008): when the
        // 2FA policy requires setup and the user has not set it up, the
        // session exists but cannot use the admin API at all — every
        // endpoint returns 403 TWO_FACTOR_SETUP_REQUIRED except
        // GET /api/v1/admin/me (the SPA needs the principal to render the
        // forced-setup wizard) and the /api/auth/* two-factor endpoints
        // (handled above, outside this block). This is enforced here, in
        // the dispatcher, so no route can forget it.
        const isTwoFactorAllowedPath =
          method === "GET" && pathname === "/api/v1/admin/me";
        if (principal.two_factor_setup_required && !isTwoFactorAllowedPath) {
          throw new AppError(
            "TWO_FACTOR_SETUP_REQUIRED",
            "Two-factor authentication setup is required for your role. Complete setup to continue.",
            403
          );
        }

        // Identity & RBAC routes
        if (method === "GET" && pathname === "/api/v1/admin/me") {
          return jsonResponse(principal);
        }

        if (method === "PATCH" && pathname === "/api/v1/admin/me") {
          // Self-service profile: name ONLY. Email is the login identity
          // (administrator change only) and roles are never self-editable
          // — extra fields in the body are ignored, never applied.
          const body = (await request.json()) as { name?: unknown };
          const updated = await updateOwnProfile(store, principal, {
            name: body.name,
            requestId,
          });
          return jsonResponse(updated, 200);
        }

        // Authentication configuration (Auth + Email batch, ADR-0008):
        // OAuth providers, 2FA policy, SMTP — all in Settings, all
        // `users.manage`. Secrets are never returned (only
        // has_client_secret / has_password flags) and never logged;
        // every change is audit-logged by the service layer. A save
        // invalidates this isolate's config cache; other isolates
        // converge within the 30s TTL.
        const requireAuthConfigDb = () => {
          const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb;
          if (!db) {
            throw new AppError(
              "STORE_UNAVAILABLE",
              "Authentication configuration needs a database-backed store.",
              503
            );
          }
          return db as Parameters<typeof loadAuthConfig>[0];
        };
        const authConfigDeps = {
          encryptionKey: env.ENCRYPTION_KEY_V1,
          keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        };
        const authConfigCacheKey = env.HYPERDRIVE_NO_CACHE.connectionString;
        // Audit for config changes (the save functions do not audit
        // themselves). `changes` records WHAT changed, never a secret
        // value. Best-effort: a config save must not fail because the
        // audit write did.
        const auditAuthConfigChange = (
          action: string,
          changes: Record<string, unknown>
        ) =>
          store
            .withTransaction((state) => {
              appendAuditLog(state, {
                actor_type: "staff",
                actor_user_id: principal.user.id,
                action,
                resource_type: "auth_config",
                resource_id: "auth-config",
                outcome: "success",
                request_id: requestId,
                changes,
              });
            })
            .catch(() => {});

        if (method === "GET" && pathname === "/api/v1/admin/auth-config") {
          assertStaffPermission(principal, "users.manage");
          const config = await loadAuthConfig(requireAuthConfigDb(), authConfigDeps);
          // Serialize through the view mapper: the raw ResolvedAuthConfig
          // is camelCase (twoFactorPolicy — the page reads
          // two_factor_policy and crashed) and carries the DECRYPTED
          // OAuth secrets / SMTP password. The view is snake_case and
          // secret-free, with defaults even when nothing is configured.
          return jsonResponse(toAuthConfigView(config));
        }
        if (method === "PUT" && pathname === "/api/v1/admin/auth-config/oauth") {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json().catch(() => ({}))) as {
            provider?: string;
            enabled?: boolean;
            client_id?: string;
            client_secret?: string;
          };
          const saved = await saveOAuthProvider(
            requireAuthConfigDb(),
            authConfigDeps,
            {
              provider: body.provider ?? "",
              enabled: body.enabled ?? false,
              client_id: body.client_id ?? null,
              client_secret: body.client_secret ?? null,
            },
            authConfigCacheKey
          );
          await auditAuthConfigChange("auth.oauth.updated", {
            provider: saved.provider,
            enabled: saved.enabled,
            client_id_changed: Boolean(body.client_id?.trim()),
            client_secret_changed: Boolean(body.client_secret?.trim()),
          });
          return jsonResponse(saved);
        }
        if (
          method === "PUT" &&
          pathname === "/api/v1/admin/auth-config/two-factor-policy"
        ) {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json().catch(() => ({}))) as {
            scope?: string;
            mode?: string;
          };
          const saved = await saveTwoFactorPolicy(
            requireAuthConfigDb(),
            { scope: body.scope ?? "", mode: body.mode ?? "" },
            authConfigCacheKey
          );
          await auditAuthConfigChange("auth.two_factor_policy.updated", {
            scope: body.scope,
            mode: body.mode,
          });
          return jsonResponse(saved);
        }
        if (method === "PUT" && pathname === "/api/v1/admin/auth-config/smtp") {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json().catch(() => ({}))) as {
            host?: string;
            port?: number;
            username?: string;
            password?: string;
            tls_mode?: string;
            from_address?: string;
            from_name?: string;
            enabled?: boolean;
          };
          const saved = await saveSmtpSettings(
            requireAuthConfigDb(),
            authConfigDeps,
            {
              ...(body.host !== undefined ? { host: body.host } : {}),
              ...(body.port !== undefined ? { port: body.port } : {}),
              ...(body.username !== undefined ? { username: body.username } : {}),
              password: body.password ?? null,
              ...(body.tls_mode !== undefined ? { tls_mode: body.tls_mode } : {}),
              ...(body.from_address !== undefined ? { from_address: body.from_address } : {}),
              ...(body.from_name !== undefined ? { from_name: body.from_name } : {}),
              ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            },
            authConfigCacheKey
          );
          await auditAuthConfigChange("auth.smtp.updated", {
            host: saved.host,
            port: saved.port,
            tls_mode: saved.tls_mode,
            from_address: saved.from_address,
            enabled: saved.enabled,
            password_changed: Boolean(body.password?.trim()),
          });
          return jsonResponse(saved);
        }
        if (method === "POST" && pathname === "/api/v1/admin/auth-config/smtp/test") {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json().catch(() => ({}))) as { to?: string };
          // Test mail goes ONLY to the admin's own address — the
          // endpoint must never become an open mail relay.
          const to = (body.to ?? principal.user.email).trim().toLowerCase();
          if (to !== principal.user.email.toLowerCase()) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Test email can only be sent to your own address.",
              422
            );
          }
          const result = await sendEmailViaSmtp(store, env, {
            to,
            ...buildTestEmail(),
          });
          if (!result.sent) {
            throw new AppError(
              "INTERNAL_ERROR",
              result.error ?? "Test email could not be sent.",
              502
            );
          }
          return jsonResponse({ sent: true, to });
        }

        // General Settings (Auth + Email batch, owner order 2026-11-16):
        // the app-wide configuration from Settings → General. All
        // runtime-applied — a save reaches the UI immediately, no
        // redeploy. Audit-logged; the favicon upload reuses the R2
        // validated-object pattern (server-side key, magic-byte check).
        const requireGeneralSettingsDb = () => {
          const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
          if (!maybeDrizzle.drizzleDb) {
            throw new AppError("STORE_UNAVAILABLE", "General settings require a database.", 503);
          }
          return maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0];
        };
        const auditGeneralSettingsChange = (changes: Record<string, unknown>) =>
          store
            .withTransaction((state) => {
              appendAuditLog(state, {
                actor_type: "staff",
                actor_user_id: principal.user.id,
                action: "general.settings.updated",
                resource_type: "general_settings",
                resource_id: "general-settings",
                outcome: "success",
                request_id: requestId,
                changes,
              });
            })
            .catch(() => {});
        if (method === "GET" && pathname === "/api/v1/admin/general-settings") {
          assertStaffPermission(principal, "users.manage");
          const row = await loadGeneralSettings(requireGeneralSettingsDb());
          return jsonResponse(row ? { ...publicViewOf(row), favicon_content_type: row.faviconContentType, favicon_byte_size: row.faviconByteSize } : { ...DEFAULT_GENERAL_SETTINGS, favicon_content_type: null, favicon_byte_size: null });
        }
        if (method === "PUT" && pathname === "/api/v1/admin/general-settings") {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json().catch(() => ({}))) as {
            app_name?: string;
            app_title?: string;
            app_description?: string;
            support_email?: string;
            clear_favicon?: boolean;
          };
          const saved = await saveGeneralSettings(requireGeneralSettingsDb(), body);
          const changes: Record<string, unknown> = {};
          if (body.app_name !== undefined) changes.app_name = body.app_name.trim();
          if (body.app_title !== undefined) changes.app_title = body.app_title.trim();
          if (body.app_description !== undefined) changes.app_description = body.app_description;
          if (body.support_email !== undefined) changes.support_email = body.support_email.trim();
          if (body.clear_favicon === true) changes.favicon_cleared = true;
          await auditGeneralSettingsChange(changes);
          return jsonResponse(saved);
        }
        if (method === "POST" && pathname === "/api/v1/admin/general-settings/favicon") {
          assertStaffPermission(principal, "users.manage");
          const body = (await request.json()) as {
            filename?: string;
            content_type?: string;
            content_base64?: string;
          };
          if (!body.filename || !body.content_type || !body.content_base64) {
            throw new AppError(
              "VALIDATION_ERROR",
              "filename, content_type, and content_base64 are required.",
              422
            );
          }
          // Fail closed in staging/production: the favicon must land in
          // the real R2 bucket, not the in-memory bucket (same rule as
          // payment evidence — it would be lost on restart and invisible
          // to every other instance).
          const maybeBucket = store as unknown as { usesInMemoryBucket?: boolean };
          if (
            (env.APP_ENV === "production" || env.APP_ENV === "staging") &&
            maybeBucket.usesInMemoryBucket
          ) {
            throw new AppError(
              "INTERNAL_ERROR",
              "Favicon upload is unavailable: no real R2 bucket is configured for this environment.",
              503
            );
          }
          const bucket = (store as unknown as { r2Bucket?: unknown }).r2Bucket as
            | import("./env.ts").R2BucketBinding
            | undefined;
          if (!bucket) {
            throw new AppError("INTERNAL_ERROR", "No R2 bucket is configured for this environment.", 503);
          }
          const bytes = new Uint8Array(Buffer.from(body.content_base64, "base64"));
          const stored = await storeFavicon(requireGeneralSettingsDb(), bucket, {
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: env.R2_BUCKET_NAME,
          });
          await auditGeneralSettingsChange({ favicon_uploaded: true, content_type: stored.content_type });
          return jsonResponse(stored, 201);
        }

        if (method === "GET" && pathname === "/api/v1/admin/users") {
          assertStaffPermission(principal, "users.manage");
          const { q, limit } = parseListQuery(url.searchParams);
          const users = applyListLimit(
            store.state.users
              .filter((u) => includesQuery(u.name, q) || includesQuery(u.email, q))
              .map((u) => {
                const roleIds = new Set(
                  store.state.user_roles.filter((ur) => ur.user_id === u.id).map((ur) => ur.role_id)
                );
                const roleKeys = store.state.roles
                  .filter((r) => roleIds.has(r.id))
                  .map((r) => r.key);
                return {
                  id: u.id,
                  name: u.name,
                  email: u.email,
                  status: u.status,
                  roles: roleKeys,
                  created_at: u.created_at,
                  created_date_display: formatDisplayDateDDMMYYYY(u.created_at, env.DEFAULT_TIMEZONE),
                };
              }),
            limit,
          );
          return collectionResponse(users);
        }

        if (method === "POST" && pathname === "/api/v1/admin/users") {
          const body = (await request.json()) as {
            name: string;
            email: string;
            password: string;
            role_keys: string[];
          };
          const created = await createStaffUserByAdmin(store, principal, {
            ...body,
            requestId,
          });
          // Provision the Better Auth identity for the same email (best
          // effort — first sign-in lazily migrates if this fails).
          if (storeSupportsBetterAuth(store)) {
            await ensureBetterAuthIdentity(store, {
              userId: created.user.id,
              email: body.email,
              password: body.password,
            }).catch(() => {});
          }
          return jsonResponse(created, 201);
        }

        const mUserRoles = matchPath("/api/v1/admin/users/:userId/roles", pathname);
        if (method === "PUT" && mUserRoles) {
          const body = (await request.json()) as { role_keys: string[] };
          const updated = await updateStaffUserRoles(
            store,
            principal,
            mUserRoles.params.userId!,
            body.role_keys ?? [],
            requestId
          );
          return jsonResponse(updated);
        }

        if (method === "GET" && pathname === "/api/v1/admin/roles") {
          assertStaffPermission(principal, "users.manage");
          return collectionResponse(store.state.roles);
        }

        if (method === "GET" && pathname === "/api/v1/admin/permissions") {
          return collectionResponse([...store.allPermissions]);
        }

        // Batch 1: Roles & staff invitations.
        // NOTE (API Spec §8 vs seed catalogue): the spec names
        // users.invite / roles.create / roles.update, but those keys do
        // NOT exist in the seeded permission catalogue — the existing
        // users.manage key ("Manage staff users, roles, and permissions")
        // is the equivalent gate and is used for all role + invitation
        // writes. No email is sent for invitations (there is no email
        // system yet — Batch 5); the one-time token is returned once so
        // an admin can deliver the accept link out of band.
        if (method === "POST" && pathname === "/api/v1/admin/roles") {
          const body = await request.json();
          const created = await createRoleByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mRoleDetail = matchPath("/api/v1/admin/roles/:roleId", pathname);
        if (method === "PATCH" && mRoleDetail) {
          const body = await request.json();
          const updated = await updateRoleByAdmin(
            store,
            principal,
            mRoleDetail.params.roleId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        if (method === "GET" && pathname === "/api/v1/admin/users/invitations") {
          assertStaffPermission(principal, "users.manage");
          const items = (store.state.staff_invitations ?? []).map((inv) => {
            const { token_hash: _h, ...safe } = inv;
            return safe;
          });
          return collectionResponse(items);
        }

        if (method === "POST" && pathname === "/api/v1/admin/users/invitations") {
          const body = await request.json();
          const created = await createStaffInvitationByAdmin(store, principal, body, requestId);
          // Invitation email (Auth + Email batch): best-effort — the
          // token_once return is unchanged and stays the delivery path
          // when email is not configured. `email_sent` / `email_error`
          // are honest: a failed send is reported, never hidden.
          let emailSent = false;
          let emailError: string | undefined;
          try {
            const result = await sendEmailViaSmtp(store, env, {
              to: created.invitation.email,
              ...buildInvitationEmail(env.APP_URL, created.token_once, created.invitation.role_keys),
            });
            emailSent = result.sent;
            emailError = result.error;
          } catch {
            emailError = "Email is not configured. Copy the invitation link manually.";
          }
          return jsonResponse(
            { ...created, email_sent: emailSent, email_error: emailError },
            201
          );
        }

        const mInvitationRevoke = matchPath(
          "/api/v1/admin/users/invitations/:invitationId/revoke",
          pathname
        );
        if (method === "POST" && mInvitationRevoke) {
          const revoked = await revokeStaffInvitationByAdmin(
            store,
            principal,
            mInvitationRevoke.params.invitationId!,
            requestId
          );
          return jsonResponse(revoked);
        }

        const mUserDetail = matchPath("/api/v1/admin/users/:userId", pathname);
        if (method === "GET" && mUserDetail) {
          assertStaffPermission(principal, "users.manage");
          const user = store.state.users.find((u) => u.id === mUserDetail.params.userId);
          if (!user) throw new AppError("NOT_FOUND", "User not found.", 404);
          const roleIds = new Set(
            store.state.user_roles.filter((ur) => ur.user_id === user.id).map((ur) => ur.role_id)
          );
          const roleKeys = store.state.roles
            .filter((r) => roleIds.has(r.id))
            .map((r) => r.key);
          return jsonResponse({
            id: user.id,
            name: user.name,
            email: user.email,
            status: user.status,
            roles: roleKeys,
            created_at: user.created_at,
            created_date_display: formatDisplayDateDDMMYYYY(user.created_at, env.DEFAULT_TIMEZONE),
          });
        }

        // Products, Features, Packages & Prices
        if (method === "GET" && pathname === "/api/v1/admin/products") {
          assertStaffPermission(principal, "products.read");
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.products
              .filter(
                (p) => includesQuery(p.name, q) || includesQuery(p.code, q),
              )
              .map((p) => ({
                ...p,
                features_count: store.state.product_features.filter(
                  (f) => f.product_id === p.id,
                ).length,
                packages_count: store.state.product_packages.filter(
                  (pkg) => pkg.product_id === p.id,
                ).length,
                created_date_display: formatDisplayDateDDMMYYYY(
                  p.created_at,
                  env.DEFAULT_TIMEZONE,
                ),
              })),
            limit,
          );
          return collectionResponse(items);
        }

        if (method === "POST" && pathname === "/api/v1/admin/products") {
          const body = await request.json();
          const created = await createProduct(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mProductDetail = matchPath("/api/v1/admin/products/:productId", pathname);
        if (method === "GET" && mProductDetail) {
          assertStaffPermission(principal, "products.read");
          const product = store.state.products.find(
            (p) => p.id === mProductDetail.params.productId
          );
          if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
          return jsonResponse({
            ...product,
            features: store.state.product_features.filter((f) => f.product_id === product.id),
            packages: store.state.product_packages.filter((pkg) => pkg.product_id === product.id),
          });
        }

        if (method === "PATCH" && mProductDetail) {
          const body = await request.json();
          const updated = await updateProductMetadata(
            store,
            principal,
            mProductDetail.params.productId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mProductPublish = matchPath("/api/v1/admin/products/:productId/publish", pathname);
        if (method === "POST" && mProductPublish) {
          const updated = await updateProductStatus(
            store,
            principal,
            mProductPublish.params.productId!,
            "active",
            requestId
          );
          return jsonResponse(updated);
        }

        const mProductArchive = matchPath("/api/v1/admin/products/:productId/archive", pathname);
        if (method === "POST" && mProductArchive) {
          const updated = await updateProductStatus(
            store,
            principal,
            mProductArchive.params.productId!,
            "archived",
            requestId
          );
          return jsonResponse(updated);
        }

        const mProductFeatures = matchPath("/api/v1/admin/products/:productId/features", pathname);
        if (method === "GET" && mProductFeatures) {
          assertStaffPermission(principal, "products.read");
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.product_features
              .filter((f) => f.product_id === mProductFeatures.params.productId)
              .filter((f) => includesQuery(f.name, q) || includesQuery(f.feature_key, q))
              .map((f) => withFeatureUsage(store.state, f)),
            limit,
          );
          return collectionResponse(items);
        }

        if (method === "POST" && mProductFeatures) {
          const body = await request.json();
          const created = await createProductFeature(
            store,
            principal,
            mProductFeatures.params.productId!,
            body,
            requestId
          );
          return jsonResponse(withFeatureUsage(store.state, created), 201);
        }

        // Bulk create — one or more features at once under one product.
        // Registered before the :featureId detail routes: matchPath is
        // exact-segment, so POST /features/bulk would otherwise fall
        // through to the detail matcher (featureId = "bulk").
        const mProductFeaturesBulk = matchPath(
          "/api/v1/admin/products/:productId/features/bulk",
          pathname,
        );
        if (method === "POST" && mProductFeaturesBulk) {
          const body = await request.json();
          const result = await createProductFeaturesBulk(
            store,
            principal,
            mProductFeaturesBulk.params.productId!,
            body,
            requestId,
          );
          return jsonResponse(result, 201);
        }

        const mProductPackages = matchPath("/api/v1/admin/products/:productId/packages", pathname);
        if (method === "GET" && mProductPackages) {
          assertStaffPermission(principal, "products.read");
          const { q, limit } = parseListQuery(url.searchParams);
          const pkgs = applyListLimit(
            store.state.product_packages
              .filter((p) => p.product_id === mProductPackages.params.productId)
              .filter((p) => includesQuery(p.name, q))
              .map((p) => ({
                ...p,
                versions: store.state.package_versions
                  .filter((v) => v.package_id === p.id)
                  .map((v) => ({
                    ...v,
                    prices: store.state.package_prices.filter(
                      (pr) => pr.package_version_id === v.id,
                    ),
                  })),
              })),
            limit,
          );
          return collectionResponse(pkgs);
        }

        if (method === "POST" && mProductPackages) {
          const body = await request.json();
          const created = await createProductPackageWithDraftVersion(
            store,
            principal,
            mProductPackages.params.productId!,
            body,
            requestId
          );
          return jsonResponse(created, 201);
        }

        const mPkgVersions = matchPath("/api/v1/admin/packages/:packageId/versions", pathname);
        if (method === "POST" && mPkgVersions) {
          const body = (await request.json()) as {
            features: Array<{ product_feature_id: string; entitlement_value: unknown }>;
            change_summary?: string;
          };
          const created = await createNewPackageVersion(
            store,
            principal,
            mPkgVersions.params.packageId!,
            body,
            requestId
          );
          return jsonResponse(created, 201);
        }

        const mVerDetail = matchPath("/api/v1/admin/package-versions/:versionId", pathname);
        if (method === "GET" && mVerDetail) {
          assertStaffPermission(principal, "products.read");
          const ver = store.state.package_versions.find(
            (v) => v.id === mVerDetail.params.versionId
          );
          if (!ver) throw new AppError("NOT_FOUND", "Package version not found.", 404);
          return jsonResponse({
            ...ver,
            prices: store.state.package_prices.filter((pr) => pr.package_version_id === ver.id),
          });
        }

        const mVerPublish = matchPath(
          "/api/v1/admin/package-versions/:versionId/publish",
          pathname
        );
        if (method === "POST" && mVerPublish) {
          const published = await publishPackageVersion(
            store,
            principal,
            mVerPublish.params.versionId!,
            requestId
          );
          return jsonResponse(published);
        }

        const mVerPrices = matchPath(
          "/api/v1/admin/package-versions/:versionId/prices",
          pathname
        );
        if (method === "GET" && mVerPrices) {
          assertStaffPermission(principal, "products.read");
          const prices = store.state.package_prices.filter(
            (pr) => pr.package_version_id === mVerPrices.params.versionId
          );
          return collectionResponse(prices);
        }

        if (method === "POST" && mVerPrices) {
          const body = await request.json();
          const created = await createPackagePrice(
            store,
            principal,
            mVerPrices.params.versionId!,
            body,
            requestId
          );
          return jsonResponse(created, 201);
        }

        // Batch 1: feature / package / price detail + lifecycle writes.
        const mFeatureDetail = matchPath(
          "/api/v1/admin/products/:productId/features/:featureId",
          pathname
        );
        if (method === "GET" && mFeatureDetail) {
          assertStaffPermission(principal, "products.read");
          const feature = store.state.product_features.find(
            (f) =>
              f.id === mFeatureDetail.params.featureId &&
              f.product_id === mFeatureDetail.params.productId
          );
          if (!feature) throw new AppError("NOT_FOUND", "Product feature not found.", 404);
          return jsonResponse(withFeatureUsage(store.state, feature));
        }

        if (method === "PATCH" && mFeatureDetail) {
          const body = await request.json();
          const updated = await updateProductFeatureByAdmin(
            store,
            principal,
            mFeatureDetail.params.productId!,
            mFeatureDetail.params.featureId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mFeatureArchive = matchPath(
          "/api/v1/admin/products/:productId/features/:featureId/archive",
          pathname
        );
        if (method === "POST" && mFeatureArchive) {
          const archived = await archiveProductFeatureByAdmin(
            store,
            principal,
            mFeatureArchive.params.productId!,
            mFeatureArchive.params.featureId!,
            requestId
          );
          return jsonResponse(archived);
        }

        const mPackageDetail = matchPath("/api/v1/admin/packages/:packageId", pathname);
        if (method === "GET" && mPackageDetail) {
          assertStaffPermission(principal, "products.read");
          const pkg = store.state.product_packages.find(
            (p) => p.id === mPackageDetail.params.packageId
          );
          if (!pkg) throw new AppError("NOT_FOUND", "Package not found.", 404);
          return jsonResponse({
            ...pkg,
            versions: store.state.package_versions
              .filter((v) => v.package_id === pkg.id)
              .map((v) => ({
                ...v,
                prices: store.state.package_prices.filter(
                  (pr) => pr.package_version_id === v.id
                ),
              })),
          });
        }

        if (method === "PATCH" && mPackageDetail) {
          const body = await request.json();
          const updated = await updateProductPackageByAdmin(
            store,
            principal,
            mPackageDetail.params.packageId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mVerRetire = matchPath(
          "/api/v1/admin/package-versions/:versionId/retire",
          pathname
        );
        if (method === "POST" && mVerRetire) {
          const retired = await retirePackageVersionByAdmin(
            store,
            principal,
            mVerRetire.params.versionId!,
            requestId
          );
          return jsonResponse(retired);
        }

        const mPriceDetail = matchPath("/api/v1/admin/prices/:priceId", pathname);
        if (method === "GET" && mPriceDetail) {
          assertStaffPermission(principal, "products.read");
          const price = store.state.package_prices.find(
            (pr) => pr.id === mPriceDetail.params.priceId
          );
          if (!price) throw new AppError("NOT_FOUND", "Package price not found.", 404);
          return jsonResponse(price);
        }

        if (method === "PATCH" && mPriceDetail) {
          const body = await request.json();
          const updated = await updatePackagePriceByAdmin(
            store,
            principal,
            mPriceDetail.params.priceId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mPriceDisable = matchPath("/api/v1/admin/prices/:priceId/disable", pathname);
        if (method === "POST" && mPriceDisable) {
          const disabled = await disablePackagePriceByAdmin(
            store,
            principal,
            mPriceDisable.params.priceId!,
            requestId
          );
          return jsonResponse(disabled);
        }

        // Global search (PLAN §29 / ADR-0010): the header search bar.
        // Any staff session may call it; each group is gated by the
        // caller's own permissions inside searchGlobal, so a caller
        // without orders.read simply gets no Orders group — never a 403
        // for the whole search.
        if (method === "GET" && pathname === "/api/v1/admin/search") {
          if (!principal) {
            throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
          }
          const q = url.searchParams.get("q") ?? "";
          return jsonResponse({
            query: q.trim(),
            groups: searchGlobal(store.state, principal, q),
          });
        }

        // Customers, Orders & Invoices
        if (method === "GET" && pathname === "/api/v1/admin/customers") {
          assertStaffPermission(principal, "customers.read");
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.customers
              .filter(
                (c) =>
                  includesQuery(c.name, q) ||
                  includesQuery(c.email, q) ||
                  includesQuery(c.customer_number, q) ||
                  includesQuery(c.company_name, q) ||
                  matchesPhoneQuery(c.phone, c.normalized_phone, q),
              )
              .map((c) => ({
                ...c,
                // Staff-report flag (ADR-0009): a warning badge when a concern
                // report exists; the count lets the list row show it plainly.
                report_count: store.state.customer_reports.filter(
                  (r) => r.customer_id === c.id,
                ).length,
                has_concern_report: store.state.customer_reports.some(
                  (r) => r.customer_id === c.id && r.type === "concern",
                ),
                created_date_display: formatDisplayDateDDMMYYYY(
                  c.created_at,
                  env.DEFAULT_TIMEZONE,
                ),
              })),
            limit,
          );
          return collectionResponse(items);
        }

        if (method === "POST" && pathname === "/api/v1/admin/customers") {
          const body = await request.json();
          const customer = await createCustomerByAdmin(store, principal, body, requestId);
          return jsonResponse(customer, 201);
        }

        const mCustDetail = matchPath("/api/v1/admin/customers/:customerId", pathname);
        if (method === "GET" && mCustDetail) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustDetail.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          // Per-order billed/paid/due (owner 2026-11-17): every order row
          // carries its own three amounts, computed from verified payments.
          const customerOrders = store.state.orders
            .filter((o) => o.customer_id === customer.id)
            .map((o) => ({
              ...o,
              paid_amount_minor: computeOrderPaid(store.state, o.id),
              remaining_minor: computeOrderRemaining(store.state, o),
            }));
          const orderIds = new Set(customerOrders.map((o) => o.id));
          const subIds = new Set(
            store.state.subscriptions
              .filter((s) => s.customer_id === customer.id)
              .map((s) => s.id)
          );
          const licenseIds = new Set(
            store.state.licenses
              .filter((l) => l.customer_id === customer.id)
              .map((l) => l.id)
          );
          // Activity history: audit rows touching the customer or any of
          // their orders/subscriptions/licenses, newest first (max 100).
          const activity = store.state.audit_logs
            .filter(
              (a) =>
                a.resource_id === customer.id ||
                (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
                (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
                (a.resource_type === "license" && licenseIds.has(a.resource_id))
            )
            .slice(-100)
            .reverse();
          // Payments tab shape (live defect 2026-11-17): the detail
          // must return { submissions, transactions } — the same shape
          // as GET /customers/:id/payments — NOT a bare submissions
          // array. The UI reads customer.payments.submissions.length
          // as the tab-count fallback while the sub-query is pending;
          // a bare array made that read throw "Cannot read properties
          // of undefined (reading 'length')" on first load of a fresh
          // customer (warm cache on reload hid it — hence intermittent).
          // Filtered by the customer's orders only, like the
          // sub-endpoint (the old filter also included any submission
          // with ANY transaction, even for another customer's order).
          const paymentSubmissions = store.state.payment_submissions.filter((s) =>
            orderIds.has(s.order_id)
          );
          const paymentSubmissionIds = new Set(paymentSubmissions.map((s) => s.id));
          return jsonResponse({
            ...customer,
            financials: computeCustomerFinancials(store.state, customer.id),
            contacts: store.state.customer_contacts.filter(
              (cc) => cc.customer_id === customer.id
            ),
            addresses: store.state.customer_addresses
              .filter((a) => a.customer_id === customer.id)
              .map(toCustomerAddressDto),
            reports: store.state.customer_reports
              .filter((r) => r.customer_id === customer.id)
              .map((r) => ({
                ...r,
                author_name:
                  store.state.users.find((u) => u.id === r.author_user_id)?.name ?? null,
              })),
            orders: customerOrders,
            subscriptions: store.state.subscriptions.filter((s) => s.customer_id === customer.id),
            licenses: store.state.licenses.filter((l) => l.customer_id === customer.id),
            payments: {
              submissions: paymentSubmissions,
              transactions: store.state.payment_transactions.filter(
                (t) =>
                  t.payment_submission_id !== null &&
                  paymentSubmissionIds.has(t.payment_submission_id)
              ),
            },
            installations: store.state.licenses
              .filter((l) => l.customer_id === customer.id)
              .flatMap((l) =>
                l.activations.map((a) => ({
                  ...a,
                  license_number: l.license_number,
                  product_id: l.product_id,
                }))
              ),
            tickets: store.state.support_tickets.filter(
              (t) => t.customer_id === customer.id
            ),
            activity,
          });
        }

        if (method === "GET" && pathname === "/api/v1/admin/orders") {
          assertStaffPermission(principal, "orders.read");
          const statusFilter = url.searchParams.get("payment_status");
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.orders
              .filter((o) => (!statusFilter ? true : o.payment_status === statusFilter))
              .filter(
                (o) =>
                  includesQuery(o.order_number, q) ||
                  includesQuery(o.public_reference, q) ||
                  includesQuery(
                    store.state.customers.find((c) => c.id === o.customer_id)?.name,
                    q,
                  ),
              )
              .map((o) => ({
                ...o,
                customer: store.state.customers.find((c) => c.id === o.customer_id) ?? null,
                // Paid/remaining are computed from verified payments
                // (ADR-0009) — never denormalized, so they cannot drift.
                paid_amount_minor: computeOrderPaid(store.state, o.id),
                remaining_minor: computeOrderRemaining(store.state, o),
                created_date_display: formatDisplayDateDDMMYYYY(
                  o.created_at,
                  env.DEFAULT_TIMEZONE,
                ),
              })),
            limit,
          );
          return collectionResponse(items);
        }

        if (method === "POST" && pathname === "/api/v1/admin/orders") {
          const body = await request.json();
          const created = await createOrderByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mOrderAdminDetail = matchPath("/api/v1/admin/orders/:orderId", pathname);
        if (method === "GET" && mOrderAdminDetail) {
          assertStaffPermission(principal, "orders.read");
          const order = store.state.orders.find((o) => o.id === mOrderAdminDetail.params.orderId);
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          return jsonResponse({
            ...order,
            customer: store.state.customers.find((c) => c.id === order.customer_id) ?? null,
            paid_amount_minor: computeOrderPaid(store.state, order.id),
            remaining_minor: computeOrderRemaining(store.state, order),
            installments: store.state.order_installments
              .filter((i) => i.order_id === order.id)
              .sort((a, b) => a.installment_number - b.installment_number)
              .map((i) => ({
                ...i,
                due_date_display: formatDisplayDateDDMMYYYY(
                  `${i.due_date}T00:00:00.000Z`,
                  env.DEFAULT_TIMEZONE
                ),
              })),
            invoices: store.state.invoices.filter((i) => i.order_id === order.id),
            payment_submissions: store.state.payment_submissions.filter(
              (s) => s.order_id === order.id
            ),
          });
        }

        if (method === "GET" && pathname === "/api/v1/admin/invoices") {
          assertStaffPermission(principal, "orders.read");
          return collectionResponse(store.state.invoices);
        }

        // Batch 1: customer update + per-customer collections.
        // (Customer detail already embeds orders/subscriptions/licenses;
        // these filtered collections are the list views the SPA needs.)
        if (method === "PATCH" && mCustDetail) {
          const body = await request.json();
          const updated = await updateCustomerByAdmin(
            store,
            principal,
            mCustDetail.params.customerId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mCustOrders = matchPath("/api/v1/admin/customers/:customerId/orders", pathname);
        if (method === "GET" && mCustOrders) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustOrders.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          return collectionResponse(
            store.state.orders
              .filter((o) => o.customer_id === customer.id)
              .map((o) => ({
                ...o,
                paid_amount_minor: computeOrderPaid(store.state, o.id),
                remaining_minor: computeOrderRemaining(store.state, o),
              }))
          );
        }

        const mCustSubs = matchPath(
          "/api/v1/admin/customers/:customerId/subscriptions",
          pathname
        );
        if (method === "GET" && mCustSubs) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustSubs.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          return collectionResponse(
            store.state.subscriptions.filter((s) => s.customer_id === customer.id)
          );
        }

        const mCustLicenses = matchPath(
          "/api/v1/admin/customers/:customerId/licenses",
          pathname
        );
        if (method === "GET" && mCustLicenses) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustLicenses.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          return collectionResponse(
            store.state.licenses
              .filter((l) => l.customer_id === customer.id)
              .map(({ license_key_hash: _h, issued_raw_key_once: _r, ...safe }) => safe)
          );
        }

        // Customer+Order batch (ADR-0009): addresses, reports, split,
        // payments, installations, activity, issues — the four missing
        // detail tabs (PRD §9) plus the dedupe/split/report APIs.
        const mCustAddresses = matchPath(
          "/api/v1/admin/customers/:customerId/addresses",
          pathname
        );
        if (method === "GET" && mCustAddresses) {
          assertStaffPermission(principal, "customers.read");
          return collectionResponse(
            await listCustomerAddresses(store, principal, mCustAddresses.params.customerId!)
          );
        }
        if (method === "POST" && mCustAddresses) {
          const body = await request.json();
          const address = await createCustomerAddressByAdmin(
            store,
            principal,
            mCustAddresses.params.customerId!,
            body,
            requestId
          );
          return jsonResponse(address, 201);
        }
        const mCustAddressDetail = matchPath(
          "/api/v1/admin/customers/:customerId/addresses/:addressId",
          pathname
        );
        if (method === "PATCH" && mCustAddressDetail) {
          const body = await request.json();
          const address = await updateCustomerAddressByAdmin(
            store,
            principal,
            mCustAddressDetail.params.customerId!,
            mCustAddressDetail.params.addressId!,
            body,
            requestId
          );
          return jsonResponse(address);
        }
        if (method === "DELETE" && mCustAddressDetail) {
          await deleteCustomerAddressByAdmin(
            store,
            principal,
            mCustAddressDetail.params.customerId!,
            mCustAddressDetail.params.addressId!,
            requestId
          );
          return jsonResponse({ deleted: true });
        }

        const mCustReports = matchPath(
          "/api/v1/admin/customers/:customerId/reports",
          pathname
        );
        if (method === "GET" && mCustReports) {
          assertStaffPermission(principal, "customers.read");
          return collectionResponse(
            await listCustomerReports(store, principal, mCustReports.params.customerId!)
          );
        }
        if (method === "POST" && mCustReports) {
          const body = await request.json();
          const report = await createCustomerReportByAdmin(
            store,
            principal,
            mCustReports.params.customerId!,
            body,
            requestId
          );
          return jsonResponse(report, 201);
        }

        const mCustSplit = matchPath(
          "/api/v1/admin/customers/:customerId/split-contact",
          pathname
        );
        if (method === "POST" && mCustSplit) {
          const body = await request.json();
          const result = await splitCustomerContactByAdmin(
            store,
            principal,
            mCustSplit.params.customerId!,
            body,
            requestId
          );
          return jsonResponse(result, 201);
        }

        const mCustPayments = matchPath(
          "/api/v1/admin/customers/:customerId/payments",
          pathname
        );
        if (method === "GET" && mCustPayments) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustPayments.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          const orderIds = new Set(
            store.state.orders
              .filter((o) => o.customer_id === customer.id)
              .map((o) => o.id)
          );
          const submissions = store.state.payment_submissions.filter((s) =>
            orderIds.has(s.order_id)
          );
          const submissionIds = new Set(submissions.map((s) => s.id));
          return jsonResponse({
            submissions,
            transactions: store.state.payment_transactions.filter((t) =>
              t.payment_submission_id !== null &&
              submissionIds.has(t.payment_submission_id)
            ),
          });
        }

        const mCustInstallations = matchPath(
          "/api/v1/admin/customers/:customerId/installations",
          pathname
        );
        if (method === "GET" && mCustInstallations) {
          assertStaffPermission(principal, "customers.read");
          return collectionResponse(
            store.state.licenses
              .filter((l) => l.customer_id === mCustInstallations.params.customerId)
              .flatMap((l) =>
                l.activations.map((a) => ({
                  ...a,
                  license_number: l.license_number,
                  product_id: l.product_id,
                }))
              )
          );
        }

        const mCustActivity = matchPath(
          "/api/v1/admin/customers/:customerId/activity",
          pathname
        );
        if (method === "GET" && mCustActivity) {
          assertStaffPermission(principal, "customers.read");
          const customer = store.state.customers.find(
            (c) => c.id === mCustActivity.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          const orderIds = new Set(
            store.state.orders
              .filter((o) => o.customer_id === customer.id)
              .map((o) => o.id)
          );
          const subIds = new Set(
            store.state.subscriptions
              .filter((s) => s.customer_id === customer.id)
              .map((s) => s.id)
          );
          const licenseIds = new Set(
            store.state.licenses
              .filter((l) => l.customer_id === customer.id)
              .map((l) => l.id)
          );
          return collectionResponse(
            store.state.audit_logs
              .filter(
                (a) =>
                  a.resource_id === customer.id ||
                  (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
                  (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
                  (a.resource_type === "license" && licenseIds.has(a.resource_id))
              )
              .slice(-100)
              .reverse()
          );
        }

        const mCustTickets = matchPath(
          "/api/v1/admin/customers/:customerId/tickets",
          pathname
        );
        if (method === "GET" && mCustTickets) {
          assertStaffPermission(principal, "tickets.view");
          return collectionResponse(
            store.state.support_tickets.filter(
              (t) => t.customer_id === mCustTickets.params.customerId
            )
          );
        }

        // Batch 1: order lifecycle + invoice writes.
        const mOrderCancel = matchPath("/api/v1/admin/orders/:orderId/cancel", pathname);
        if (method === "POST" && mOrderCancel) {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          const cancelled = await cancelOrderByAdmin(
            store,
            principal,
            mOrderCancel.params.orderId!,
            body.reason,
            requestId
          );
          return jsonResponse(cancelled);
        }

        const mOrderComplete = matchPath("/api/v1/admin/orders/:orderId/complete", pathname);
        if (method === "POST" && mOrderComplete) {
          const completed = await completeOrderByAdmin(
            store,
            principal,
            mOrderComplete.params.orderId!,
            requestId
          );
          return jsonResponse(completed);
        }

        const mOrderInvoices = matchPath("/api/v1/admin/orders/:orderId/invoices", pathname);
        if (method === "GET" && mOrderInvoices) {
          assertStaffPermission(principal, "orders.read");
          const order = store.state.orders.find(
            (o) => o.id === mOrderInvoices.params.orderId
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          return collectionResponse(
            store.state.invoices.filter((i) => i.order_id === order.id)
          );
        }

        if (method === "POST" && mOrderInvoices) {
          const invoice = await createInvoiceForOrderByAdmin(
            store,
            principal,
            mOrderInvoices.params.orderId!,
            requestId
          );
          return jsonResponse(invoice, 201);
        }

        // Customer+Order batch (ADR-0009): installment plan read + edits.
        const mOrderInstallments = matchPath(
          "/api/v1/admin/orders/:orderId/installments",
          pathname
        );
        if (method === "GET" && mOrderInstallments) {
          assertStaffPermission(principal, "orders.read");
          const order = store.state.orders.find(
            (o) => o.id === mOrderInstallments.params.orderId
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          return collectionResponse(
            store.state.order_installments
              .filter((i) => i.order_id === order.id)
              .sort((a, b) => a.installment_number - b.installment_number)
              .map((i) => ({
                ...i,
                due_date_display: formatDisplayDateDDMMYYYY(
                  `${i.due_date}T00:00:00.000Z`,
                  env.DEFAULT_TIMEZONE
                ),
              }))
          );
        }
        const mOrderInstallmentDetail = matchPath(
          "/api/v1/admin/orders/:orderId/installments/:installmentId",
          pathname
        );
        if (method === "PATCH" && mOrderInstallmentDetail) {
          const body = await request.json();
          const updated = await updateInstallmentByAdmin(
            store,
            principal,
            mOrderInstallmentDetail.params.installmentId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mInvoiceDetail = matchPath("/api/v1/admin/invoices/:invoiceId", pathname);
        if (method === "GET" && mInvoiceDetail) {
          assertStaffPermission(principal, "orders.read");
          const invoice = store.state.invoices.find(
            (i) => i.id === mInvoiceDetail.params.invoiceId
          );
          if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.", 404);
          const order = store.state.orders.find((o) => o.id === invoice.order_id) ?? null;
          return jsonResponse({
            ...invoice,
            order,
            customer: order
              ? (store.state.customers.find((c) => c.id === order.customer_id) ?? null)
              : null,
          });
        }

        const mInvoiceVoid = matchPath("/api/v1/admin/invoices/:invoiceId/void", pathname);
        if (method === "POST" && mInvoiceVoid) {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          const voided = await voidInvoiceByAdmin(
            store,
            principal,
            mInvoiceVoid.params.invoiceId!,
            body.reason,
            requestId
          );
          return jsonResponse(voided);
        }

        // Customer+Order batch (ADR-0009): Support Tickets.
        // Assignee disambiguation (fix batch 2026-11-17, ADR-0009
        // decision 11): two staff can share a name — list + detail embed
        // the assignee's email and role keys next to the name.
        const staffContactFor = (userId: string | null) => {
          if (!userId) return { email: null, roles: [] as string[] };
          const user = store.state.users.find((u) => u.id === userId);
          if (!user) return { email: null, roles: [] as string[] };
          const roleIds = new Set(
            store.state.user_roles.filter((ur) => ur.user_id === user.id).map((ur) => ur.role_id)
          );
          const roles = store.state.roles
            .filter((r) => roleIds.has(r.id))
            .map((r) => r.key);
          return { email: user.email, roles };
        };
        if (method === "GET" && pathname === "/api/v1/admin/tickets") {
          assertStaffPermission(principal, "tickets.view");
          const statusFilter = url.searchParams.get("status");
          const priorityFilter = url.searchParams.get("priority");
          const customerFilter = url.searchParams.get("customer_id");
          const assigneeFilter = url.searchParams.get("assignee_user_id");
          const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
          const { limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.support_tickets
              .filter((t) => (!statusFilter ? true : t.status === statusFilter))
              .filter((t) => (!priorityFilter ? true : t.priority === priorityFilter))
              .filter((t) => (!customerFilter ? true : t.customer_id === customerFilter))
              .filter((t) => (!assigneeFilter ? true : t.assignee_user_id === assigneeFilter))
              .filter((t) =>
                !q
                  ? true
                  : t.ticket_number.toLowerCase().includes(q) ||
                    t.title.toLowerCase().includes(q) ||
                    (t.description ?? "").toLowerCase().includes(q)
              )
              .map((t) => ({
                ...t,
                customer: t.customer_id
                  ? (store.state.customers.find((c) => c.id === t.customer_id) ?? null)
                  : null,
                assignee_name: t.assignee_user_id
                  ? (store.state.users.find((u) => u.id === t.assignee_user_id)?.name ?? null)
                  : null,
                assignee_email: staffContactFor(t.assignee_user_id).email,
                assignee_roles: staffContactFor(t.assignee_user_id).roles,
              })),
            limit,
          );
          return collectionResponse(items);
        }
        if (method === "POST" && pathname === "/api/v1/admin/tickets") {
          const body = await request.json();
          const ticket = await createTicketByAdmin(store, principal, body, requestId);
          return jsonResponse(ticket, 201);
        }
        const mTicketDetail = matchPath("/api/v1/admin/tickets/:ticketId", pathname);
        if (method === "GET" && mTicketDetail) {
          assertStaffPermission(principal, "tickets.view");
          const ticket = store.state.support_tickets.find(
            (t) => t.id === mTicketDetail.params.ticketId
          );
          if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
          const linked = {
            order: ticket.order_id
              ? (store.state.orders.find((o) => o.id === ticket.order_id) ?? null)
              : null,
            subscription: ticket.subscription_id
              ? (store.state.subscriptions.find((s) => s.id === ticket.subscription_id) ?? null)
              : null,
            license: ticket.license_id
              ? (store.state.licenses.find((l) => l.id === ticket.license_id) ?? null)
              : null,
            product: ticket.product_id
              ? (store.state.products.find((p) => p.id === ticket.product_id) ?? null)
              : null,
          };
          return jsonResponse({
            ...ticket,
            customer: ticket.customer_id
              ? (store.state.customers.find((c) => c.id === ticket.customer_id) ?? null)
              : null,
            reporter_name: store.state.users.find((u) => u.id === ticket.reporter_user_id)
              ?.name ?? null,
            assignee_name: ticket.assignee_user_id
              ? (store.state.users.find((u) => u.id === ticket.assignee_user_id)?.name ?? null)
              : null,
            assignee_email: staffContactFor(ticket.assignee_user_id).email,
            assignee_roles: staffContactFor(ticket.assignee_user_id).roles,
            comments: store.state.ticket_comments
              .filter((c) => c.ticket_id === ticket.id)
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((c) => ({
                ...c,
                author_name:
                  store.state.users.find((u) => u.id === c.author_user_id)?.name ?? null,
              })),
            linked,
          });
        }
        if (method === "PATCH" && mTicketDetail) {
          const body = await request.json();
          const updated = await updateTicketByAdmin(
            store,
            principal,
            mTicketDetail.params.ticketId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mTicketTransition = matchPath(
          "/api/v1/admin/tickets/:ticketId/transition",
          pathname
        );
        if (method === "POST" && mTicketTransition) {
          const body = await request.json();
          const updated = await transitionTicketByAdmin(
            store,
            principal,
            mTicketTransition.params.ticketId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mTicketAssign = matchPath(
          "/api/v1/admin/tickets/:ticketId/assign",
          pathname
        );
        if (method === "POST" && mTicketAssign) {
          const body = await request.json();
          const updated = await assignTicketByAdmin(
            store,
            principal,
            mTicketAssign.params.ticketId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mTicketComments = matchPath(
          "/api/v1/admin/tickets/:ticketId/comments",
          pathname
        );
        if (method === "POST" && mTicketComments) {
          const body = await request.json();
          const comment = await addTicketCommentByAdmin(
            store,
            principal,
            mTicketComments.params.ticketId!,
            body,
            requestId
          );
          return jsonResponse(comment, 201);
        }

        // Customer+Order batch (ADR-0009): Leads.
        if (method === "GET" && pathname === "/api/v1/admin/leads") {
          assertStaffPermission(principal, "leads.view");
          const statusFilter = url.searchParams.get("status");
          const siteFilter = url.searchParams.get("source_site_id");
          const campaignFilter = url.searchParams.get("utm_campaign");
          const fromFilter = url.searchParams.get("from");
          const toFilter = url.searchParams.get("to");
          const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
          const { limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.leads
              .filter((l) => (!statusFilter ? true : l.status === statusFilter))
              .filter((l) => (!siteFilter ? true : l.source_site_id === siteFilter))
              .filter((l) => (!campaignFilter ? true : l.utm_campaign === campaignFilter))
              .filter((l) => (!fromFilter ? true : l.created_at.slice(0, 10) >= fromFilter))
              .filter((l) => (!toFilter ? true : l.created_at.slice(0, 10) <= toFilter))
              .filter((l) =>
                !q
                  ? true
                  : l.name.toLowerCase().includes(q) ||
                    (l.email ?? "").toLowerCase().includes(q) ||
                    (l.phone ?? "").includes(q) ||
                    (l.interest ?? "").toLowerCase().includes(q)
              )
              .map((l) => ({
                ...l,
                source_site: l.source_site_id
                  ? (store.state.integrated_sites.find((s) => s.id === l.source_site_id) ?? null)
                  : null,
                assignee_name: l.assignee_user_id
                  ? (store.state.users.find((u) => u.id === l.assignee_user_id)?.name ?? null)
                  : null,
              })),
            limit,
          );
          return collectionResponse(items);
        }
        if (method === "POST" && pathname === "/api/v1/admin/leads") {
          const body = await request.json();
          const lead = await createLeadByAdmin(store, principal, body, requestId);
          return jsonResponse(lead, 201);
        }
        const mLeadDetail = matchPath("/api/v1/admin/leads/:leadId", pathname);
        if (method === "GET" && mLeadDetail) {
          assertStaffPermission(principal, "leads.view");
          const lead = store.state.leads.find((l) => l.id === mLeadDetail.params.leadId);
          if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
          return jsonResponse({
            ...lead,
            source_site: lead.source_site_id
              ? (store.state.integrated_sites.find((s) => s.id === lead.source_site_id) ?? null)
              : null,
            product: lead.product_id
              ? (store.state.products.find((p) => p.id === lead.product_id) ?? null)
              : null,
            assignee_name: lead.assignee_user_id
              ? (store.state.users.find((u) => u.id === lead.assignee_user_id)?.name ?? null)
              : null,
            converted_customer: lead.converted_customer_id
              ? (store.state.customers.find((c) => c.id === lead.converted_customer_id) ?? null)
              : null,
            converted_order: lead.converted_order_id
              ? (store.state.orders.find((o) => o.id === lead.converted_order_id) ?? null)
              : null,
          });
        }
        if (method === "PATCH" && mLeadDetail) {
          const body = await request.json();
          const updated = await updateLeadByAdmin(
            store,
            principal,
            mLeadDetail.params.leadId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mLeadTransition = matchPath(
          "/api/v1/admin/leads/:leadId/transition",
          pathname
        );
        if (method === "POST" && mLeadTransition) {
          const body = await request.json();
          const updated = await transitionLeadByAdmin(
            store,
            principal,
            mLeadTransition.params.leadId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mLeadAssign = matchPath("/api/v1/admin/leads/:leadId/assign", pathname);
        if (method === "POST" && mLeadAssign) {
          const body = await request.json();
          const updated = await assignLeadByAdmin(
            store,
            principal,
            mLeadAssign.params.leadId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }
        const mLeadConvert = matchPath("/api/v1/admin/leads/:leadId/convert", pathname);
        if (method === "POST" && mLeadConvert) {
          const result = await convertLeadByAdmin(
            store,
            principal,
            mLeadConvert.params.leadId!,
            requestId
          );
          return jsonResponse(result);
        }

        // Customer+Order batch (ADR-0009): reminder settings (Settings →
        // Email). Singleton row, direct Drizzle save — same pattern as
        // general_settings. Reads come from the load-only state
        // collection (populated by the store load query). The save is
        // the users.manage gate, like SMTP.
        if (method === "GET" && pathname === "/api/v1/admin/reminder-settings") {
          assertStaffPermission(principal, "users.manage");
          return jsonResponse(getReminderSettings(store.state));
        }
        if (method === "PUT" && pathname === "/api/v1/admin/reminder-settings") {
          assertStaffPermission(principal, "users.manage");
          const body = await request.json();
          const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
            | Parameters<typeof saveReminderSettings>[0]
            | undefined;
          if (!db) {
            throw new AppError(
              "STORE_UNAVAILABLE",
              "Reminder settings require the database store.",
              503
            );
          }
          const saved = await saveReminderSettings(db, body);
          // Best-effort audit (same shape as general settings): the
          // settings save itself already succeeded.
          await store
            .withTransaction((state) => {
              appendAuditLog(state, {
                actor_type: "staff",
                actor_user_id: principal.user.id,
                action: "settings.reminder_settings.updated",
                resource_type: "general_settings",
                resource_id: "reminder-settings",
                outcome: "success",
                request_id: requestId,
                changes: { ...saved },
              });
            })
            .catch(() => {});
          return jsonResponse(saved);
        }

        // Batch 1: staff-recorded manual payment claim + staff evidence
        // upload for an order (Payment Review action). The claim goes
        // through the same validation as a customer claim and lands as
        // pending_verification — it NEVER marks the order paid.
        const mOrderPaySub = matchPath(
          "/api/v1/admin/orders/:orderId/payment-submissions",
          pathname
        );
        if (method === "POST" && mOrderPaySub) {
          const body = await request.json();
          const created = await recordManualPaymentClaimByAdmin(
            store,
            principal,
            mOrderPaySub.params.orderId!,
            body,
            requestId
          );
          return jsonResponse(created, 201);
        }

        const mOrderPayEvidence = matchPath(
          "/api/v1/admin/orders/:orderId/payment-evidence",
          pathname
        );
        if (method === "POST" && mOrderPayEvidence) {
          const body = (await request.json()) as {
            filename: string;
            content_type: string;
            file_base64: string;
          };
          const order = store.state.orders.find(
            (o) => o.id === mOrderPayEvidence.params.orderId
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          if (!body.filename || !body.content_type || !body.file_base64) {
            throw new AppError(
              "VALIDATION_ERROR",
              "filename, content_type, and file_base64 are required.",
              422
            );
          }
          const bytes = Uint8Array.from(Buffer.from(body.file_base64, "base64"));
          const asset = await uploadPrivatePaymentEvidence(store, {
            orderId: order.id,
            customerId: order.customer_id,
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: env.R2_BUCKET_NAME,
          });
          return jsonResponse(asset, 201);
        }

        // Payment Providers, Methods, Submissions & Verification
        if (method === "GET" && pathname === "/api/v1/admin/payment-providers") {
          assertStaffPermission(principal, "payments.read");
          const { q, limit } = parseListQuery(url.searchParams);
          return collectionResponse(
            applyListLimit(
              store.state.payment_providers.filter((p) => includesQuery(p.display_name, q)),
              limit,
            ),
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/payment-methods") {
          assertStaffPermission(principal, "payments.read");
          const { q, limit } = parseListQuery(url.searchParams);
          return collectionResponse(
            applyListLimit(
              store.state.payment_methods.filter((m) => includesQuery(m.display_name, q)),
              limit,
            ),
          );
        }

        if (method === "POST" && pathname === "/api/v1/admin/payment-methods") {
          const body = await request.json();
          const created = await createPaymentMethodByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        // Batch 1: payment provider + method lifecycle writes.
        if (method === "POST" && pathname === "/api/v1/admin/payment-providers") {
          const body = await request.json();
          const created = await createPaymentProviderByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mProviderDetail = matchPath(
          "/api/v1/admin/payment-providers/:providerId",
          pathname
        );
        if (method === "PATCH" && mProviderDetail) {
          const body = await request.json();
          const updated = await updatePaymentProviderByAdmin(
            store,
            principal,
            mProviderDetail.params.providerId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mMethodDetail = matchPath("/api/v1/admin/payment-methods/:methodId", pathname);
        if (method === "GET" && mMethodDetail) {
          assertStaffPermission(principal, "payments.read");
          const methodRec = store.state.payment_methods.find(
            (m) => m.id === mMethodDetail.params.methodId
          );
          if (!methodRec) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
          return jsonResponse(methodRec);
        }

        if (method === "PATCH" && mMethodDetail) {
          const body = await request.json();
          const updated = await updatePaymentMethodByAdmin(
            store,
            principal,
            mMethodDetail.params.methodId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mMethodEnable = matchPath(
          "/api/v1/admin/payment-methods/:methodId/enable",
          pathname
        );
        if (method === "POST" && mMethodEnable) {
          const updated = await setPaymentMethodEnabledByAdmin(
            store,
            principal,
            mMethodEnable.params.methodId!,
            true,
            requestId
          );
          return jsonResponse(updated);
        }

        const mMethodDisable = matchPath(
          "/api/v1/admin/payment-methods/:methodId/disable",
          pathname
        );
        if (method === "POST" && mMethodDisable) {
          const updated = await setPaymentMethodEnabledByAdmin(
            store,
            principal,
            mMethodDisable.params.methodId!,
            false,
            requestId
          );
          return jsonResponse(updated);
        }

        // Batch 1: single submission detail + verification history.
        const mSubmissionDetail = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId",
          pathname
        );
        if (method === "GET" && mSubmissionDetail) {
          assertStaffPermission(principal, "payments.read");
          const sub = store.state.payment_submissions.find(
            (s) => s.id === mSubmissionDetail.params.submissionId
          );
          if (!sub) throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
          const order = store.state.orders.find((o) => o.id === sub.order_id);
          const customer = store.state.customers.find((c) => c.id === sub.customer_id);
          const methodRec = store.state.payment_methods.find(
            (m) => m.id === sub.payment_method_id
          );
          return jsonResponse({
            ...sub,
            order_number: order?.order_number ?? null,
            order_total_minor: order?.total_minor ?? null,
            // ADR-0009: the approve form needs the order's remaining
            // amount and the customer's credit balance to offer
            // apply-credit explicitly (never silent).
            order_remaining_minor: order ? computeOrderRemaining(store.state, order) : null,
            customer_credit_balance_minor: customer?.credit_balance_minor ?? 0,
            customer_name: customer?.name ?? null,
            payment_method_name: methodRec?.display_name ?? null,
            submitted_date_display: formatDisplayDateTimeDDMMYYYY(
              sub.submitted_at,
              env.DEFAULT_TIMEZONE
            ),
            verification_logs: store.state.payment_verification_logs.filter(
              (l) => l.payment_submission_id === sub.id
            ),
          });
        }

        const mSubmissionHistory = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId/history",
          pathname
        );
        if (method === "GET" && mSubmissionHistory) {
          assertStaffPermission(principal, "payments.read");
          const sub = store.state.payment_submissions.find(
            (s) => s.id === mSubmissionHistory.params.submissionId
          );
          if (!sub) throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
          return collectionResponse(
            store.state.payment_verification_logs.filter(
              (l) => l.payment_submission_id === sub.id
            )
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/payment-submissions") {
          assertStaffPermission(principal, "payments.read");
          const statusFilter = url.searchParams.get("status");
          const items = store.state.payment_submissions
            .filter((s) => (!statusFilter ? true : s.status === statusFilter))
            .map((s) => {
              const order = store.state.orders.find((o) => o.id === s.order_id);
              const customer = store.state.customers.find((c) => c.id === s.customer_id);
              const method = store.state.payment_methods.find((m) => m.id === s.payment_method_id);
              return {
                ...s,
                order_number: order?.order_number ?? null,
                order_total_minor: order?.total_minor ?? null,
                customer_name: customer?.name ?? null,
                payment_method_name: method?.display_name ?? null,
                submitted_date_display: formatDisplayDateTimeDDMMYYYY(
                  s.submitted_at,
                  env.DEFAULT_TIMEZONE
                ),
                verification_logs: store.state.payment_verification_logs.filter(
                  (l) => l.payment_submission_id === s.id
                ),
              };
            });
          return collectionResponse(items);
        }

        const mSubmissionApprove = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId/approve",
          pathname
        );
        if (method === "POST" && mSubmissionApprove) {
          const body = await request.json();
          const result = await approvePaymentSubmissionByStaff(
            store,
            principal,
            mSubmissionApprove.params.submissionId!,
            body,
            {
              licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
              requestId,
            }
          );
          return jsonResponse(result, 200);
        }

        const mSubmissionReject = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId/reject",
          pathname
        );
        if (method === "POST" && mSubmissionReject) {
          const body = await request.json();
          const result = await rejectPaymentSubmissionByStaff(
            store,
            principal,
            mSubmissionReject.params.submissionId!,
            body,
            requestId
          );
          return jsonResponse(result, 200);
        }

        const mAssetContent = matchPath("/api/v1/admin/assets/:assetId/content", pathname);
        if (method === "GET" && mAssetContent) {
          assertStaffPermission(principal, "payments.read");
          const asset = store.state.uploaded_assets.find(
            (a) => a.id === mAssetContent.params.assetId
          );
          if (!asset) throw new AppError("NOT_FOUND", "Asset not found.", 404);
          const obj = await store.r2Bucket.get(asset.object_key);
          if (!obj) throw new AppError("NOT_FOUND", "R2 object content not found.", 404);
          const buf = await obj.arrayBuffer();
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": asset.content_type,
              "Content-Length": String(asset.byte_size),
              "Cache-Control": "private, no-store",
              "Content-Disposition": `inline; filename="${asset.original_filename}"`,
              "X-Request-ID": requestId,
            },
          });
        }

        // Subscriptions & Licenses
        if (method === "GET" && pathname === "/api/v1/admin/subscriptions") {
          assertStaffPermission(principal, "subscriptions.read");
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.subscriptions
              .filter(
                (s) =>
                  includesQuery(s.subscription_number, q) ||
                  includesQuery(
                    store.state.customers.find((c) => c.id === s.customer_id)?.name,
                    q,
                  ),
              )
              .map((s) => ({
                ...s,
                customer: store.state.customers.find((c) => c.id === s.customer_id) ?? null,
                product: store.state.products.find((p) => p.id === s.product_id) ?? null,
                next_renewal_display: s.next_renewal_at
                  ? formatDisplayDateDDMMYYYY(s.next_renewal_at, env.DEFAULT_TIMEZONE)
                  : null,
              })),
            limit,
          );
          return collectionResponse(items);
        }

        // Batch 1: subscription detail.
        const mSubDetail = matchPath("/api/v1/admin/subscriptions/:subscriptionId", pathname);
        if (method === "GET" && mSubDetail) {
          assertStaffPermission(principal, "subscriptions.read");
          const sub = store.state.subscriptions.find(
            (s) => s.id === mSubDetail.params.subscriptionId
          );
          if (!sub) throw new AppError("NOT_FOUND", "Subscription not found.", 404);
          return jsonResponse({
            ...sub,
            customer: store.state.customers.find((c) => c.id === sub.customer_id) ?? null,
            product: store.state.products.find((p) => p.id === sub.product_id) ?? null,
            renewal_invoices: store.state.invoices.filter(
              (i) => i.subscription_id === sub.id
            ),
            next_renewal_display: sub.next_renewal_at
              ? formatDisplayDateDDMMYYYY(sub.next_renewal_at, env.DEFAULT_TIMEZONE)
              : null,
          });
        }

        const mSubRenewal = matchPath(
          "/api/v1/admin/subscriptions/:subscriptionId/renewal-invoices",
          pathname
        );
        if (method === "POST" && mSubRenewal) {
          const idempotencyKey =
            request.headers.get("Idempotency-Key") ?? `ren_${mSubRenewal.params.subscriptionId}`;
          const res = await generateSubscriptionRenewalInvoice(
            store,
            principal,
            mSubRenewal.params.subscriptionId!,
            idempotencyKey,
            requestId
          );
          return jsonResponse(res, res.replayed ? 200 : 201);
        }

        const mSubAction = matchPath(
          "/api/v1/admin/subscriptions/:subscriptionId/:action",
          pathname
        );
        if (
          method === "POST" &&
          mSubAction &&
          (mSubAction.params.action === "pause" ||
            mSubAction.params.action === "resume" ||
            mSubAction.params.action === "cancel")
        ) {
          const updated = await transitionSubscriptionStatus(
            store,
            principal,
            mSubAction.params.subscriptionId!,
            mSubAction.params.action as "pause" | "resume" | "cancel",
            requestId
          );
          return jsonResponse(updated);
        }

        if (method === "GET" && pathname === "/api/v1/admin/licenses") {
          assertStaffPermission(principal, "licenses.read");
          // Never expose license_key_hash or raw keys in list responses (API Spec §12.3)
          const { q, limit } = parseListQuery(url.searchParams);
          const items = applyListLimit(
            store.state.licenses
              .filter(
                (l) =>
                  includesQuery(l.license_number, q) ||
                  includesQuery(
                    store.state.customers.find((c) => c.id === l.customer_id)?.name,
                    q,
                  ) ||
                  includesQuery(
                    store.state.products.find((p) => p.id === l.product_id)?.code,
                    q,
                  ),
              )
              .map((l) => {
            const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = l;
            const customer = store.state.customers.find((c) => c.id === l.customer_id);
            const product = store.state.products.find((p) => p.id === l.product_id);
            return {
              ...safe,
              customer_name: customer?.name ?? null,
              product_code: product?.code ?? null,
              product_name: product?.name ?? null,
              active_activations_count: l.activations.filter((a) => a.status === "active").length,
              expires_date_display: l.expires_at
                ? formatDisplayDateDDMMYYYY(l.expires_at, env.DEFAULT_TIMEZONE)
                : "Lifetime",
              };
            }),
            limit,
          );
          return collectionResponse(items);
        }

        if (method === "POST" && pathname === "/api/v1/admin/licenses/manual-grants") {
          const body = await request.json();
          const granted = await createManualLicenseGrantByAdmin(
            store,
            principal,
            body,
            env.LICENSE_VERIFIER_SECRET,
            requestId
          );
          return jsonResponse(granted, 201);
        }

        // Batch 1: license detail + activations.
        // NOTE: GET /api/v1/admin/licenses/manual-grants would also match
        // this pattern with licenseId="manual-grants" — but that path has
        // no GET route, so a 404 here is correct; the POST above runs first.
        const mLicenseDetail = matchPath("/api/v1/admin/licenses/:licenseId", pathname);
        if (method === "GET" && mLicenseDetail) {
          assertStaffPermission(principal, "licenses.read");
          const lic = store.state.licenses.find(
            (l) => l.id === mLicenseDetail.params.licenseId
          );
          if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
          const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = lic;
          const customer = store.state.customers.find((c) => c.id === lic.customer_id);
          const product = store.state.products.find((p) => p.id === lic.product_id);
          return jsonResponse({
            ...safe,
            customer_name: customer?.name ?? null,
            customer_email: customer?.email ?? null,
            product_code: product?.code ?? null,
            product_name: product?.name ?? null,
            active_activations_count: lic.activations.filter((a) => a.status === "active")
              .length,
            expires_date_display: lic.expires_at
              ? formatDisplayDateDDMMYYYY(lic.expires_at, env.DEFAULT_TIMEZONE)
              : "Lifetime",
            entitlement_snapshots: lic.snapshots,
          });
        }

        const mLicenseActivations = matchPath(
          "/api/v1/admin/licenses/:licenseId/activations",
          pathname
        );
        if (method === "GET" && mLicenseActivations) {
          assertStaffPermission(principal, "licenses.read");
          const lic = store.state.licenses.find(
            (l) => l.id === mLicenseActivations.params.licenseId
          );
          if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
          return collectionResponse(lic.activations);
        }

        const mActivationDeactivate = matchPath(
          "/api/v1/admin/licenses/:licenseId/activations/:activationId/deactivate",
          pathname
        );
        if (method === "POST" && mActivationDeactivate) {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          const result = await deactivateLicenseActivationByAdmin(
            store,
            principal,
            mActivationDeactivate.params.licenseId!,
            mActivationDeactivate.params.activationId!,
            body,
            requestId
          );
          return jsonResponse(result);
        }

        const mLicenseAction = matchPath(
          "/api/v1/admin/licenses/:licenseId/:action",
          pathname
        );
        if (
          method === "POST" &&
          mLicenseAction &&
          (mLicenseAction.params.action === "suspend" ||
            mLicenseAction.params.action === "resume" ||
            mLicenseAction.params.action === "revoke")
        ) {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          const updated = await transitionLicenseStatusByAdmin(
            store,
            principal,
            mLicenseAction.params.licenseId!,
            mLicenseAction.params.action as "suspend" | "resume" | "revoke",
            body.reason ?? "Admin lifecycle command",
            requestId
          );
          const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = updated;
          return jsonResponse(safe);
        }

        const mLicenseSnapshots = matchPath(
          "/api/v1/admin/licenses/:licenseId/entitlement-snapshots",
          pathname
        );
        if (method === "POST" && mLicenseSnapshots) {
          const body = (await request.json()) as {
            reason: string;
            entitlements: Record<string, unknown>;
          };
          const snap = await appendLicenseEntitlementSnapshotByAdmin(
            store,
            principal,
            mLicenseSnapshots.params.licenseId!,
            {
              reason: body.reason,
              entitlements: body.entitlements,
              requestId,
            }
          );
          return jsonResponse(snap, 201);
        }

        // Integrated Sites, Credentials, Tracking, Webhooks
        if (method === "GET" && pathname === "/api/v1/admin/integrated-sites") {
          assertStaffPermission(principal, "integrations.manage");
          const { q, limit } = parseListQuery(url.searchParams);
          const sites = applyListLimit(
            store.state.integrated_sites
              .filter(
                (s) =>
                  includesQuery(s.name, q) ||
                  includesQuery(s.site_key, q) ||
                  s.domains.some((d) => includesQuery(d.domain, q)),
              )
              .map((s) => ({
                ...s,
                credentials: store.state.site_credentials
                  .filter((c) => c.integrated_site_id === s.id)
                  .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
                tracking: store.state.tracking_configurations
                  .filter((tc) => tc.integrated_site_id === s.id)
                  .map(({ access_token_ciphertext: _a, ...safeTc }) => safeTc),
              })),
            limit,
          );
          return collectionResponse(sites);
        }

        if (method === "POST" && pathname === "/api/v1/admin/integrated-sites") {
          const body = await request.json();
          const created = await registerIntegratedSiteByAdmin(store, principal, body, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            requestId,
          });
          return jsonResponse(created, 201);
        }

        // Batch 1: site detail + lifecycle + products + credentials + domains.
        const mSiteDetail = matchPath("/api/v1/admin/integrated-sites/:siteId", pathname);
        if (method === "GET" && mSiteDetail) {
          assertStaffPermission(principal, "integrations.manage");
          const site = store.state.integrated_sites.find(
            (s) => s.id === mSiteDetail.params.siteId
          );
          if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
          return jsonResponse({
            ...site,
            credentials: store.state.site_credentials
              .filter((c) => c.integrated_site_id === site.id)
              .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
            tracking: store.state.tracking_configurations
              .filter((tc) => tc.integrated_site_id === site.id)
              .map(({ access_token_ciphertext: _a, ...safeTc }) => safeTc),
          });
        }

        if (method === "PATCH" && mSiteDetail) {
          const body = await request.json();
          const updated = await updateIntegratedSiteByAdmin(
            store,
            principal,
            mSiteDetail.params.siteId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mSiteSuspend = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/suspend",
          pathname
        );
        if (method === "POST" && mSiteSuspend) {
          const suspended = await suspendIntegratedSiteByAdmin(
            store,
            principal,
            mSiteSuspend.params.siteId!,
            requestId
          );
          return jsonResponse(suspended);
        }

        const mSiteRevoke = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/revoke",
          pathname
        );
        if (method === "POST" && mSiteRevoke) {
          const revoked = await revokeIntegratedSiteByAdmin(
            store,
            principal,
            mSiteRevoke.params.siteId!,
            requestId
          );
          return jsonResponse(revoked);
        }

        const mSiteProducts = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/products",
          pathname
        );
        if (method === "POST" && mSiteProducts) {
          const body = (await request.json()) as { product_id: string };
          if (!body.product_id) {
            throw new AppError("VALIDATION_ERROR", "product_id is required.", 422);
          }
          const updated = await assignProductToSiteByAdmin(
            store,
            principal,
            mSiteProducts.params.siteId!,
            body.product_id,
            requestId
          );
          return jsonResponse(updated);
        }

        const mSiteProductRemove = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/products/:productId",
          pathname
        );
        if (method === "DELETE" && mSiteProductRemove) {
          const updated = await removeProductFromSiteByAdmin(
            store,
            principal,
            mSiteProductRemove.params.siteId!,
            mSiteProductRemove.params.productId!,
            requestId
          );
          return jsonResponse(updated);
        }

        const mSiteCredentials = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/credentials",
          pathname
        );
        if (method === "GET" && mSiteCredentials) {
          assertStaffPermission(principal, "integrations.manage");
          const site = store.state.integrated_sites.find(
            (s) => s.id === mSiteCredentials.params.siteId
          );
          if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
          return collectionResponse(
            store.state.site_credentials
              .filter((c) => c.integrated_site_id === site.id)
              .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred)
          );
        }

        if (method === "POST" && mSiteCredentials) {
          const body = await request.json();
          const created = await createSiteCredentialByAdmin(
            store,
            principal,
            mSiteCredentials.params.siteId!,
            body,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(created, 201);
        }

        const mSiteCredRevoke = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/credentials/:credentialId/revoke",
          pathname
        );
        if (method === "POST" && mSiteCredRevoke) {
          const revoked = await revokeSiteCredentialByAdmin(
            store,
            principal,
            mSiteCredRevoke.params.siteId!,
            mSiteCredRevoke.params.credentialId!,
            requestId
          );
          return jsonResponse(revoked);
        }

        // Batch 1: site domains. Registration NEVER auto-verifies — new
        // domains start "pending" (Batch 2 adds real DNS/HTTP checks).
        const mSiteDomains = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/domains",
          pathname
        );
        if (method === "POST" && mSiteDomains) {
          const body = await request.json();
          const updated = await registerSiteDomainByAdmin(
            store,
            principal,
            mSiteDomains.params.siteId!,
            body,
            requestId
          );
          return jsonResponse(updated, 201);
        }

        const mDomainChallenge = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/domains/:domainId/verification-challenge",
          pathname
        );
        if (method === "POST" && mDomainChallenge) {
          const updated = await generateDomainVerificationChallengeByAdmin(
            store,
            principal,
            mDomainChallenge.params.siteId!,
            mDomainChallenge.params.domainId!,
            requestId
          );
          return jsonResponse(updated);
        }

        const mDomainVerify = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/domains/:domainId/verify",
          pathname
        );
        if (method === "POST" && mDomainVerify) {
          const body = (await request.json().catch(() => ({}))) as {
            method?: string;
            reviewer_note?: string;
          };
          const updated = await verifySiteDomainByAdmin(
            store,
            principal,
            mDomainVerify.params.siteId!,
            mDomainVerify.params.domainId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        const mDomainDelete = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/domains/:domainId",
          pathname
        );
        if (method === "DELETE" && mDomainDelete) {
          const updated = await deleteSiteDomainByAdmin(
            store,
            principal,
            mDomainDelete.params.siteId!,
            mDomainDelete.params.domainId!,
            requestId
          );
          return jsonResponse(updated);
        }

        const mRotateCred = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/credentials/:credentialId/rotate",
          pathname
        );
        if (method === "POST" && mRotateCred) {
          const rotated = await rotateSiteServerCredentialByAdmin(
            store,
            principal,
            mRotateCred.params.siteId!,
            mRotateCred.params.credentialId!,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(rotated);
        }

        const mSiteTracking = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/tracking",
          pathname
        );
        if (method === "PUT" && mSiteTracking) {
          const body = await request.json();
          const cfg = await configureSiteTrackingByAdmin(
            store,
            principal,
            mSiteTracking.params.siteId!,
            body,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(cfg);
        }

        // Pixel groups (migration 0006): per-group CRUD under Settings.
        // GET lists a site's groups (ciphertext stripped); POST creates
        // one (201, 409 on a duplicate (provider, pixel_id)); the
        // toggle is PATCH status — no redundant endpoint.
        if (method === "GET" && mSiteTracking) {
          assertStaffPermission(principal, "tracking.manage");
          const site = store.state.integrated_sites.find(
            (s) => s.id === mSiteTracking.params.siteId
          );
          if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
          return collectionResponse(
            store.state.tracking_configurations
              .filter((tc) => tc.integrated_site_id === site.id)
              .map(({ access_token_ciphertext: _, ...safeTc }) => safeTc)
          );
        }

        if (method === "POST" && mSiteTracking) {
          const body = await request.json();
          const created = await createTrackingConfigByAdmin(
            store,
            principal,
            mSiteTracking.params.siteId!,
            body,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(created, 201);
        }

        const mSiteTrackingConfig = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/tracking/:configId",
          pathname
        );
        if (method === "PATCH" && mSiteTrackingConfig) {
          const body = await request.json();
          const updated = await updateTrackingConfigByAdmin(
            store,
            principal,
            mSiteTrackingConfig.params.siteId!,
            mSiteTrackingConfig.params.configId!,
            body,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(updated);
        }

        if (method === "DELETE" && mSiteTrackingConfig) {
          const deleted = await deleteTrackingConfigByAdmin(
            store,
            principal,
            mSiteTrackingConfig.params.siteId!,
            mSiteTrackingConfig.params.configId!,
            requestId
          );
          return jsonResponse(deleted);
        }

        if (method === "GET" && pathname === "/api/v1/admin/tracking/events") {
          assertStaffPermission(principal, "tracking.manage");
          return collectionResponse(store.state.tracking_events);
        }

        if (method === "GET" && pathname === "/api/v1/admin/webhooks") {
          assertStaffPermission(principal, "integrations.manage");
          const endpoints = store.state.webhook_endpoints.map(
            ({ secret_ciphertext: _, ...safe }) => safe
          );
          return collectionResponse(endpoints);
        }

        if (method === "POST" && pathname === "/api/v1/admin/webhooks") {
          const body = await request.json();
          const created = await registerWebhookEndpointByAdmin(store, principal, body, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            requestId,
          });
          return jsonResponse(created, 201);
        }

        const mWebhookDelete = matchPath(
          "/api/v1/admin/webhooks/:webhookId",
          pathname
        );
        if (method === "DELETE" && mWebhookDelete) {
          const deleted = await deleteWebhookEndpointByAdmin(
            store,
            principal,
            mWebhookDelete.params.webhookId!,
            requestId
          );
          return jsonResponse(deleted);
        }

        // Batch 1: webhook test delivery + delivery history + outbox reads/replay.
        const mWebhookTest = matchPath(
          "/api/v1/admin/webhooks/:webhookId/test",
          pathname
        );
        if (method === "POST" && mWebhookTest) {
          const result = await testWebhookEndpointByAdmin(store, principal, mWebhookTest.params.webhookId!, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            requestId,
          });
          return jsonResponse(result);
        }

        const mWebhookDeliveries = matchPath(
          "/api/v1/admin/webhooks/:webhookId/deliveries",
          pathname
        );
        if (method === "GET" && mWebhookDeliveries) {
          assertStaffPermission(principal, "integrations.manage");
          const endpoint = store.state.webhook_endpoints.find(
            (ep) => ep.id === mWebhookDeliveries.params.webhookId
          );
          if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
          return collectionResponse(
            store.state.webhook_deliveries.filter(
              (d) => d.webhook_endpoint_id === endpoint.id
            )
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/outbox-events") {
          assertStaffPermission(principal, "integrations.manage");
          const statusFilter = url.searchParams.get("status");
          const items = store.state.outbox_events.filter((e) =>
            !statusFilter ? true : e.status === statusFilter
          );
          return collectionResponse(items);
        }

        const mOutboxReplay = matchPath(
          "/api/v1/admin/outbox-events/:eventId/replay",
          pathname
        );
        if (method === "POST" && mOutboxReplay) {
          const replayed = await replayOutboxEventByAdmin(
            store,
            principal,
            mOutboxReplay.params.eventId!,
            requestId
          );
          return jsonResponse(replayed);
        }

        if (method === "POST" && pathname === "/api/v1/admin/outbox/dispatch") {
          assertStaffPermission(principal, "integrations.manage");
          const summary = await processTransactionalOutboxBatch(store, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
          });
          return jsonResponse(summary);
        }

        // Dashboard & Analytics Overview (PRD §18: Pending payments are NEVER counted as revenue!)
        // PLAN §23 — date filter: `?from=YYYY-MM-DD&to=YYYY-MM-DD` scopes
        // the FLOW metrics to the inclusive range (Dhaka day boundaries).
        // verified_revenue_minor = paid orders completed in the range (the
        // existing paid-only definition, unchanged for all time);
        // total_orders = created in the range; paid_orders = created in the
        // range AND paid (cohort, so "paid / total" stays a coherent ratio).
        // Everything else is a current-state snapshot — history cannot be
        // reconstructed from current state, so products / subscriptions /
        // licenses / queues / all-time customer total are NOT range-scoped.
        if (method === "GET" && pathname === "/api/v1/admin/analytics/overview") {
          assertStaffPermission(principal, "products.read");
          const range = parseOverviewRange(url.searchParams);
          const timeZone = env.DEFAULT_TIMEZONE;
          const inRange = (iso: string | null | undefined) =>
            isTimestampInOverviewRange(iso, range, timeZone);
          // Revenue: paid orders completed in the range. A null range
          // (all time) matches every paid order, including one with no
          // completed_at — exactly the pre-filter computation.
          const paidOrders = store.state.orders.filter(
            (o) =>
              o.payment_status === "paid" &&
              (range === null ? true : inRange(o.completed_at)),
          );
          const verifiedRevenueMinor = paidOrders.reduce((acc, o) => acc + o.total_minor, 0);
          const ordersInRange = store.state.orders.filter((o) => inRange(o.created_at));
          const paidOrdersInRange = ordersInRange.filter((o) => o.payment_status === "paid");
          const pendingSubmissions = store.state.payment_submissions.filter(
            (s) => s.status === "submitted" || s.status === "under_review"
          );

          return jsonResponse({
            currency_code: env.DEFAULT_CURRENCY,
            total_products: store.state.products.length,
            active_products: store.state.products.filter((p) => p.status === "active").length,
            total_customers: store.state.customers.length,
            total_orders: ordersInRange.length,
            paid_orders: paidOrdersInRange.length,
            pending_payment_submissions: pendingSubmissions.length,
            active_subscriptions: store.state.subscriptions.filter((s) => s.status === "active")
              .length,
            active_licenses: store.state.licenses.filter((l) => l.status === "active").length,
            expired_or_revoked_licenses: store.state.licenses.filter(
              (l) => l.status === "expired" || l.status === "revoked"
            ).length,
            verified_revenue_minor: verifiedRevenueMinor,
            pending_outbox_events: store.state.outbox_events.filter(
              (e) => e.status === "pending"
            ).length,
            range,
          });
        }

        if (method === "GET" && pathname === "/api/v1/admin/audit-logs") {
          assertStaffPermission(principal, "audit_logs.read");
          const items = store.state.audit_logs.map((a) => ({
            ...a,
            // Human display name for the resource (F3 follow-up): resolved
            // server-side from the in-memory state; null when the resource
            // no longer exists — the SPA falls back to its client-side
            // maps, then a short id. Additive field, no contract break.
            resource_display_name: resolveAuditResourceDisplayName(
              store.state,
              a.resource_type,
              a.resource_id,
              a.actor_user_id,
              // Fix batch #2: the row's own changes carry the identity
              // of deleted resources (webhook URL, pixel-group label,
              // bulk feature keys) — the resolver falls back to them.
              a.changes,
            ),
            created_date_display: formatDisplayDateTimeDDMMYYYY(
              a.created_at,
              env.DEFAULT_TIMEZONE
            ),
          }));
          return collectionResponse(items);
        }
      }

      throw new AppError("NOT_FOUND", `Route '${method} ${pathname}' not found.`, 404);
    } catch (error) {
      if (error instanceof AppError) {
        return new Response(
          JSON.stringify(
            createErrorEnvelope(error.code, error.message, requestId, error.details)
          ),
          {
            status: error.statusCode,
            headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
          }
        );
      }

      if (error instanceof SchemaValidationError) {
        return new Response(
          JSON.stringify(
            createErrorEnvelope("VALIDATION_ERROR", error.message, requestId, {
              fields: error.fieldErrors,
            })
          ),
          {
            status: 422,
            headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
          }
        );
      }

      return new Response(
        JSON.stringify(
          createErrorEnvelope(
            "INTERNAL_ERROR",
            "An unexpected internal error occurred.",
            requestId
          )
        ),
        {
          status: 500,
          headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
        }
      );
    }
  }

  async function handleScheduled(
    _event: { cron?: string; scheduledTime?: number },
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ) {
    const env = resolveRuntimeConfig(rawEnv);
    const store = await resolveRequestStore(env, ctx);
    try {
      // The await is LOAD-BEARING (cron bug 2026-11-16): `return
      // <pending promise>` runs this finally block BEFORE the promise
      // settles, so without it closeRequestStore ends the store's pg
      // client while the drain is still running and the drain's first
      // BEGIN throws "Client was closed and is not queryable" — every
      // cron invocation errored (~1/min uncaught exceptions in the
      // Cloudflare metrics) and the outbox never drained on schedule.
      // fetchHandler already awaits for the same reason.
      const drainResult = await processTransactionalOutboxBatch(store, {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
      });
      // Renewal + expiry sweep (ADR-0009): runs AFTER the drain, so a
      // sweep failure can never block outbox delivery. The sweep itself
      // never throws (its report carries per-item errors); the reminder
      // sends below are best-effort and a failed send is NOT marked
      // sent, so the next minute's run retries it (send-first-then-mark).
      try {
        const sweep = await runRenewalExpirySweep(store, {
          licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
          requestId: `cron:sweep:${new Date().toISOString()}`,
        });
        const sent: typeof sweep.reminders_due = [];
        for (const reminder of sweep.reminders_due) {
          const result = await sendEmailViaSmtp(store, env, {
            to: reminder.to_email,
            subject: reminder.subject,
            text: reminder.text,
          });
          if (result.sent) sent.push(reminder);
        }
        if (sent.length > 0) await markSweepRemindersSent(store, sent);
      } catch (err) {
        // Never fail the cron (and never mask the drain result) for
        // sweep or reminder-mail errors — the next run retries.
        console.error("[stackmate-cron] renewal sweep failed", err);
      }
      return drainResult;
    } finally {
      // The cron uses the same request-scoped store path as fetch (see
      // closeRequestStore): a factory-created store is closed here.
      if (storeFactory) await closeRequestStore(store);
    }
  }

  /**
   * Fetch entrypoint: env is resolved FIRST and fail-closed — in
   * staging/production resolveRuntimeConfig throws without
   * HYPERDRIVE_NO_CACHE (and without required secrets), and that throw
   * propagates here instead of ever serving from a silent in-memory store.
   * The store is then resolved per request (factory or injected) and the
   * request is handled with that store.
   */
  async function fetchHandler(
    request: Request,
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const env = resolveRuntimeConfig(rawEnv);
    let store: StackMateDataStore;
    try {
      store = await resolveRequestStore(env, ctx);
    } catch (error) {
      // Store creation failed (e.g. the database was briefly unreachable
      // even after the entrypoint's retry). Never let it escape as a bare
      // Worker exception (Cloudflare 1101, opaque to clients): log the
      // real error for the Worker logs and answer with the standard JSON
      // error envelope so the SPA shows a retryable 500, not a blank
      // failure. resolveRuntimeConfig above still throws (loud 1101) on
      // missing bindings/secrets — that is a deployment error, not a
      // transient store failure.
      const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const trustedOrigins = env.TRUSTED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const originHeader = request.headers.get("Origin");
      console.error("[stackmate] store creation failed", requestId, error);
      return new Response(
        JSON.stringify(
          createErrorEnvelope(
            "STORE_UNAVAILABLE",
            "The data store is temporarily unavailable. Please retry.",
            requestId
          )
        ),
        {
          status: 500,
          headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
        }
      );
    }
    try {
      return await handleRequest(store, request, env, ctx);
    } finally {
      // Request-scoped store (storeFactory mode only): the factory
      // created this store for this request, so it is closed here —
      // its pg Client is ended and never outlives the request. The
      // response body is fully materialized JSON, so closing before
      // the runtime sends it is safe. An injected store is never
      // closed: its lifetime belongs to its owner.
      if (storeFactory) await closeRequestStore(store);
    }
  }

  return {
    store: injectedStore ?? null,
    fetch: fetchHandler,
    scheduled: handleScheduled,
  };
}
