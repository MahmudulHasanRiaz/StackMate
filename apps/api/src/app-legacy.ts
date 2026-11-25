/**
 * StackMate Central API Application (Cloudflare Workers Fetch Standard —
 * a plain fetch handler, no framework).
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
  decodeCursor,
  encodeCursor,
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  RecordManualRefundSchema,
  SchemaValidationError,
} from "../../../packages/contracts/src/index.ts";
import {
  resolveRuntimeConfig,
  type StackMateBindings,
  type WorkerExecutionContext,
} from "./env.ts";
import { verifyCheckoutAccessToken } from "./platform/crypto/index.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  sha256Hex,
  verifyTokenHash,
} from "./platform/crypto/index.ts";
import { verifyMediaBytes } from "./platform/storage/media-validation.ts";
import { and, eq } from "drizzle-orm";
import { passwordResetTokens as baPasswordResetTokens } from "../../../db/schema/auth-config.ts";
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
  loadSmtpSettings,
  saveOAuthProvider,
  saveSmtpSettings,
  saveTwoFactorPolicy,
  toAuthConfigView,
  type ResolvedAuthConfig,
  type ResolvedSmtpSettings,
} from "./modules/auth-config/service.ts";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  publicViewOf,
  saveGeneralSettings,
  storeFavicon,
} from "./modules/general-settings/service.ts";
import {
  deleteMediaAsset,
  getMediaAssetContent,
  listMediaAssets,
  listMediaFolders,
  mediaViewOf,
  moveMediaAsset,
  regenerateMediaThumbnail,
  renameMediaAsset,
  requireMediaAsset,
  setMediaAssetTags,
  uploadMediaAsset,
} from "./modules/media/service.ts";
import {
  DEFAULT_STORAGE_SETTINGS,
  loadStorageSettings,
  saveStorageSettings,
} from "./platform/storage/settings.ts";
import {
  resolveStorageDriver,
  type DriverDeps,
} from "./platform/storage/driver.ts";
import { AppError } from "./shared/errors.ts";
import { MAX_MEDIA_BYTES } from "./platform/storage/media-validation.ts";
import { sql } from "drizzle-orm";
import {
  isTimestampInOverviewRange,
  parseOverviewRange,
} from "./modules/analytics/overview-range.ts";
import { computeProfitLoss } from "./modules/analytics/pnl.ts";
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  getExpense,
  getExpenseCategory,
  listExpenseCategories,
  listExpenses,
  updateExpense,
  updateExpenseCategory,
} from "./modules/expenses/service.ts";
import {
  acceptStaffInvitation,
  assertStaffPermission,
  assertStaffPermissionAudited,
  bootstrapInitialSuperAdmin,
  changeStaffPassword,
  checkBetterAuthFallbackAccess,
  createPasswordResetToken,
  createRoleByAdmin,
  createStaffInvitationByAdmin,
  createStaffUserByAdmin,
  ensureBetterAuthIdentity,
  isSuperAdminProvisioned,
  recoverTwoFactorByToken,
  recordTwoFactorStateChange,
  resetStaffPasswordByToken,
  resolveStaffPrincipal,
  resolveTokenPepper,
  revokeStaffInvitationByAdmin,
  signInStaffSession,
  signOutStaffSession,
  storePasswordResetToken,
  storeSupportsBetterAuth,
  suspendStaffUser,
  type StaffPrincipal,
  unsuspendStaffUser,
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
  saveOrderAsPackage,
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
  deletePaymentMethodByAdmin,
  deletePaymentProviderByAdmin,
  recordManualPaymentClaimByAdmin,
  recordManualRefundByAdmin,
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
  transferActivation,
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
  sendTrackingTestEvent,
  updateTrackingConfigByAdmin,
} from "./modules/tracking/service.ts";
import {
  createRealWebhookTransport,
  deleteWebhookEndpointByAdmin,
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
  replayOutboxEventByAdmin,
  rotateWebhookSecret,
  testWebhookEndpointByAdmin,
  testWebhookForSite,
  updateWebhookEndpoint,
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
  CRON_JOB_OUTBOX_DRAIN,
  CRON_JOB_RENEWAL_SWEEP,
  releaseCronLease,
  tryAcquireCronLease,
} from "./platform/cron-lease.ts";
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
  ): Promise<{
    claimed: number;
    delivered: number;
    // C-2/D-6: the dispatcher also counts simulated deliveries.
    simulated: number;
    // Q3: events with no subscribed active endpoint.
    skipped: number;
    retrying: number;
    dead_lettered: number;
  }>;
}

// M-20: the static default favicon (byte-identical to
// apps/admin/public/favicon.svg, which the API Worker cannot read at
// runtime — no fs on Workers). Keep the two in sync when the brand
// mark changes.
const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="12" fill="#141414"/>' +
  '<text x="32" y="44" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700" fill="#00E599" text-anchor="middle">S</text>' +
  "</svg>";

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
  // C-1: rate limiting is STORE-backed (store.checkRateLimit) — the
  // old in-app Map lived inside createStackMateApp() and was recreated
  // on every fetch(), so the limit never tripped in production. The
  // DB-backed buckets (table rate_limit_buckets) survive across
  // requests on Workers; the in-memory store keeps a per-instance Map
  // as the test/fallback implementation.
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
   * C-10: pg.Clients created by the Better Auth fallback path in
   * getBetterAuth (below) are tracked per store and ended when the
   * request finishes (see fetchHandler's finally). Without this each
   * request that took the non-`drizzleDb` branch leaked a client
   * object — a connection is only opened if Better Auth actually
   * queries, but the object itself was never ended.
   */
  const betterAuthFallbackClients = new WeakMap<
    object,
    Array<{ end: () => Promise<unknown> }>
  >();

  async function closeBetterAuthFallbackClients(
    store: StackMateDataStore
  ): Promise<void> {
    const clients = betterAuthFallbackClients.get(store);
    if (!clients || clients.length === 0) return;
    betterAuthFallbackClients.delete(store);
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
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
    // C-10: track the fallback client so fetchHandler ends it when
    // the request finishes (see closeBetterAuthFallbackClients).
    const tracked = betterAuthFallbackClients.get(store) ?? [];
    tracked.push(client);
    betterAuthFallbackClients.set(store, tracked);
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
    message: { to: string; subject: string; text: string; html?: string },
    // B-15: preloaded SMTP settings for the cron tick (loaded once per
    // tick in handleScheduled). Worker B adds the matching optional 4th
    // parameter to sendStackMateEmail — until then the extra argument
    // is ignored at runtime and the per-send load inside
    // sendStackMateEmail still runs; the cast keeps this compiling
    // either way and the tick-level gate below still saves N loads
    // when SMTP is not configured at all.
    preloadedSmtp?: ResolvedSmtpSettings | null
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
    const sendWithPreloaded = sendStackMateEmail as (
      db: Parameters<typeof sendStackMateEmail>[0],
      deps: Parameters<typeof sendStackMateEmail>[1],
      message: Parameters<typeof sendStackMateEmail>[2],
      preloadedSmtp?: ResolvedSmtpSettings | null
    ) => Promise<SendResult>;
    return sendWithPreloaded(
      db,
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        appUrl: env.APP_URL,
      },
      message,
      preloadedSmtp ?? undefined
    );
  }

  /**
   * Storage-driver deps for one request (PLAN §31 / ADR-0011): the
   * drizzle DB (null when the store has none), the runtime env, the R2
   * bucket binding, and the in-memory-bucket flag. `resolveStorageDriver`
   * applies the fail-closed rule (staging/prod + in-memory bucket →
   * 503) and the Settings → Storage selection. Used by the favicon,
   * payment-evidence, and media-library routes.
   */
  function driverDepsForRequest(
    store: StackMateDataStore,
    env: StackMateBindings
  ): DriverDeps {
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    const maybeBucket = store as unknown as {
      r2Bucket?: unknown;
      usesInMemoryBucket?: boolean;
    };
    return {
      db: (maybeDrizzle.drizzleDb ?? null) as DriverDeps["db"],
      appEnv: env.APP_ENV,
      r2Bucket: maybeBucket.r2Bucket as DriverDeps["r2Bucket"],
      usesInMemoryBucket: maybeBucket.usesInMemoryBucket,
    };
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

    // L-1: CSRF gate for cookie-authenticated state-changing requests.
    // An absent Origin no longer skips the gate — a cross-site Referer
    // or Sec-Fetch-Site: cross-site also blocks. Absent Origin AND
    // absent Referer stays allowed: non-browser clients (and the test
    // suite) send neither, and a blanket fail-closed there would break
    // legitimate API clients that carry the session cookie. Residual
    // risk, documented honestly: a forgery from a page that suppresses
    // both headers (e.g. <meta name="referrer" content="no-referrer">)
    // cannot be distinguished from a non-browser client here.
    // Bearer-token requests are unaffected (no ambient credential to
    // forge with), and GET/HEAD never mutate.
    const assertSameSiteCookieMutation = (req: Request) => {
      const sessionCookie = parseSessionCookie(req.headers.get("Cookie"));
      if (!sessionCookie) return;
      const methodUpper = req.method.toUpperCase();
      if (methodUpper === "GET" || methodUpper === "HEAD") return;
      const origin = req.headers.get("Origin");
      const referer = req.headers.get("Referer");
      const fetchSite = req.headers.get("Sec-Fetch-Site");
      const refererOrigin = (() => {
        if (!referer) return null;
        try {
          return new URL(referer).origin;
        } catch {
          return "invalid";
        }
      })();
      const crossSite =
        (origin !== null && !trustedOrigins.includes(origin)) ||
        (origin === null &&
          refererOrigin !== null &&
          !trustedOrigins.includes(refererOrigin)) ||
        (origin === null && refererOrigin === null && fetchSite === "cross-site");
      if (crossSite) {
        throw new AppError(
          "FORBIDDEN",
          `Cross-origin state-changing request from untrusted origin '${origin ?? refererOrigin ?? "cross-site"}' blocked by CSRF policy.`,
          403
        );
      }
    };

    if (method === "OPTIONS") {
      // L-20: the method/header allow-list is only advertised to a
      // trusted origin. Any other origin (or none) gets a bare 204 —
      // it grants nothing and reveals nothing about the API surface.
      const isTrustedOrigin =
        originHeader !== null && trustedOrigins.includes(originHeader);
      return new Response(null, {
        status: 204,
        headers: {
          ...buildStandardHeaders(requestId, originHeader, trustedOrigins),
          ...(isTrustedOrigin
            ? {
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers":
                  "Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-StackMate-Site-Key, X-StackMate-Key-Id, X-StackMate-Timestamp, X-StackMate-Nonce, X-StackMate-Content-SHA256, X-StackMate-Signature",
              }
            : {}),
        },
      });
    }

    // A-06: `cf-connecting-ip` is authoritative when present. `x-real-ip`
    // is client-controlled and is trusted ONLY when the request did NOT
    // come through Cloudflare (no `cf-connecting-ip` and no `cf-ray`) —
    // behind Cloudflare a spoofed `x-real-ip` must never pick the
    // rate-limit bucket. Without either header the request is bucketed
    // under loopback.
    const cfConnectingIp = request.headers.get("cf-connecting-ip");
    const viaCloudflare =
      cfConnectingIp !== null || request.headers.get("cf-ray") !== null;
    const clientIp =
      cfConnectingIp ??
      (viaCloudflare
        ? "127.0.0.1"
        : (request.headers.get("x-real-ip") ?? "127.0.0.1"));

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

    // A-06: per-token attempt cap for one-time-token endpoints
    // (password reset, invitation accept, 2FA recovery confirm): at
    // most 5 attempts per token (keyed by the token's SHA-256, never
    // the raw token) inside one hour; the 6th attempt answers 429 AND
    // invalidates the token via onExhausted, so a brute-forced token
    // cannot be retried indefinitely. Successful attempts consume the
    // token in the service layer, so the cap only ever binds failures.
    const capTokenAttempts = async (
      bucketKey: string,
      onExhausted: () => Promise<void>
    ): Promise<void> => {
      try {
        await store.checkRateLimit(bucketKey, 5, 60 * 60_000);
      } catch (error) {
        if (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED") {
          await onExhausted().catch(() => {});
        }
        throw error;
      }
    };

    // A-04: dispatcher-level idempotency for the §20.1 commands whose
    // services cannot be wrapped in `store.executeIdempotent` directly
    // — every one of them runs its own `store.withTransaction`, and a
    // nested withTransaction DEADLOCKS (drizzle-store.ts header: the
    // instance lock / advisory lock serializes writers). So the
    // reserve → execute → complete phases run as THREE separate
    // transactions instead of one:
    //   1. reserve: inside one transaction, find the (scope, key) row
    //      (payload-hash mismatch → 409 IDEMPOTENCY_KEY_REUSED,
    //      still-processing → 409 IDEMPOTENCY_IN_PROGRESS, completed
    //      → replay the stored body, failed → allow a retry) or
    //      insert a "processing" placeholder. The reserve transaction
    //      serializes concurrent duplicates, so two identical retries
    //      cannot both execute.
    //   2. execute the service (its own transaction) outside any
    //      idempotency transaction.
    //   3. complete: mark the row completed with the (possibly
    //      redacted — see redactForStore) response body.
    // A failed execution marks the row "failed" (best-effort) so the
    // next retry with the same key re-executes instead of wedging on
    // IDEMPOTENCY_IN_PROGRESS. The header is OPTIONAL: without a key
    // the command runs exactly as before (the SPA sends one key per
    // form instance — the SPA half of A-04); with a key it is
    // replay-safe. Secrets (license keys, raw credential secrets,
    // entitlement tokens) are NEVER stored in the row — redactForStore
    // strips them and reissueOnReplay re-derives them (decrypt the
    // stored ciphertext, or re-run a naturally-idempotent service).
    const runIdempotentCommand = async <T>(options: {
      scope: string;
      key: string | null | undefined;
      payload: unknown;
      statusCode: number;
      fn: () => Promise<T>;
      redactForStore?: (body: T) => unknown;
      reissueOnReplay?: (storedBody: unknown) => Promise<T> | T;
    }): Promise<{ status: number; body: T; replayed: boolean }> => {
      const rawKey = options.key?.trim() ?? "";
      if (rawKey === "") {
        return { status: options.statusCode, body: await options.fn(), replayed: false };
      }
      if (rawKey.length < 8 || rawKey.length > 128) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Idempotency-Key header must be between 8 and 128 characters.",
          400
        );
      }
      const requestHash = sha256Hex(JSON.stringify(options.payload ?? {}));
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const findRecord = (state: typeof store.state) =>
        state.idempotency_records.find(
          (r) => r.scope_key === options.scope && r.idempotency_key === rawKey
        );
      const reserved = await store.withTransaction((state) => {
        const existing = findRecord(state);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new AppError(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency-Key was already used with a different request payload.",
              409
            );
          }
          if (existing.status === "processing") {
            throw new AppError(
              "IDEMPOTENCY_IN_PROGRESS",
              "A request with this Idempotency-Key is currently processing.",
              409
            );
          }
          if (existing.status === "failed") {
            existing.status = "processing";
            existing.response_body = null;
            return { replay: false as const };
          }
          return {
            replay: true as const,
            body: existing.response_body,
            status: existing.response_status,
          };
        }
        state.idempotency_records.push({
          id: randomUUID(),
          scope_key: options.scope,
          idempotency_key: rawKey,
          request_hash: requestHash,
          status: "processing",
          response_status: options.statusCode,
          response_body: null,
          expires_at: expiresAt,
          created_at: nowIso,
        });
        return { replay: false as const };
      });
      if (reserved.replay) {
        const body = options.reissueOnReplay
          ? await options.reissueOnReplay(reserved.body)
          : (reserved.body as T);
        return { status: reserved.status, body, replayed: true };
      }
      let body: T;
      try {
        body = await options.fn();
      } catch (error) {
        await store
          .withTransaction((state) => {
            const rec = findRecord(state);
            if (rec && rec.status === "processing") rec.status = "failed";
          })
          .catch(() => {});
        throw error;
      }
      const storedBody = options.redactForStore ? options.redactForStore(body) : body;
      await store
        .withTransaction((state) => {
          const rec = findRecord(state);
          if (rec) {
            rec.status = "completed";
            rec.response_status = options.statusCode;
            rec.response_body = storedBody;
          }
        })
        .catch(() => {});
      return { status: options.statusCode, body, replayed: false };
    };

    // B-05: `total` is the pre-limit count (the full filtered set), so
    // clients can paginate. It lives in the contracts collection type
    // now (ApiCollectionData.total) — no untyped cast. Callers that do
    // not pass a total get no `total` key. `extraHeaders` carries
    // per-route cache directives (B-08: public catalog GETs).
    const collectionResponse = <T>(
      items: T[],
      nextCursor: string | null = null,
      status = 200,
      total?: number,
      extraHeaders?: Record<string, string>
    ) => {
      const envelope = createCollectionEnvelope(items, nextCursor, requestId, total);
      return new Response(JSON.stringify(envelope), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins, extraHeaders),
      });
    };

    // Server-side list search (PLAN §29 / ADR-0010): `?q=` filters a list
    // over the FULL dataset on the server — never over a loaded page —
    // and `?limit=` caps the result AFTER filtering. The store loads the
    // full table snapshot per request by design, so filtering `store.state`
    // here is filtering the whole table; if the store ever paginates at
    // the DB layer, these filters must move into SQL.
    // `q` is trimmed + lowercased once here; every caller matches with
    // `includes` on already-lowercased haystacks.
    // M-1: lists default to 25 rows (the PaginationQuerySchema
    // default — `limit` absent/invalid used to mean "the FULL table").
    // An explicit ?limit= (1..100) overrides; anything else is 25.
    // Every list handler in this dispatcher goes through here, so no
    // list can silently return an unbounded collection anymore.
    const parseListQuery = (params: URLSearchParams): { q: string; limit: number; page: number } => {
      const q = params.get("q")?.trim().toLowerCase() ?? "";
      const rawLimit = Number(params.get("limit"));
      const limit =
        Number.isFinite(rawLimit) && rawLimit >= 1
          ? Math.min(Math.floor(rawLimit), 100)
          : 25;
      // Offset pagination: ?page= (default 1; non-integer or <= 0 is 1).
      // pagedCollectionResponse slices the (page-1)*limit window, so
      // rows past the first page are reachable — no list is capped.
      const rawPage = Number(params.get("page"));
      const page =
        Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
      return { q, limit, page };
    };
    const applyListPage = <T>(items: T[], limit: number, page: number): T[] =>
      items.slice((page - 1) * limit, page * limit);
    // Dashboard ordering (fix for the "ordering beyond 100 rows" gap):
    // pagedCollectionResponse slices the window AFTER filtering, so a
    // ?limit=100 window only holds a deterministic set when the list is
    // sorted FIRST. The dashboard panels request an explicit sort
    // (?sort=<field>:desc|asc); the default — and any unknown value —
    // is newest-first. The tiebreak is always id ASC, so rows sharing a
    // timestamp still come back in one stable order on every page.
    const parseTimestampSort = (params: URLSearchParams, field: string): "desc" | "asc" =>
      params.get("sort") === `${field}:asc` ? "asc" : "desc";
    const sortByTimestamp = <T extends { id: string }>(
      items: T[],
      field: string,
      direction: "desc" | "asc",
    ): T[] => {
      const timeOf = (row: T): number => {
        const n = new Date(String((row as Record<string, unknown>)[field] ?? "")).getTime();
        return Number.isFinite(n) ? n : 0;
      };
      return [...items].sort((a, b) => {
        const byTime = timeOf(a) - timeOf(b);
        if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
        return a.id.localeCompare(b.id);
      });
    };
    // Paged list response: slices the (page-1)*limit window AFTER
    // filtering and reports the pre-limit total, so the client can
    // paginate (M-1). `page` is 3rd so every call site reads
    // (items, limit, page); nextCursor/status stay optional after
    // it (no caller passes them today).
    const pagedCollectionResponse = <T>(
      filtered: T[],
      limit: number,
      page = 1,
      nextCursor: string | null = null,
      status = 200,
      extraHeaders?: Record<string, string>
    ) =>
      collectionResponse(
        applyListPage(filtered, limit, page),
        nextCursor,
        status,
        filtered.length,
        extraHeaders
      );
    // B-05: cursor pagination for the append-heavy lists (audit logs,
    // tracking events, outbox). Offset paging over append-heavy tables
    // can skip/duplicate rows between pages as rows are inserted; a
    // cursor pins the position. Rows are newest-first
    // (created_at DESC, id DESC tiebreak); the cursor is the last row
    // of the previous page. A malformed ?cursor= is a 400, never a
    // silent restart from page 1. SQL pagination (count(*) +
    // limit/offset in SQL, media template) still waits on B-01 — the
    // store still full-loads per request, so a SQL page would not save
    // the load; the cursor makes paging stable until then.
    const applyCursorPage = <T extends { id: string; created_at: string }>(
      sortedDesc: T[],
      limit: number,
      cursor: string | null
    ): { page: T[]; nextCursor: string | null } => {
      let start = 0;
      if (cursor !== null && cursor !== "") {
        let decoded: { created_at: string; id: string };
        try {
          decoded = decodeCursor(cursor);
        } catch {
          throw new AppError("VALIDATION_ERROR", "Malformed pagination cursor.", 400);
        }
        start = sortedDesc.findIndex(
          (row) =>
            row.created_at < decoded.created_at ||
            (row.created_at === decoded.created_at && row.id < decoded.id)
        );
        if (start === -1) return { page: [], nextCursor: null };
      }
      const page = sortedDesc.slice(start, start + limit);
      const nextCursor =
        page.length === limit && start + limit < sortedDesc.length
          ? encodeCursor({
              created_at: page[page.length - 1]!.created_at,
              id: page[page.length - 1]!.id,
            })
          : null;
      return { page, nextCursor };
    };
    // Newest-first sort shared by the cursor-paged lists (created_at
    // DESC, id DESC tiebreak — the same order applyCursorPage assumes).
    const sortNewestFirst = <T extends { id: string; created_at: string }>(items: T[]): T[] =>
      [...items].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    // E-09/E-11: renewal buckets over subscriptions. Windows are UTC
    // calendar days off the YYYY-MM-DD part of next_renewal_at (all
    // renewal timestamps are stored UTC). Buckets are disjoint:
    // cancelled → cancelled; past_due → failed; renewal date past →
    // overdue; within 7 days → due; within 30 days → upcoming. Rows
    // with no next_renewal_at, or a renewal more than 30 days out,
    // belong to no bucket (they are not actionable yet).
    const RENEWAL_UPCOMING_DAYS = 30;
    const RENEWAL_DUE_DAYS = 7;
    const renewalDayOf = (iso: string | null | undefined): string | null =>
      typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
    const addDaysIso = (day: string, days: number): string => {
      const d = new Date(`${day}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const renewalBucketOf = (
      sub: { status: string; next_renewal_at: string | null },
      todayDay: string
    ): "upcoming" | "due" | "overdue" | "failed" | "cancelled" | null => {
      if (sub.status === "cancelled") return "cancelled";
      if (sub.status === "past_due") return "failed";
      const day = renewalDayOf(sub.next_renewal_at);
      if (day === null) return null;
      if (day < todayDay) return "overdue";
      if (day <= addDaysIso(todayDay, RENEWAL_DUE_DAYS)) return "due";
      if (day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)) return "upcoming";
      return null;
    };
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

    // M-2: the 6 MB body cap (enforced above on Content-Length) is
    // bypassed by chunked / length-less requests, because
    // request.json() and request.text() buffer the whole stream
    // unchecked. These helpers read through the stream with a running
    // byte count and 413 past the cap, so every body read in this
    // dispatcher is capped the same way. Multipart uploads (media /
    // evidence) keep their own size validation and do not use these.
    const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;
    const readCappedText = async (req: Request): Promise<string> => {
      const body = req.body;
      if (!body) return "";
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_REQUEST_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    };
    // M-6: malformed JSON is a client error (400), never a 500. The
    // old request.json() threw a bare SyntaxError that the outer catch
    // mapped to a generic 500.
    const parseJsonText = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        throw new AppError("VALIDATION_ERROR", "Request body is not valid JSON.", 400);
      }
    };
    // Typed `any` (like request.json() itself) so the ~80 existing
    // handlers compile unchanged — the fix here is behavioural (cap +
    // 400), and each handler still validates/casts its own shape.
    const readJsonBody = async (req: Request): Promise<any> => {
      const text = await readCappedText(req);
      if (text.trim() === "") {
        throw new AppError(
          "VALIDATION_ERROR",
          "Request body is required and must be valid JSON.",
          400
        );
      }
      return parseJsonText(text);
    };
    // A-08: streaming cap for multipart uploads. request.formData()
    // buffers the whole body before any validation, so a chunked
    // (length-less) upload bypassed the 6 MB gate and buffered
    // unbounded in Worker memory. This reads the stream with a running
    // byte count and 413s past the per-route cap (media 100 MB, avatar
    // 2 MB) WITHOUT ever holding more than cap+1 chunk, then parses
    // the capped bytes as multipart — never buffer-then-validate.
    // A present Content-Length past the cap 413s without reading.
    const readCappedMultipartFormData = async (
      req: Request,
      capBytes: number
    ): Promise<FormData> => {
      const declaredLength = Number(req.headers.get("Content-Length") ?? "0");
      if (declaredLength > capBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
      }
      const body = req.body;
      if (!body) return new FormData();
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > capBytes) {
          await reader.cancel().catch(() => {});
          throw new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds limit.", 413);
        }
        chunks.push(value);
      }
      if (total === 0) return new FormData();
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const rebuilt = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: merged,
      });
      return rebuilt.formData();
    };
    // Lenient variant for handlers that treat a missing/malformed body
    // as "no body" (public token endpoints). A 413 is never swallowed:
    // an oversize body must fail loudly.
    const readJsonBodyLenient = async (req: Request): Promise<any> => {
      try {
        return await readJsonBody(req);
      } catch (error) {
        if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") throw error;
        return {};
      }
    };

    try {
      // A-09: the staging/production URL-var check lives in
      // resolveRuntimeConfig (env.ts) and runs at boot, before any
      // store resolution — there is no per-request check here anymore.
      // Reject oversized JSON bodies (> 6 MB). A-08: the gate applies
      // only to JSON/text bodies — check Content-Type first. A
      // multipart upload (media, avatar) legitimately exceeds 6 MB
      // (advertised media cap is 100 MB); multipart bodies get their
      // own streaming cap per route (readCappedMultipartFormData)
      // instead of this gate.
      const contentLength = Number(request.headers.get("Content-Length") ?? "0");
      const contentType = request.headers.get("Content-Type") ?? "";
      const isMultipartBody = contentType.toLowerCase().includes("multipart/form-data");
      if (!isMultipartBody && contentLength > 6 * 1024 * 1024) {
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
      // enabled AND has a stored client id AND a decryptable client
      // secret (L-4): the same predicate as provider registration in
      // better-auth.ts, so the login page never offers a button whose
      // sign-in fails. The secret itself never leaves the server. Same
      // source of truth as the Better Auth instance.
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
            .filter((p) => p.enabled && p.clientId && p.clientSecret)
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
      // favicon points at. M-20: when no favicon is configured (or the
      // stored object is gone) the handler returns the static default
      // instead of 404 — the SPA keeps its built-in default, and the
      // browser stops logging a failed favicon fetch on every load.
      // Cacheable — the object key contains the content hash, so a
      // re-upload changes the key.
      if (method === "GET" && pathname === "/api/v1/favicon") {
        // A-16: SVGs are served with the same sandbox CSP + nosniff
        // as media SVGs (a stored SVG must never execute, even opened
        // top-level directly). nosniff applies to every favicon type.
        const defaultFavicon = () =>
          new Response(DEFAULT_FAVICON_SVG, {
            status: 200,
            headers: {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "public, max-age=86400",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox",
            },
          });
        const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
        if (!maybeDrizzle.drizzleDb) return defaultFavicon();
        const row = await loadGeneralSettings(
          maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0]
        ).catch(() => null);
        if (!row?.faviconObjectKey) {
          return defaultFavicon();
        }
        const bucket = (store as unknown as { r2Bucket?: unknown }).r2Bucket as
          | { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null> }
          | undefined;
        const obj = await bucket?.get(row.faviconObjectKey);
        if (!obj) return defaultFavicon();
        const bytes = await obj.arrayBuffer();
        const faviconContentType = row.faviconContentType ?? "image/png";
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": faviconContentType,
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            ...(faviconContentType === "image/svg+xml"
              ? { "Content-Security-Policy": "sandbox" }
              : {}),
          },
        });
      }

      // 2. Authentication Routes (/api/auth/*)
      if (pathname.startsWith("/api/auth")) {
        await store.checkRateLimit(`auth:${clientIp}`, 60);

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
          const body = (await readJsonBody(request)) as {
            name?: string;
            email?: string;
            password?: string;
            setupToken?: string;
          };
          // L-13(b): a non-string setupToken used to reach
          // setupTokenMatches and throw a bare TypeError (500). A
          // wrong-typed token is simply an invalid token — 403, no hint.
          if (
            typeof body.setupToken !== "string" ||
            !setupTokenMatches(body.setupToken, configuredSetupToken)
          ) {
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
          // L-13(b): validate the shape here so a malformed bootstrap
          // fails 422 at the route instead of a downstream 500/DB
          // error. Name is capped (users.name is unbounded text);
          // email is format-checked and capped at the varchar(320).
          const bootstrapName = body.name.trim();
          const bootstrapEmail = body.email.trim().toLowerCase();
          if (bootstrapName.length === 0 || bootstrapName.length > 200) {
            throw new AppError(
              "VALIDATION_ERROR",
              "name must be 1–200 characters.",
              422
            );
          }
          if (
            bootstrapEmail.length > 320 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail)
          ) {
            throw new AppError(
              "VALIDATION_ERROR",
              "email must be a valid email address.",
              422
            );
          }
          const created = await bootstrapInitialSuperAdmin(store, {
            name: bootstrapName,
            email: bootstrapEmail,
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
              email: bootstrapEmail,
              password: body.password,
            }).catch(() => {});
          }
          return jsonResponse(created, 201);
        }

        if (method === "POST" && pathname === "/api/auth/sign-in") {
          const body = (await readJsonBody(request)) as { email?: string; password?: string };
          if (!body.email || !body.password) {
            throw new AppError("VALIDATION_ERROR", "email and password are required.", 422);
          }
          // C-1: per-account lockout — 10 failed sign-ins in 15 minutes
          // lock the account's sign-in (429). The probe runs BEFORE the
          // password check so a locked account never burns a bcrypt
          // hash; failures increment afterwards, a success clears the
          // bucket. Keyed by email hash (never the raw email) so the
          // bucket key leaks nothing. Unknown emails accumulate too,
          // so a 429 reveals nothing about whether the account exists.
          // F-08 / OD-12 (owner decision pending — behaviour
          // deliberately UNCHANGED here): per-account lockout is also
          // an account-lockout DoS — anyone who knows a staff email
          // can lock that account for 15 minutes at will, repeatedly,
          // and the per-IP bucket does not stop it because the lockout
          // key is per-email. Options for the owner: accept the
          // trade-off (documented), add a CAPTCHA / proof-of-work /
          // IP-reputation step before counting failures toward the
          // lockout, or lock out per (account, IP) instead of per
          // account alone. Do not "fix" this unilaterally — it
          // changes the sign-in security posture.
          const normalizedSignInEmail = body.email.trim().toLowerCase();
          const signInLockoutKey = `signin-fail:${createHash("sha256").update(normalizedSignInEmail, "utf8").digest("hex")}`;
          if (await store.isRateLimited(signInLockoutKey, 10, 15 * 60_000)) {
            throw new AppError(
              "RATE_LIMIT_EXCEEDED",
              "Too many failed sign-in attempts for this account. Try again later.",
              429
            );
          }
          const auth = storeSupportsBetterAuth(store)
            ? await getBetterAuth(env, store)
            : null;
          let signedIn: Awaited<ReturnType<typeof signInStaffSession>>;
          try {
            signedIn = await signInStaffSession(
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
          } catch (error) {
            // Count the failure; the 10th failure answers 429 instead
            // of the underlying 401 (the account just locked).
            await store.checkRateLimit(signInLockoutKey, 10, 15 * 60_000);
            throw error;
          }
          // Success clears the failure bucket, so typos never lock a
          // legitimate user out. Best-effort: a reset failure must
          // never break a successful sign-in.
          await store.resetRateLimit(signInLockoutKey).catch(() => {});
          // A-01: the session token is cookie-only — it is NEVER
          // returned in the JSON body (the SPA never reads the field;
          // any XSS/script/extension/proxy logging bodies could steal
          // a live staff session from it). The cookie below (Better
          // Auth set_cookie, or the HttpOnly stackmate_session cookie
          // on the test-adapter path) is the only channel.
          const payload = {
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
          // L-1: signing out is a cookie-authenticated mutation — a
          // cross-site page must not be able to log the admin out.
          assertSameSiteCookieMutation(request);
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
          // L-1: cookie-authenticated mutation — cross-site requests
          // are blocked before any password work happens.
          assertSameSiteCookieMutation(request);
          const body = (await readJsonBody(request)) as {
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
          const body = (await readJsonBody(request)) as {
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
          // A-06: per-token attempt cap (5/hour, then the invitation
          // is expired) — a brute-forced invitation token cannot be
          // retried indefinitely.
          await capTokenAttempts(`invite-attempt:${sha256Hex(body.token)}`, async () => {
            const pepper = resolveTokenPepper(store, env.ENCRYPTION_KEY_V1);
            await store.withTransaction((state) => {
              const invitation = (state.staff_invitations ?? []).find(
                (i) =>
                  i.status === "pending" &&
                  verifyTokenHash(body.token!, i.token_hash, pepper)
              );
              if (invitation) {
                invitation.status = "expired";
                invitation.updated_at = new Date().toISOString();
                appendAuditLog(state, {
                  actor_type: "system",
                  action: "identity.invitation.expired",
                  resource_type: "staff_invitation",
                  resource_id: invitation.id,
                  outcome: "success",
                  request_id: requestId,
                  changes: { email: invitation.email, reason: "too_many_attempts" },
                });
              }
            });
          });
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
        // of those failed. H-5: a real per-email 60s cooldown, enforced
        // via the store-backed rate limit (the old comment claimed one
        // but no code enforced it). A throttled resend is silently
        // skipped — the generic 200 below is the only answer either
        // way. On a store without a database (in-memory test adapter)
        // there is no SMTP config and no token table — the generic 200
        // is returned with nothing sent.
        // L-21 (accepted trade-off, recorded): the reset / invitation /
        // recovery token travels in the email link's query string
        // (?token=...), so it can land in the recipient's browser
        // history, a proxy log, or a Referer header if the landing page
        // links out before the token is consumed. That is the standard
        // email-link pattern (no password is ever in the URL, the token
        // is single-use, short-lived, and hashed at rest, and the
        // landing page consumes it immediately on load), and replacing
        // it with a code the user types would break the one-click flow
        // the admin UX depends on. The token value is never logged.
        // The link itself is built in modules/email/service.ts.
        if (method === "POST" && pathname === "/api/auth/forgot-password") {
          const body = (await readJsonBodyLenient(request)) as { email?: string };
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
                  // H-5: per-email 60s cooldown, keyed by email hash.
                  // A throttled resend is skipped, not an error — the
                  // generic 200 below is the only answer either way.
                  let cooledDown = false;
                  try {
                    await store.checkRateLimit(
                      `forgot-password:${createHash("sha256").update(email, "utf8").digest("hex")}`,
                      1,
                      60_000
                    );
                  } catch (error) {
                    if (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED") {
                      cooledDown = true;
                    } else {
                      throw error;
                    }
                  }
                  if (!cooledDown) {
                    const token = createPasswordResetToken(store, user.id, "password_reset");
                    await storePasswordResetToken(
                      store, user.id, "password_reset", token.tokenHash, token.expiresAt
                    );
                    await sendEmailViaSmtp(store, env, {
                      to: user.email,
                      ...buildPasswordResetEmail(env.APP_URL, token.rawToken),
                    }).catch(() => {});
                  }
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
          const body = (await readJsonBodyLenient(request)) as {
            token?: string;
            new_password?: string;
          };
          if (!body.token || !body.new_password) {
            throw new AppError("VALIDATION_ERROR", "token and new_password are required.", 422);
          }
          // A-06: per-token attempt cap (5/hour, then the token row is
          // deleted) — a brute-forced reset token cannot be retried
          // indefinitely. On the test adapter there is no token table
          // (tokens live only in Drizzle), so invalidation is a no-op
          // there and the cap alone still binds.
          await capTokenAttempts(`reset-attempt:${sha256Hex(body.token)}`, async () => {
            const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
              | Parameters<typeof loadAuthConfig>[0]
              | undefined;
            if (!db) return;
            await db
              .delete(baPasswordResetTokens)
              .where(
                and(
                  eq(baPasswordResetTokens.tokenHash, sha256Hex(body.token!)),
                  eq(baPasswordResetTokens.purpose, "password_reset")
                )
              )
              .catch(() => {});
          });
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
          const body = (await readJsonBodyLenient(request)) as { email?: string };
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
                  // H-5 (same class as forgot-password): per-email 60s
                  // cooldown on recovery mail. Throttled resends are
                  // skipped, not errors — the generic 200 below is the
                  // only answer either way.
                  let cooledDown = false;
                  try {
                    await store.checkRateLimit(
                      `two-factor-recovery:${createHash("sha256").update(email, "utf8").digest("hex")}`,
                      1,
                      60_000
                    );
                  } catch (error) {
                    if (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED") {
                      cooledDown = true;
                    } else {
                      throw error;
                    }
                  }
                  if (!cooledDown) {
                    const token = createPasswordResetToken(store, user.id, "two_factor_recovery");
                    await storePasswordResetToken(
                      store, user.id, "two_factor_recovery", token.tokenHash, token.expiresAt
                    );
                    await sendEmailViaSmtp(store, env, {
                      to: user.email,
                      ...buildTwoFactorRecoveryEmail(env.APP_URL, token.rawToken),
                    }).catch(() => {});
                  }
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
          const body = (await readJsonBodyLenient(request)) as {
            token?: string;
            password?: string;
          };
          if (!body.token || !body.password) {
            throw new AppError("VALIDATION_ERROR", "token and password are required.", 422);
          }
          // A-06: per-token attempt cap (5/hour, then the recovery
          // token row is deleted) — same rule as reset-password.
          await capTokenAttempts(`recovery-attempt:${sha256Hex(body.token)}`, async () => {
            const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
              | Parameters<typeof loadAuthConfig>[0]
              | undefined;
            if (!db) return;
            await db
              .delete(baPasswordResetTokens)
              .where(
                and(
                  eq(baPasswordResetTokens.tokenHash, sha256Hex(body.token!)),
                  eq(baPasswordResetTokens.purpose, "two_factor_recovery")
                )
              )
              .catch(() => {});
          });
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
        // M-10 (audit fix batch): gate the Better Auth fallback the
        // same way as the custom /api/auth/* routes — unknown paths
        // 404, session paths require a live staff principal (401), and
        // 2FA-setup-required roles are held at 403 except on the setup
        // paths. The check throws and the outer catch turns it into
        // the standard JSON error envelope; it never consumes the
        // request body, so auth.handler below still reads it.
        const { principal: fallbackPrincipal } =
          await checkBetterAuthFallbackAccess(store, {
            auth,
            cookieHeader: request.headers.get("Cookie"),
            bearerToken: extractBearerToken(
              request.headers.get("Authorization")
            ),
            pathname,
          });
        const fallbackResponse = await auth.handler(request);
        // F-03: the fallback used to return Better Auth's raw Response
        // (flat `{ code, message }` errors, no standard headers). JSON
        // responses are re-emitted in the StackMate envelope with the
        // standard headers merged (Set-Cookie preserved — the session
        // cookies must survive the rewrite). Two exceptions:
        //  - non-JSON responses (OAuth 302 redirects, empty bodies)
        //    pass through untouched — wrapping would break the flow;
        //  - /api/auth/two-factor/* keeps its RAW body: the SPA's
        //    rawApiRequest reads `{ totpURI, backupCodes }` directly
        //    from enable, and the spec allows the raw shape there.
        //    Only the headers are standardized on those paths.
        // M-10: audit 2FA state changes that happen through the
        // fallback — Better Auth itself writes no StackMate audit row.
        // Only on a successful response: a failed enable/disable
        // changes nothing. recordTwoFactorStateChange never throws
        // (a failed audit write must not break the 2FA response).
        // A-13: same for update-user — a profile change through the
        // fallback writes an audit row (action
        // `identity.auth.update_user`, distinct from PATCH /me's
        // `identity.profile.name_updated`, which stays the account
        // menu's own audited path).
        if (fallbackResponse.ok && fallbackPrincipal) {
          if (
            pathname === "/api/auth/two-factor/enable" ||
            pathname === "/api/auth/two-factor/disable"
          ) {
            await recordTwoFactorStateChange(store, {
              userId: fallbackPrincipal.user.id,
              enabled: pathname === "/api/auth/two-factor/enable",
              requestId,
            });
          } else if (pathname === "/api/auth/update-user") {
            await store
              .withTransaction((state) => {
                appendAuditLog(state, {
                  actor_type: "staff",
                  actor_user_id: fallbackPrincipal.user.id,
                  action: "identity.auth.update_user",
                  resource_type: "user",
                  resource_id: fallbackPrincipal.user.id,
                  outcome: "success",
                  request_id: requestId,
                });
              })
              .catch(() => {});
          }
        }
        const fallbackContentType =
          fallbackResponse.headers.get("Content-Type") ?? "";
        if (!fallbackContentType.includes("application/json")) {
          return fallbackResponse;
        }
        const fallbackText = await fallbackResponse.text();
        let fallbackBody: unknown = null;
        try {
          fallbackBody = JSON.parse(fallbackText);
        } catch {
          return fallbackResponse;
        }
        const fallbackHeaders = new Headers(
          buildStandardHeaders(requestId, originHeader, trustedOrigins)
        );
        const fallbackCookies =
          typeof fallbackResponse.headers.getSetCookie === "function"
            ? fallbackResponse.headers.getSetCookie()
            : [];
        for (const cookie of fallbackCookies) {
          fallbackHeaders.append("Set-Cookie", cookie);
        }
        const isTwoFactorPath = pathname.startsWith("/api/auth/two-factor/");
        if (isTwoFactorPath) {
          return new Response(JSON.stringify(fallbackBody), {
            status: fallbackResponse.status,
            headers: fallbackHeaders,
          });
        }
        if (fallbackResponse.ok) {
          return new Response(
            JSON.stringify(createSuccessEnvelope(fallbackBody, requestId)),
            { status: fallbackResponse.status, headers: fallbackHeaders }
          );
        }
        const flatError = fallbackBody as { code?: unknown; message?: unknown } | null;
        const flatCode = typeof flatError?.code === "string" ? flatError.code : "";
        const flatMessage =
          typeof flatError?.message === "string" ? flatError.message : "";
        const knownCodes = new Set([
          "VALIDATION_ERROR",
          "BAD_REQUEST",
          "UNAUTHORIZED",
          "FORBIDDEN",
          "NOT_FOUND",
          "GONE",
          "CONFLICT",
          "RATE_LIMIT_EXCEEDED",
          "INTERNAL_ERROR",
        ]);
        const mappedCode = knownCodes.has(flatCode)
          ? (flatCode as
              | "VALIDATION_ERROR"
              | "BAD_REQUEST"
              | "UNAUTHORIZED"
              | "FORBIDDEN"
              | "NOT_FOUND"
              | "GONE"
              | "CONFLICT"
              | "RATE_LIMIT_EXCEEDED"
              | "INTERNAL_ERROR")
          : fallbackResponse.status === 401
            ? "UNAUTHORIZED"
            : fallbackResponse.status === 403
              ? "FORBIDDEN"
              : fallbackResponse.status === 404
                ? "NOT_FOUND"
                : fallbackResponse.status === 429
                  ? "RATE_LIMIT_EXCEEDED"
                  : fallbackResponse.status === 400 ||
                      fallbackResponse.status === 422
                    ? "VALIDATION_ERROR"
                    : "INTERNAL_ERROR";
        return new Response(
          JSON.stringify(
            createErrorEnvelope(
              mappedCode,
              flatMessage || `Better Auth request failed with status ${fallbackResponse.status}.`,
              requestId,
              flatCode && flatCode !== mappedCode ? { better_auth_code: flatCode } : null
            )
          ),
          { status: fallbackResponse.status, headers: fallbackHeaders }
        );
      }

      // 3. License Client API (/api/v1/licenses/*)
      if (pathname.startsWith("/api/v1/licenses")) {
        await store.checkRateLimit(`licenses:${clientIp}`, 120);

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
          const body = await readJsonBody(request);
          // A-04: activation is idempotent per Idempotency-Key. The
          // service itself is naturally idempotent per installation
          // (same installation_id → same activation row, no second
          // seat consumed), so a replay RE-RUNS it for a fresh
          // entitlement token instead of returning a stored one — the
          // token is a bearer credential and is never stored in the
          // idempotency row (A-03 class). The row still guards
          // key-reuse-with-a-different-payload (409).
          const activated = await runIdempotentCommand({
            scope: "license_activate",
            key: request.headers.get("Idempotency-Key"),
            payload: body,
            statusCode: 200,
            fn: () =>
              activateLicenseInstallation(store, body, {
                verifierSecret: env.LICENSE_VERIFIER_SECRET,
                issuerUrl: env.API_URL,
                requestId,
              }),
            redactForStore: (result) => ({ ...result, entitlement_token: null }),
            reissueOnReplay: () =>
              activateLicenseInstallation(store, body, {
                verifierSecret: env.LICENSE_VERIFIER_SECRET,
                issuerUrl: env.API_URL,
                requestId,
              }),
          });
          return jsonResponse(activated.body, 200);
        }

        if (method === "POST" && pathname === "/api/v1/licenses/validate") {
          const body = await readJsonBody(request);
          const result = await validateLicenseInstallation(store, body, {
            verifierSecret: env.LICENSE_VERIFIER_SECRET,
            issuerUrl: env.API_URL,
          });
          return jsonResponse(result, 200);
        }

        if (method === "POST" && pathname === "/api/v1/licenses/deactivate") {
          const body = await readJsonBody(request);
          const result = await deactivateLicenseInstallation(store, body, {
            verifierSecret: env.LICENSE_VERIFIER_SECRET,
            requestId,
          });
          return jsonResponse(result, 200);
        }
      }

      // 4. Public Website & Checkout API (/api/v1/public/*)
      if (pathname.startsWith("/api/v1/public/")) {
        // A-06: tracking ingest does NOT share this bucket (see the
        // handler below — its own per-site + per-IP buckets), so one
        // abusive site/IP can flood tracking_events without starving
        // checkout/catalog.
        const isTrackingIngest =
          method === "POST" && pathname.endsWith("/tracking/events");
        if (!isTrackingIngest) {
          await store.checkRateLimit(`public:${clientIp}`, 120);
        }
        // B-08: the public catalog changes rarely and ADR-0005 blesses
        // 60s staleness — catalog GETs are HTTP-cacheable (60s +
        // 15s stale-while-revalidate). Auth/finance/license/admin
        // responses keep no-store (or no header): only these four
        // catalog GETs carry this header.
        const PUBLIC_CATALOG_CACHE_HEADERS = {
          "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
        };
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

          // B-11: the old `store.queryMetrics.cachedQueries += 1` here
          // was false — the data comes from the uncached full-state
          // load (HYPERDRIVE_NO_CACHE), never a cached read path, so
          // the counter over-reported cached reads. Removed; OD-04
          // (wire real HYPERDRIVE_CACHED or delete it) is still open.
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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(allowedProducts, limit, page, null, 200, PUBLIC_CATALOG_CACHE_HEADERS);
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

          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(packages, limit, page, null, 200, PUBLIC_CATALOG_CACHE_HEADERS);
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
          }, 200, PUBLIC_CATALOG_CACHE_HEADERS);
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
          }, 200, PUBLIC_CATALOG_CACHE_HEADERS);
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
          const rawBody = await readJsonBody(request);
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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(activeMethods, limit, page);
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

          const body = (await readJsonBody(request)) as {
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
          // Storage driver (PLAN §31): evidence lands on the selected
          // driver (R2 or Local); resolveStorageDriver fails closed in
          // staging/production when no real R2 bucket is configured.
          const evidenceDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
          const asset = await uploadPrivatePaymentEvidence(store, {
            orderId: order.id,
            customerId: order.customer_id,
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: evidenceDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
            driver: evidenceDriver,
            // Public checkout route: actor null — its authorization is
            // the site key + checkout token + order reference, verified
            // by this route before the call.
            actor: null,
            requestId,
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
          const rawBody = await readJsonBody(request);
          const submitted = await submitManualPaymentClaim(store, {
            orderPublicReference: publicReference,
            idempotencyKey,
            rawBody,
            requestId,
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
          // A-06: tracking ingest gets its own buckets — per-site
          // (600/min, so one site cannot flood the table) + a lower
          // per-IP cap (60/min) inside that site.
          await store.checkRateLimit(`tracking-site:${siteKey}`, 600);
          await store.checkRateLimit(`tracking:${siteKey}:${clientIp}`, 60);
          const rawBody = await readJsonBody(request);
          const result = await ingestExternalTrackingEvent(store, siteKey, rawBody);
          return jsonResponse(result, 202);
        }

        throw new AppError("FORBIDDEN", "Public site credentials cannot access this route.", 403);
      }

      // 5. Server-to-Server Signed Integration API (/api/v1/integrations/*)
      if (pathname.startsWith("/api/v1/integrations/")) {
        await store.checkRateLimit(`integrations:${clientIp}`, 120);

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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(items, limit, page);
        }

        const mServerOrders = matchPath(
          "/api/v1/integrations/sites/:siteKey/orders",
          pathname
        );
        if (method === "POST" && mServerOrders) {
          const siteKey = mServerOrders.params.siteKey!;
          const rawBodyText = await readCappedText(request);
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
          const parsedJson = parseJsonText(rawBodyText);
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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(packages, limit, page);
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
          const rawBodyText = await readCappedText(request);
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
          const body = (parseJsonText(rawBodyText || "{}")) as { reason?: string };
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
          const rawBodyText = await readCappedText(request);
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
            parseJsonText(rawBodyText)
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
          const rawBodyText = await readCappedText(request);
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
          const result = await ingestLead(store, site, parseJsonText(rawBodyText), requestId);
          return jsonResponse(result, result.created ? 201 : 200);
        }

        // E-06: S2S webhook test (API spec §15, scope webhooks.test).
        // An integrated site tests its webhook subscription from its
        // own server context — distinct from the admin
        // POST /api/v1/admin/webhooks/:id/test. HMAC-authenticated
        // like the other S2S routes; the service reuses the admin test
        // transport.
        const mServerWebhookTest = matchPath(
          "/api/v1/integrations/sites/:siteKey/webhook-test",
          pathname
        );
        if (method === "POST" && mServerWebhookTest) {
          const siteKey = mServerWebhookTest.params.siteKey!;
          const rawBodyText = await readCappedText(request);
          await authenticateSignedServerRequest(store, {
            siteKey,
            requiredScope: "webhooks.test",
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
          const res = await testWebhookForSite(store, siteKey, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
          });
          return jsonResponse(res);
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

        // L-1: CSRF gate for cookie-authenticated state-changing
        // requests (shared helper — Origin, Referer and
        // Sec-Fetch-Site rules; see its definition above).
        assertSameSiteCookieMutation(request);

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

        // A-06: the admin block was unthrottled — a stolen session
        // could hammer expensive handlers without a 429. Per-session
        // + per-IP bucket, 600/min (generous for the SPA's parallel
        // panels; the sign-in lockout bucket below stays separate).
        await store.checkRateLimit(`admin:${principal.user.id}:${clientIp}`, 600);

        // Identity & RBAC routes
        if (method === "GET" && pathname === "/api/v1/admin/me") {
          return jsonResponse(principal);
        }

        if (method === "PATCH" && pathname === "/api/v1/admin/me") {
          // Self-service profile: name ONLY. Email is the login identity
          // (administrator change only) and roles are never self-editable
          // — extra fields in the body are ignored, never applied.
          const body = (await readJsonBody(request)) as {
            name?: unknown;
            avatar_url?: unknown;
          };
          // updateOwnProfile requires a valid name (1–120 chars), so it
          // runs only when a name is actually being changed — an
          // avatar-only PATCH must not 422 on the missing name.
          let updated: StaffPrincipal = principal;
          if (body.name !== undefined) {
            updated = await updateOwnProfile(store, principal, {
              name: body.name,
              requestId,
            });
          }
          // M-23: avatar_url is set at the route (updateOwnProfile owns
          // name only); null clears the avatar. Two forms are accepted
          // and both are stored as the object KEY (never a URL):
          //  - an `avatars/` key returned by POST /me/avatar;
          //  - a media-library content URL
          //    (/api/v1/admin/media/<id>/content), resolved here to
          //    the asset's object key — the asset must exist and be an
          //    image. Anything else (external URLs included) is 422.
          // The UI renders the stored key through GET /me/avatar.
          let avatarUrl: string | null | undefined = (
            updated.user as { avatar_url?: string | null }
          ).avatar_url;
          if (body.avatar_url !== undefined) {
            let key: string | null = null;
            if (body.avatar_url !== null) {
              if (typeof body.avatar_url !== "string") {
                throw new AppError(
                  "VALIDATION_ERROR",
                  "avatar_url must be a string or null.",
                  422,
                );
              }
              if (body.avatar_url.startsWith("avatars/")) {
                key = body.avatar_url;
              } else {
                const mediaMatch = body.avatar_url.match(
                  /^\/api\/v1\/admin\/media\/([^/?#]+)\/content(?:\?.*)?$/,
                );
                if (!mediaMatch) {
                  throw new AppError(
                    "VALIDATION_ERROR",
                    "avatar_url must be an avatar object key returned by POST /api/v1/admin/me/avatar, a media-library content URL, or null to clear.",
                    422,
                  );
                }
                const asset = store.state.media_assets.find((a) => a.id === mediaMatch[1]);
                if (!asset) {
                  throw new AppError("NOT_FOUND", "Media asset not found.", 404);
                }
                if (!asset.mime_type.startsWith("image/")) {
                  throw new AppError("VALIDATION_ERROR", "Avatar must be an image.", 422);
                }
                key = asset.object_key;
              }
            }
            const saved = await store.setStaffAvatarUrl(principal.user.id, key);
            avatarUrl = saved.avatar_url;
          }
          return jsonResponse({ ...updated, avatar_url: avatarUrl ?? null }, 200);
        }

        // M-23: custom avatar upload (D-5). Multipart 'file' (image
        // only, <= 2 MB); stored via the selected storage driver under
        // avatars/<userId>/<uuid>.<ext>; the key is saved as
        // users.avatar_url and served by GET /api/v1/admin/me/avatar.
        // No media-library row — the avatar is a profile asset, not a
        // library asset. The previous object is deleted best-effort.
        if (method === "POST" && pathname === "/api/v1/admin/me/avatar") {
          // A-08: streaming 2 MB multipart cap (never buffer-then-validate).
          const form = await readCappedMultipartFormData(request, 2 * 1024 * 1024);
          const file = form.get("file");
          if (!(file instanceof File)) {
            throw new AppError(
              "VALIDATION_ERROR",
              "A file upload is required (multipart field 'file').",
              422
            );
          }
          const allowedTypes: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "image/gif": "gif",
          };
          const ext = allowedTypes[file.type];
          if (!ext) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Avatar must be a PNG, JPEG, WebP, or GIF image.",
              422
            );
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.length > 2 * 1024 * 1024) {
            throw new AppError("VALIDATION_ERROR", "Avatar must be 2 MB or smaller.", 413);
          }
          // A-17: verify magic bytes (same check as media/evidence
          // uploads) — the client-claimed MIME alone is not trusted.
          // verifyMediaBytes also returns the bytes to store; avatars
          // are never SVG, so the bytes pass through unchanged.
          verifyMediaBytes(bytes, file.type);
          const driver = await resolveStorageDriver(driverDepsForRequest(store, env));
          const key = `avatars/${principal.user.id}/${randomUUID()}.${ext}`;
          await driver.put(key, bytes, file.type);
          const previous = store.state.users.find((u) => u.id === principal.user.id)?.avatar_url;
          const saved = await store.setStaffAvatarUrl(principal.user.id, key);
          if (previous && previous.startsWith("avatars/") && previous !== key) {
            await driver.delete(previous).catch(() => {});
          }
          return jsonResponse({ avatar_url: saved.avatar_url }, 201);
        }

        if (method === "GET" && pathname === "/api/v1/admin/me/avatar") {
          const key = store.state.users.find((u) => u.id === principal.user.id)?.avatar_url;
          if (!key) throw new AppError("NOT_FOUND", "No avatar is set.", 404);
          // B-07: avatar gets the media treatment — the key is
          // content-addressed (a fresh uuid on every upload, so the
          // key changes exactly when the bytes do), so an ETag derived
          // from the key is stable per version and `immutable` is safe
          // (the SPA already cache-busts with ?k=). nosniff included.
          // (Serving from a lightweight single-row lookup instead of
          // the full store load still waits on B-01/A-10: the store
          // is resolved in fetchHandler before routing; this handler
          // itself only reads one user row + one object.)
          const etag = `"${createHash("sha256").update(key, "utf8").digest("hex")}"`;
          const avatarHeaders: Record<string, string> = {
            "Cache-Control": "private, max-age=3600, immutable",
            "X-Content-Type-Options": "nosniff",
            ETag: etag,
          };
          const ifNoneMatch = request.headers.get("if-none-match");
          if (
            ifNoneMatch !== null &&
            (ifNoneMatch.trim() === "*" ||
              ifNoneMatch.split(",").some((tag) => tag.trim() === etag))
          ) {
            return new Response(null, { status: 304, headers: avatarHeaders });
          }
          const driver = await resolveStorageDriver(driverDepsForRequest(store, env));
          const obj = await driver.get(key);
          if (!obj) throw new AppError("NOT_FOUND", "Avatar not found.", 404);
          return new Response(obj.bytes, {
            status: 200,
            headers: { ...avatarHeaders, "Content-Type": obj.contentType },
          });
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const config = await loadAuthConfig(requireAuthConfigDb(), authConfigDeps);
          // Serialize through the view mapper: the raw ResolvedAuthConfig
          // is camelCase (twoFactorPolicy — the page reads
          // two_factor_policy and crashed) and carries the DECRYPTED
          // OAuth secrets / SMTP password. The view is snake_case and
          // secret-free, with defaults even when nothing is configured.
          return jsonResponse(toAuthConfigView(config));
        }
        if (method === "PUT" && pathname === "/api/v1/admin/auth-config/oauth") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as { to?: string };
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const row = await loadGeneralSettings(requireGeneralSettingsDb());
          return jsonResponse(row ? { ...publicViewOf(row), favicon_content_type: row.faviconContentType, favicon_byte_size: row.faviconByteSize } : { ...DEFAULT_GENERAL_SETTINGS, favicon_content_type: null, favicon_byte_size: null });
        }
        if (method === "PUT" && pathname === "/api/v1/admin/general-settings") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBody(request)) as {
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
          // Storage driver (PLAN §31): the favicon lands on the selected
          // driver (R2 or Local); resolveStorageDriver fails closed in
          // staging/production when no real R2 bucket is configured.
          const faviconDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
          const bytes = new Uint8Array(Buffer.from(body.content_base64, "base64"));
          const stored = await storeFavicon(requireGeneralSettingsDb(), faviconDriver, {
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: faviconDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
          });
          await auditGeneralSettingsChange({ favicon_uploaded: true, content_type: stored.content_type });
          return jsonResponse(stored, 201);
        }

        // Media library + storage driver settings (PLAN §31 / ADR-0011).
        // Objects stay private; the API never returns raw storage keys or
        // public URLs — downloads go through the authenticated content
        // endpoint below. Uploads are multipart FormData (files can be
        // 100 MB); the favicon / payment-evidence JSON+base64 flows are
        // unchanged, only the storage driver underneath moved.
        const requireMediaDb = () => {
          const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
          if (!maybeDrizzle.drizzleDb) {
            throw new AppError("STORE_UNAVAILABLE", "Media library requires a database.", 503);
          }
          return maybeDrizzle.drizzleDb as Parameters<typeof listMediaAssets>[0];
        };
        const auditMediaChange = (
          action: string,
          resourceId: string,
          changes: Record<string, unknown>
        ) =>
          store
            .withTransaction((state) => {
              appendAuditLog(state, {
                actor_type: "staff",
                actor_user_id: principal.user.id,
                action,
                resource_type: "media_asset",
                resource_id: resourceId,
                outcome: "success",
                request_id: requestId,
                changes,
              });
            })
            .catch(() => {});

        if (method === "GET" && pathname === "/api/v1/admin/media") {
          await assertStaffPermissionAudited(store, principal, "media.view", requestId);
          const result = await listMediaAssets(requireMediaDb(), {
            q: url.searchParams.get("q") ?? undefined,
            kind: (url.searchParams.get("kind") ?? undefined) as
              | "image"
              | "video"
              | "audio"
              | "document"
              | "archive"
              | "other"
              | undefined,
            folder: url.searchParams.get("folder") ?? undefined,
            mimes: url.searchParams.get("mime")
              ? url.searchParams.get("mime")!.split(",")
              : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            offset: url.searchParams.get("offset")
              ? Number(url.searchParams.get("offset"))
              : undefined,
          });
          return jsonResponse(result);
        }

        // Folders BEFORE the :id match — "folders" would otherwise match :id.
        if (method === "GET" && pathname === "/api/v1/admin/media/folders") {
          await assertStaffPermissionAudited(store, principal, "media.view", requestId);
          const folders = await listMediaFolders(requireMediaDb());
          return jsonResponse({ folders });
        }

        if (method === "POST" && pathname === "/api/v1/admin/media") {
          await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
          // A-08: streaming 100 MB multipart cap (MAX_MEDIA_BYTES).
          const form = await readCappedMultipartFormData(request, MAX_MEDIA_BYTES);
          const file = form.get("file");
          if (!(file instanceof File)) {
            throw new AppError(
              "VALIDATION_ERROR",
              "A file upload is required (multipart field 'file').",
              422
            );
          }
          const tags = form.getAll("tags").map((t) => String(t));
          // Browser-generated thumbnails (PLAN §34): 320px + 64px WebP
          // variants, uploaded together with the original. Absent when
          // the browser could not generate them — the upload proceeds
          // without thumbnails and the UI falls back to the original.
          const thumbFile = form.get("thumbnail");
          const thumbSmallFile = form.get("thumbnail_small");
          const asset = await uploadMediaAsset(
            requireMediaDb(),
            driverDepsForRequest(store, env),
            {
              bytes: new Uint8Array(await file.arrayBuffer()),
              declaredMimeType: file.type || "application/octet-stream",
              filename: file.name,
              folder:
                typeof form.get("folder") === "string"
                  ? (form.get("folder") as string)
                  : undefined,
              tags: tags.length > 0 ? tags : undefined,
              thumbnails: {
                thumb:
                  thumbFile instanceof File
                    ? {
                        bytes: new Uint8Array(await thumbFile.arrayBuffer()),
                        declaredMimeType: thumbFile.type || "image/webp",
                      }
                    : undefined,
                small:
                  thumbSmallFile instanceof File
                    ? {
                        bytes: new Uint8Array(await thumbSmallFile.arrayBuffer()),
                        declaredMimeType: thumbSmallFile.type || "image/webp",
                      }
                    : undefined,
              },
            },
            principal.user.id
          );
          await auditMediaChange("media.uploaded", asset.id, {
            filename: asset.original_filename,
            mime_type: asset.mime_type,
            byte_size: asset.byte_size,
            folder: asset.folder,
            driver: asset.driver,
          });
          return jsonResponse(asset, 201);
        }

        const mMediaDetail = matchPath("/api/v1/admin/media/:id", pathname);
        if (mMediaDetail) {
          const mediaId = mMediaDetail.params.id!;
          if (method === "GET") {
            await assertStaffPermissionAudited(store, principal, "media.view", requestId);
            const row = await requireMediaAsset(requireMediaDb(), mediaId);
            return jsonResponse(mediaViewOf(row));
          }
          if (method === "PATCH") {
            await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
            const body = (await readJsonBodyLenient(request)) as {
              original_filename?: string;
              folder?: string;
              tags?: string[];
            };
            const db = requireMediaDb();
            let view = mediaViewOf(await requireMediaAsset(db, mediaId));
            const changes: Record<string, unknown> = {};
            if (body.original_filename !== undefined) {
              view = await renameMediaAsset(db, mediaId, body.original_filename);
              changes.original_filename = view.original_filename;
            }
            if (body.folder !== undefined) {
              view = await moveMediaAsset(db, mediaId, body.folder);
              changes.folder = view.folder;
            }
            if (body.tags !== undefined) {
              view = await setMediaAssetTags(db, mediaId, body.tags);
              changes.tags = view.tags;
            }
            if (Object.keys(changes).length === 0) {
              throw new AppError(
                "VALIDATION_ERROR",
                "Nothing to update — pass original_filename, folder, or tags.",
                422
              );
            }
            await auditMediaChange("media.updated", mediaId, changes);
            return jsonResponse(view);
          }
          if (method === "DELETE") {
            await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
            const db = requireMediaDb();
            const row = await requireMediaAsset(db, mediaId);
            await deleteMediaAsset(db, driverDepsForRequest(store, env), mediaId);
            await auditMediaChange("media.deleted", mediaId, {
              filename: row.originalFilename,
              mime_type: row.mimeType,
              byte_size: Number(row.byteSize),
            });
            return jsonResponse({ deleted: true, id: mediaId });
          }
        }

        const mMediaThumbnail = matchPath("/api/v1/admin/media/:id/thumbnail", pathname);
        if (method === "POST" && mMediaThumbnail) {
          // PLAN §34: regenerate thumbnails for an existing image —
          // the backfill path for pre-0013 files (the browser
          // generates the variants from the loaded original).
          await assertStaffPermissionAudited(store, principal, "media.manage", requestId);
          // A-08: streaming multipart cap (thumbnails are small WebP variants; the media cap is the ceiling).
          const form = await readCappedMultipartFormData(request, MAX_MEDIA_BYTES);
          const thumbFile = form.get("thumbnail");
          const thumbSmallFile = form.get("thumbnail_small");
          const asset = await regenerateMediaThumbnail(
            requireMediaDb(),
            driverDepsForRequest(store, env),
            mMediaThumbnail.params.id!,
            {
              thumb:
                thumbFile instanceof File
                  ? {
                      bytes: new Uint8Array(await thumbFile.arrayBuffer()),
                      declaredMimeType: thumbFile.type || "image/webp",
                    }
                  : undefined,
              small:
                thumbSmallFile instanceof File
                  ? {
                      bytes: new Uint8Array(await thumbSmallFile.arrayBuffer()),
                      declaredMimeType: thumbSmallFile.type || "image/webp",
                    }
                  : undefined,
            },
          );
          await auditMediaChange("media.thumbnail_regenerated", asset.id, {
            original_filename: asset.original_filename,
            thumb_url: asset.thumb_url,
            thumb_small_url: asset.thumb_small_url,
          });
          return jsonResponse(asset);
        }

        const mMediaContent = matchPath("/api/v1/admin/media/:id/content", pathname);
        if (method === "GET" && mMediaContent) {
          await assertStaffPermissionAudited(store, principal, "media.view", requestId);
          const url = new URL(request.url);
          const variantRaw = url.searchParams.get("variant");
          const variant =
            variantRaw === null
              ? "original"
              : variantRaw === "thumb"
                ? "thumb"
                : variantRaw === "small"
                  ? "small"
                  : null;
          if (variant === null) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Unknown variant. Use variant=thumb or variant=small.",
              422,
            );
          }
          let content;
          try {
            content = await getMediaAssetContent(
              requireMediaDb(),
              driverDepsForRequest(store, env),
              mMediaContent.params.id!,
              { variant, rangeHeader: request.headers.get("range") },
            );
          } catch (err) {
            if (err instanceof AppError && err.code === "RANGE_NOT_SATISFIABLE") {
              // 416 needs Content-Range: bytes */<size> — build it here
              // rather than letting the generic envelope swallow it.
              const size = (err.details as { size?: unknown } | null)?.size;
              return new Response("Requested range not satisfiable.", {
                status: 416,
                headers: {
                  "Content-Range": `bytes */${typeof size === "number" ? size : "*"}`,
                  "Accept-Ranges": "bytes",
                  "Cache-Control": "no-store",
                },
              });
            }
            throw err;
          }
          const safeFilename = content.row.originalFilename.replace(/["\\\r\n]/g, "");
          // M-19: ?download=1 forces a save-as download instead of the
          // default inline preview (ADR-0011 open item).
          const download = url.searchParams.get("download") === "1";
          const headers: Record<string, string> = {
            "Content-Type": content.mimeType,
            "Content-Disposition": download
              ? `attachment; filename="${safeFilename}"`
              : `inline; filename="${safeFilename}"`,
            "Cache-Control": "private, max-age=3600, immutable",
            "X-Content-Type-Options": "nosniff",
            "Accept-Ranges": "bytes",
            ETag: content.etag,
            "Content-Length": String(
              content.range !== null
                ? content.range.end - content.range.start + 1
                : content.size,
            ),
          };
          if (content.mimeType === "image/svg+xml") {
            // Stored SVGs are sanitized on upload, but never let one
            // execute even if opened top-level directly.
            headers["Content-Security-Policy"] = "sandbox";
          }
          // Conditional request: the ETag is derived from the stored
          // checksum, so a client that already has the bytes gets a
          // 304 without the Worker streaming anything.
          const ifNoneMatch = request.headers.get("if-none-match");
          if (
            ifNoneMatch !== null &&
            (ifNoneMatch.trim() === "*" ||
              ifNoneMatch.split(",").some((tag) => tag.trim() === content.etag))
          ) {
            return new Response(null, { status: 304, headers });
          }
          if (content.range !== null) {
            headers["Content-Range"] =
              `bytes ${content.range.start}-${content.range.end}/${content.size}`;
            return new Response(content.body, { status: 206, headers });
          }
          return new Response(content.body, { status: 200, headers });
        }

        // Storage driver settings (PLAN §31 / ADR-0011): Settings → Storage.
        // The selected driver is runtime-applied. Switching never orphans
        // library files (rows carry their own driver) but DOES orphan the
        // favicon + payment evidence stored under the previous driver
        // until switched back — the UI warns about this explicitly.
        if (method === "GET" && pathname === "/api/v1/admin/storage-settings") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const settings = await loadStorageSettings(requireMediaDb()).catch(() => null);
          return jsonResponse(settings ?? DEFAULT_STORAGE_SETTINGS);
        }
        if (method === "PUT" && pathname === "/api/v1/admin/storage-settings") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
            driver?: "r2" | "local";
            local_path?: string | null;
          };
          const saved = await saveStorageSettings(requireMediaDb(), body);
          await store
            .withTransaction((state) => {
              appendAuditLog(state, {
                actor_type: "staff",
                actor_user_id: principal.user.id,
                action: "storage.settings.updated",
                resource_type: "storage_settings",
                resource_id: "storage-settings",
                outcome: "success",
                request_id: requestId,
                changes: { driver: saved.driver, local_path: saved.local_path },
              });
            })
            .catch(() => {});
          return jsonResponse(saved);
        }

        if (method === "GET" && pathname === "/api/v1/admin/users") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          // H-03: ?status=active narrows the combobox/server list to
          // active staff (unknown values match nothing, unknown params
          // are ignored).
          const statusFilter = url.searchParams.get("status");
          const users = store.state.users
              .filter((u) => (!statusFilter ? true : u.status === statusFilter))
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
              });
          return pagedCollectionResponse(users, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/users") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBody(request)) as {
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = (await readJsonBody(request)) as { role_keys: string[] };
          // L-13: role_keys must be an array — a string used to reach
          // updateStaffUserRoles and throw a bare TypeError (500).
          if (!body || typeof body !== "object" || !Array.isArray(body.role_keys)) {
            throw new AppError(
              "VALIDATION_ERROR",
              "role_keys must be an array of role keys.",
              422
            );
          }
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(store.state.roles, limit, page);
        }

        if (method === "GET" && pathname === "/api/v1/admin/permissions") {
          // L-5: the permission catalogue is readable only to staff who
          // can manage users/roles (same gate as /roles) — it leaks the
          // RBAC surface otherwise. Deliberately NOT paged (M-1): it is
          // a fixed catalogue, not a table, so it cannot grow
          // unboundedly; the role editor needs the whole list at once.
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          return collectionResponse([...store.allPermissions]);
        }

        // Batch 1: Roles & staff invitations.
        // NOTE (API Spec §8 vs seed catalogue): the spec names
        // users.invite / roles.create / roles.update, but those keys do
        // NOT exist in the seeded permission catalogue — the existing
        // users.manage key ("Manage staff users, roles, and permissions")
        // is the equivalent gate and is used for all role + invitation
        // writes. Invitations ARE emailed when SMTP is configured
        // (Auth + Email batch; the POST /users/invitations handler
        // reports email_sent / email_error honestly) — the one-time
        // token is still returned once, as the delivery path when
        // email is not configured.
        if (method === "POST" && pathname === "/api/v1/admin/roles") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = await readJsonBody(request);
          const created = await createRoleByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mRoleDetail = matchPath("/api/v1/admin/roles/:roleId", pathname);
        if (method === "PATCH" && mRoleDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          const items = (store.state.staff_invitations ?? []).map((inv) => {
            const { token_hash: _h, ...safe } = inv;
            return safe;
          });
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/users/invitations") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
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

        // Staff suspension (audit H-3): PATCH …/suspend + …/unsuspend.
        // No dispatcher assert here on purpose — the service functions
        // assert users.manage via assertStaffPermissionAudited, so a
        // denial is written to the audit log; a plain dispatcher assert
        // would throw first and the denial would never be recorded.
        // Suspend revokes every session of the target (the service
        // also refuses self-suspension with 409); unsuspend restores
        // the account without re-issuing sessions.
        const mUserSuspend = matchPath("/api/v1/admin/users/:userId/suspend", pathname);
        if (method === "PATCH" && mUserSuspend) {
          const result = await suspendStaffUser(
            store,
            principal,
            mUserSuspend.params.userId!,
            requestId
          );
          return jsonResponse(result);
        }

        const mUserUnsuspend = matchPath(
          "/api/v1/admin/users/:userId/unsuspend",
          pathname
        );
        if (method === "PATCH" && mUserUnsuspend) {
          const result = await unsuspendStaffUser(
            store,
            principal,
            mUserUnsuspend.params.userId!,
            requestId
          );
          return jsonResponse(result);
        }

        // Products, Features, Packages & Prices
        if (method === "GET" && pathname === "/api/v1/admin/products") {
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.products
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/products") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "products.create", requestId);
          const body = await readJsonBody(request);
          const created = await createProduct(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mProductDetail = matchPath("/api/v1/admin/products/:productId", pathname);
        if (method === "GET" && mProductDetail) {
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "products.update", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "products.update", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "products.update", requestId);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.product_features
            .filter((f) => f.product_id === mProductFeatures.params.productId)
            .filter((f) => includesQuery(f.name, q) || includesQuery(f.feature_key, q))
            .map((f) => withFeatureUsage(store.state, f));
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && mProductFeatures) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const pkgs = store.state.product_packages
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
            }));
          return pagedCollectionResponse(pkgs, limit, page);
        }

        if (method === "POST" && mProductPackages) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = (await readJsonBody(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.publish", requestId);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const prices = store.state.package_prices.filter(
            (pr) => pr.package_version_id === mVerPrices.params.versionId
          );
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(prices, limit, page);
        }

        if (method === "POST" && mVerPrices) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const feature = store.state.product_features.find(
            (f) =>
              f.id === mFeatureDetail.params.featureId &&
              f.product_id === mFeatureDetail.params.productId
          );
          if (!feature) throw new AppError("NOT_FOUND", "Product feature not found.", 404);
          return jsonResponse(withFeatureUsage(store.state, feature));
        }

        if (method === "PATCH" && mFeatureDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.publish", requestId);
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          const price = store.state.package_prices.find(
            (pr) => pr.id === mPriceDetail.params.priceId
          );
          if (!price) throw new AppError("NOT_FOUND", "Package price not found.", 404);
          return jsonResponse(price);
        }

        if (method === "PATCH" && mPriceDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.customers
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/customers") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
          const customer = await createCustomerByAdmin(store, principal, body, requestId);
          return jsonResponse(customer, 201);
        }

        const mCustDetail = matchPath("/api/v1/admin/customers/:customerId", pathname);
        if (method === "GET" && mCustDetail) {
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
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
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
          const statusFilter = url.searchParams.get("payment_status");
          // H-03: ?open_only=true narrows to orders with a balance due
          // (remaining > 0 from verified payments) — the payment-review
          // order picker. Unknown params are ignored.
          const openOnly = url.searchParams.get("open_only") === "true";
          const { q, limit, page } = parseListQuery(url.searchParams);
          const filteredOrders = store.state.orders
            .filter((o) => (!statusFilter ? true : o.payment_status === statusFilter))
            .filter((o) => (!openOnly ? true : computeOrderRemaining(store.state, o) > 0))
            .filter(
              (o) =>
                includesQuery(o.order_number, q) ||
                includesQuery(o.public_reference, q) ||
                includesQuery(
                  store.state.customers.find((c) => c.id === o.customer_id)?.name,
                  q,
                ),
            );
          // Dashboard ordering: sort BEFORE the ?limit=100 window slices,
          // otherwise the newest rows past 100 never reach the client
          // (the dashboard panels sort client-side over the loaded set).
          const items = sortByTimestamp(
            filteredOrders,
            "created_at",
            parseTimestampSort(url.searchParams, "created_at"),
          ).map((o) => ({
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/orders") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.create", requestId);
          const body = await readJsonBody(request);
          // F-12: the order's on_date boundary is a business date in the
          // configured timezone (defaults to Asia/Dhaka inside the
          // service when omitted).
          // A-04: admin order creation is idempotent per
          // Idempotency-Key (a retried create after a network timeout
          // replays the first order instead of minting a second).
          const created = await runIdempotentCommand({
            scope: "admin_order_create",
            key: request.headers.get("Idempotency-Key"),
            payload: body,
            statusCode: 201,
            fn: () =>
              createOrderByAdmin(store, principal, body, requestId, {
                timeZone: env.DEFAULT_TIMEZONE,
              }),
          });
          return jsonResponse(created.body, created.replayed ? 200 : 201);
        }

        const mOrderAdminDetail = matchPath("/api/v1/admin/orders/:orderId", pathname);
        if (method === "GET" && mOrderAdminDetail) {
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
          const order = store.state.orders.find((o) => o.id === mOrderAdminDetail.params.orderId);
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          return jsonResponse({
            ...order,
            // E-19: attribution is stored per order (UTM + fbp/fbc —
            // order_attributions has no referrer column, so there is
            // none to show) — surfaced explicitly instead of relying
            // on the spread above, so the SPA can render it on order
            // detail (PRD §15.5).
            attribution: order.attribution ?? null,
            // E-08: per-item entitlement snapshots, aggregated at
            // order level for the snapshot card (each item already
            // carries its own entitlement_snapshot; this is the same
            // data, one level up, so detail never has to dig into
            // items to show what was actually sold).
            entitlement_snapshot: order.items.map((i) => i.entitlement_snapshot),
            // Site name for the detail page: the order shows source
            // "website" but never named the site (live gap on ORD-10005,
            // a Test-site order). Null for admin orders (no site).
            site_name:
              order.integrated_site_id === null
                ? null
                : store.state.integrated_sites.find(
                    (s) => s.id === order.integrated_site_id
                  )?.name ?? null,
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

        // E-08: save a (custom) order's configuration as a reusable
        // package (PRD §8.2). 201 with the created package.
        const mOrderSaveAsPackage = matchPath(
          "/api/v1/admin/orders/:orderId/save-as-package",
          pathname
        );
        if (method === "POST" && mOrderSaveAsPackage) {
          // M-9: saving as a package creates a package — packages.manage.
          await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
          const body = await readJsonBody(request);
          const created = await saveOrderAsPackage(
            store,
            principal,
            mOrderSaveAsPackage.params.orderId!,
            body,
            requestId
          );
          return jsonResponse(created, 201);
        }

        if (method === "GET" && pathname === "/api/v1/admin/invoices") {
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(store.state.invoices, limit, page);
        }

        // Batch 1: customer update + per-customer collections.
        // (Customer detail already embeds orders/subscriptions/licenses;
        // these filtered collections are the list views the SPA needs.)
        if (method === "PATCH" && mCustDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const customer = store.state.customers.find(
            (c) => c.id === mCustOrders.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.orders
              .filter((o) => o.customer_id === customer.id)
              .map((o) => ({
                ...o,
                paid_amount_minor: computeOrderPaid(store.state, o.id),
                remaining_minor: computeOrderRemaining(store.state, o),
              })),
            limit, page
          );
        }

        const mCustSubs = matchPath(
          "/api/v1/admin/customers/:customerId/subscriptions",
          pathname
        );
        if (method === "GET" && mCustSubs) {
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const customer = store.state.customers.find(
            (c) => c.id === mCustSubs.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.subscriptions.filter((s) => s.customer_id === customer.id),
            limit, page
          );
        }

        const mCustLicenses = matchPath(
          "/api/v1/admin/customers/:customerId/licenses",
          pathname
        );
        if (method === "GET" && mCustLicenses) {
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const customer = store.state.customers.find(
            (c) => c.id === mCustLicenses.params.customerId
          );
          if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.licenses
              .filter((l) => l.customer_id === customer.id)
              .map(({ license_key_hash: _h, issued_raw_key_once: _r, ...safe }) => safe),
            limit, page
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            await listCustomerAddresses(store, principal, mCustAddresses.params.customerId!),
            limit, page
          );
        }
        if (method === "POST" && mCustAddresses) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            await listCustomerReports(store, principal, mCustReports.params.customerId!),
            limit, page
          );
        }
        if (method === "POST" && mCustReports) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
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
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.licenses
              .filter((l) => l.customer_id === mCustInstallations.params.customerId)
              .flatMap((l) =>
                l.activations.map((a) => ({
                  ...a,
                  license_number: l.license_number,
                  product_id: l.product_id,
                }))
              ),
            limit, page
          );
        }

        const mCustActivity = matchPath(
          "/api/v1/admin/customers/:customerId/activity",
          pathname
        );
        if (method === "GET" && mCustActivity) {
          await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.audit_logs
              .filter(
                (a) =>
                  a.resource_id === customer.id ||
                  (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
                  (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
                  (a.resource_type === "license" && licenseIds.has(a.resource_id))
              )
              .slice(-100)
              .reverse(),
            limit, page
          );
        }

        const mCustTickets = matchPath(
          "/api/v1/admin/customers/:customerId/tickets",
          pathname
        );
        if (method === "GET" && mCustTickets) {
          await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.support_tickets.filter(
              (t) => t.customer_id === mCustTickets.params.customerId
            ),
            limit, page
          );
        }

        // Batch 1: order lifecycle + invoice writes.
        const mOrderCancel = matchPath("/api/v1/admin/orders/:orderId/cancel", pathname);
        if (method === "POST" && mOrderCancel) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as { reason?: string };
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
          const order = store.state.orders.find(
            (o) => o.id === mOrderInvoices.params.orderId
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.invoices.filter((i) => i.order_id === order.id),
            limit, page
          );
        }

        if (method === "POST" && mOrderInvoices) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
          const order = store.state.orders.find(
            (o) => o.id === mOrderInstallments.params.orderId
          );
          if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.order_installments
              .filter((i) => i.order_id === order.id)
              .sort((a, b) => a.installment_number - b.installment_number)
              .map((i) => ({
                ...i,
                due_date_display: formatDisplayDateDDMMYYYY(
                  `${i.due_date}T00:00:00.000Z`,
                  env.DEFAULT_TIMEZONE
                ),
              })),
            limit, page
          );
        }
        const mOrderInstallmentDetail = matchPath(
          "/api/v1/admin/orders/:orderId/installments/:installmentId",
          pathname
        );
        if (method === "PATCH" && mOrderInstallmentDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as { reason?: string };
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
          await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
          const statusFilter = url.searchParams.get("status");
          const priorityFilter = url.searchParams.get("priority");
          const customerFilter = url.searchParams.get("customer_id");
          const assigneeFilter = url.searchParams.get("assignee_user_id");
          const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
          const { limit, page } = parseListQuery(url.searchParams);
          const items = store.state.support_tickets
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }
        if (method === "POST" && pathname === "/api/v1/admin/tickets") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
          const body = await readJsonBody(request);
          const ticket = await createTicketByAdmin(store, principal, body, requestId);
          return jsonResponse(ticket, 201);
        }
        const mTicketDetail = matchPath("/api/v1/admin/tickets/:ticketId", pathname);
        if (method === "GET" && mTicketDetail) {
          await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tickets.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "leads.view", requestId);
          const statusFilter = url.searchParams.get("status");
          const siteFilter = url.searchParams.get("source_site_id");
          const campaignFilter = url.searchParams.get("utm_campaign");
          const fromFilter = url.searchParams.get("from");
          const toFilter = url.searchParams.get("to");
          const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
          const { limit, page } = parseListQuery(url.searchParams);
          const items = store.state.leads
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }
        if (method === "POST" && pathname === "/api/v1/admin/leads") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
          const body = await readJsonBody(request);
          const lead = await createLeadByAdmin(store, principal, body, requestId);
          return jsonResponse(lead, 201);
        }
        const mLeadDetail = matchPath("/api/v1/admin/leads/:leadId", pathname);
        if (method === "GET" && mLeadDetail) {
          await assertStaffPermissionAudited(store, principal, "leads.view", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "leads.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          return jsonResponse(getReminderSettings(store.state));
        }
        if (method === "PUT" && pathname === "/api/v1/admin/reminder-settings") {
          await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
          const body = await readJsonBody(request);
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
          // H-1: the admin evidence upload is a privileged write —
          // require payments.approve at the route (the service asserts
          // it again when the principal is passed as actor below).
          await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
          const body = (await readJsonBody(request)) as {
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
          // Storage driver (PLAN §31): evidence lands on the selected
          // driver (R2 or Local); resolveStorageDriver fails closed in
          // staging/production when no real R2 bucket is configured.
          // (This route previously had no fail-closed check — the resolver
          // now applies the rule uniformly to both evidence routes.)
          const adminEvidenceDriver = await resolveStorageDriver(
            driverDepsForRequest(store, env)
          );
          const asset = await uploadPrivatePaymentEvidence(store, {
            orderId: order.id,
            customerId: order.customer_id,
            filename: body.filename,
            contentType: body.content_type,
            bytes,
            bucketName: adminEvidenceDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
            driver: adminEvidenceDriver,
            // H-1: pass the staff principal so the service-level
            // payments.approve check and the staff audit row fire.
            actor: principal,
            requestId,
          });
          return jsonResponse(asset, 201);
        }

        // Payment Providers, Methods, Submissions & Verification
        if (method === "GET" && pathname === "/api/v1/admin/payment-providers") {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.payment_providers.filter((p) => includesQuery(p.display_name, q)),
            limit, page
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/payment-methods") {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          // H-03: ?is_enabled=true/false narrows the combobox/server
          // list to enabled/disabled methods. Unknown params ignored.
          const isEnabledParam = url.searchParams.get("is_enabled");
          const enabledFilter =
            isEnabledParam === "true" ? true : isEnabledParam === "false" ? false : null;
          const { q, limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.payment_methods
              .filter((m) => (enabledFilter === null ? true : m.is_enabled === enabledFilter))
              .filter((m) => includesQuery(m.display_name, q)),
            limit, page
          );
        }

        if (method === "POST" && pathname === "/api/v1/admin/payment-methods") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const body = await readJsonBody(request);
          const created = await createPaymentMethodByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        // Batch 1: payment provider + method lifecycle writes.
        if (method === "POST" && pathname === "/api/v1/admin/payment-providers") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const body = await readJsonBody(request);
          const created = await createPaymentProviderByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mProviderDetail = matchPath(
          "/api/v1/admin/payment-providers/:providerId",
          pathname
        );
        if (method === "PATCH" && mProviderDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const body = await readJsonBody(request);
          const updated = await updatePaymentProviderByAdmin(
            store,
            principal,
            mProviderDetail.params.providerId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        // E-16: delete a payment provider (PRD §11.2 lifecycle).
        // Same guard pattern as webhook-endpoint delete: history is
        // preserved, the provider row goes.
        if (method === "DELETE" && mProviderDetail) {
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const deleted = await deletePaymentProviderByAdmin(
            store,
            principal,
            mProviderDetail.params.providerId!,
            requestId
          );
          return jsonResponse(deleted);
        }

        const mMethodDetail = matchPath("/api/v1/admin/payment-methods/:methodId", pathname);
        if (method === "GET" && mMethodDetail) {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const methodRec = store.state.payment_methods.find(
            (m) => m.id === mMethodDetail.params.methodId
          );
          if (!methodRec) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
          return jsonResponse(methodRec);
        }

        if (method === "PATCH" && mMethodDetail) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const body = await readJsonBody(request);
          const updated = await updatePaymentMethodByAdmin(
            store,
            principal,
            mMethodDetail.params.methodId!,
            body,
            requestId
          );
          return jsonResponse(updated);
        }

        // E-16: delete a payment method (PRD §11.2 lifecycle).
        // Same guard pattern as webhook-endpoint delete.
        if (method === "DELETE" && mMethodDetail) {
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
          const deleted = await deletePaymentMethodByAdmin(
            store,
            principal,
            mMethodDetail.params.methodId!,
            requestId
          );
          return jsonResponse(deleted);
        }

        const mMethodEnable = matchPath(
          "/api/v1/admin/payment-methods/:methodId/enable",
          pathname
        );
        if (method === "POST" && mMethodEnable) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
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
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const sub = store.state.payment_submissions.find(
            (s) => s.id === mSubmissionHistory.params.submissionId
          );
          if (!sub) throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.payment_verification_logs.filter(
              (l) => l.payment_submission_id === sub.id
            ),
            limit, page
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/payment-submissions") {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const statusFilter = url.searchParams.get("status");
          const filteredSubmissions = store.state.payment_submissions.filter(
            (s) => (!statusFilter ? true : s.status === statusFilter),
          );
          // M-22: deterministic newest-first order (submitted_at DESC,
          // id ASC) — the SPA's "transient inconsistency" was partly
          // this list arriving unsorted while the client paginated.
          // ?sort=submitted_at:asc flips the time direction; anything
          // else keeps the M-22 default. Sorted BEFORE the window
          // slices, so the ?limit=100 window holds the newest rows.
          const items = sortByTimestamp(
            filteredSubmissions,
            "submitted_at",
            parseTimestampSort(url.searchParams, "submitted_at"),
          ).map((s) => {
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
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(items, limit, page);
        }

        const mSubmissionApprove = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId/approve",
          pathname
        );
        if (method === "POST" && mSubmissionApprove) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
          const body = await readJsonBody(request);
          // A-04: approval is idempotent per Idempotency-Key. The
          // stored replay body must NEVER hold plaintext license keys
          // (A-03 class): issued_license_key_once values are stored
          // ENCRYPTED under the master key (same at-rest protection as
          // site credential secrets) and decrypted on replay.
          const approved = await runIdempotentCommand({
            scope: `admin_payment_approve:${mSubmissionApprove.params.submissionId}`,
            key: request.headers.get("Idempotency-Key"),
            payload: body,
            statusCode: 200,
            fn: () =>
              approvePaymentSubmissionByStaff(
                store,
                principal,
                mSubmissionApprove.params.submissionId!,
                body,
                {
                  licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
                  requestId,
                  timeZone: env.DEFAULT_TIMEZONE,
                }
              ),
            redactForStore: (result) => ({
              ...result,
              issued_licenses: result.issued_licenses.map((il) => ({
                ...il,
                issued_license_key_once: encryptSecretAtRest(
                  il.issued_license_key_once,
                  env.ENCRYPTION_KEY_V1,
                  env.ACTIVE_ENCRYPTION_KEY_VERSION,
                  `idempotency:admin_payment_approve:${mSubmissionApprove.params.submissionId}`
                ),
              })),
            }),
            reissueOnReplay: (stored) => {
              const storedResult = stored as {
                issued_licenses?: Array<{
                  issued_license_key_once?: string;
                  [key: string]: unknown;
                }>;
                [key: string]: unknown;
              };
              return {
                ...storedResult,
                issued_licenses: (storedResult.issued_licenses ?? []).map((il) => ({
                  ...il,
                  issued_license_key_once: il.issued_license_key_once
                    ? decryptSecretAtRest(
                        il.issued_license_key_once,
                        env.ENCRYPTION_KEY_V1,
                        `idempotency:admin_payment_approve:${mSubmissionApprove.params.submissionId}`
                      )
                    : il.issued_license_key_once,
                })),
              } as Awaited<ReturnType<typeof approvePaymentSubmissionByStaff>>;
            },
          });
          return jsonResponse(approved.body, 200);
        }

        const mSubmissionReject = matchPath(
          "/api/v1/admin/payment-submissions/:submissionId/reject",
          pathname
        );
        if (method === "POST" && mSubmissionReject) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "payments.reject", requestId);
          const body = await readJsonBody(request);
          // A-04: rejection is idempotent per Idempotency-Key (the
          // response carries no secrets, so the stored body is used
          // as-is on replay).
          const rejected = await runIdempotentCommand({
            scope: `admin_payment_reject:${mSubmissionReject.params.submissionId}`,
            key: request.headers.get("Idempotency-Key"),
            payload: body,
            statusCode: 200,
            fn: () =>
              rejectPaymentSubmissionByStaff(
                store,
                principal,
                mSubmissionReject.params.submissionId!,
                body,
                requestId
              ),
          });
          return jsonResponse(rejected.body, 200);
        }

        // Refunds (D-4 / F-03): manual refunds only — no gateway.
        // The service records the refund, reverses it out of
        // installments newest-first, adjusts the order balance and
        // writes the audit row; the route validates the envelope with
        // RecordManualRefundSchema and gates on payments.approve.
        if (method === "POST" && pathname === "/api/v1/admin/refunds") {
          await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
          const body = await readJsonBody(request);
          const parsed = RecordManualRefundSchema.safeParse(body);
          if (!parsed.success) {
            throw new AppError(
              "VALIDATION_ERROR",
              parsed.issues[0]?.message ?? "Invalid refund request.",
              422,
            );
          }
          // exactOptionalPropertyTypes: the schema's optional fields
          // parse to `undefined` when absent; the service input takes
          // `string | null`, so normalize absent to null (the refine
          // above guarantees exactly one of the two ids is set).
          // A-04: manual refunds are idempotent per Idempotency-Key —
          // a retried refund replays the first instead of refunding
          // twice. (assertStaffPermission here is swapped to the
          // audited variant by F-01 below.)
          const created = await runIdempotentCommand({
            scope: "admin_refund_create",
            key: request.headers.get("Idempotency-Key"),
            payload: {
              ...parsed.data,
              payment_transaction_id: parsed.data.payment_transaction_id ?? null,
              order_id: parsed.data.order_id ?? null,
              provider_refund_id: parsed.data.provider_refund_id ?? null,
            },
            statusCode: 201,
            fn: () =>
              recordManualRefundByAdmin(
                store,
                principal,
                {
                  ...parsed.data,
                  payment_transaction_id: parsed.data.payment_transaction_id ?? null,
                  order_id: parsed.data.order_id ?? null,
                  provider_refund_id: parsed.data.provider_refund_id ?? null,
                },
                requestId
              ),
          });
          return jsonResponse(created.body, created.replayed ? 200 : 201);
        }

        if (method === "GET" && pathname === "/api/v1/admin/refunds") {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.payment_refunds.filter(
            (r) =>
              includesQuery(r.id, q) ||
              includesQuery(r.payment_transaction_id, q) ||
              includesQuery(r.reason, q) ||
              includesQuery(r.provider_refund_id, q),
          );
          return pagedCollectionResponse(items, limit, page);
        }

        const mRefundDetail = matchPath("/api/v1/admin/refunds/:refundId", pathname);
        if (method === "GET" && mRefundDetail) {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const refund = store.state.payment_refunds.find(
            (r) => r.id === mRefundDetail.params.refundId
          );
          if (!refund) throw new AppError("NOT_FOUND", "Refund not found.", 404);
          return jsonResponse(refund);
        }

        const mAssetContent = matchPath("/api/v1/admin/assets/:assetId/content", pathname);
        if (method === "GET" && mAssetContent) {
          await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
          const asset = store.state.uploaded_assets.find(
            (a) => a.id === mAssetContent.params.assetId
          );
          if (!asset) throw new AppError("NOT_FOUND", "Asset not found.", 404);
          // L-10: serve through the resolved storage driver (R2 or
          // Local) — the direct r2Bucket.get bypassed the driver
          // selection, so a Local-configured instance 404d here even
          // though the object existed.
          const assetDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
          const obj = await assetDriver.get(asset.object_key);
          if (!obj) throw new AppError("NOT_FOUND", "Object content not found.", 404);
          // A-17: nosniff on evidence downloads, and ?download=1
          // forces a save-as download (like the media content route)
          // instead of inline preview.
          const safeFilename = asset.original_filename.replace(/["\\\r\n]/g, "");
          const evidenceDownload = url.searchParams.get("download") === "1";
          return new Response(obj.bytes, {
            status: 200,
            headers: {
              "Content-Type": asset.content_type,
              "Content-Length": String(obj.size),
              "Cache-Control": "private, no-store",
              "Content-Disposition": evidenceDownload
                ? `attachment; filename="${safeFilename}"`
                : `inline; filename="${safeFilename}"`,
              "X-Content-Type-Options": "nosniff",
              "X-Request-ID": requestId,
            },
          });
        }

        // Subscriptions & Licenses
        if (method === "GET" && pathname === "/api/v1/admin/subscriptions") {
          await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.subscriptions
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
            }));
          return pagedCollectionResponse(items, limit, page);
        }

        // E-09: renewals view (PRD §12.5) — the work queue the
        // subscriptions list cannot show: ?bucket=upcoming|due|overdue|
        // failed|cancelled (no bucket = all bucketed rows). Buckets are
        // the shared renewalBucketOf definitions (disjoint; rows with
        // no next_renewal_at or a renewal >30 days out belong to no
        // bucket). Sorted nearest-renewal-first so the most urgent row
        // is on top; each row carries customer + product like the
        // subscriptions list.
        if (method === "GET" && pathname === "/api/v1/admin/renewals") {
          await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
          const bucketParam = url.searchParams.get("bucket");
          const validBuckets = ["upcoming", "due", "overdue", "failed", "cancelled"] as const;
          const bucketFilter =
            bucketParam !== null &&
            (validBuckets as readonly string[]).includes(bucketParam)
              ? (bucketParam as (typeof validBuckets)[number])
              : bucketParam === null
                ? null
                : undefined;
          if (bucketFilter === undefined) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Unknown renewals bucket. Use upcoming, due, overdue, failed, or cancelled.",
              400
            );
          }
          const { q, limit, page } = parseListQuery(url.searchParams);
          const todayDay = new Date().toISOString().slice(0, 10);
          const items = store.state.subscriptions
            .map((s) => ({
              subscription: s,
              bucket: renewalBucketOf(s, todayDay),
            }))
            .filter((row) => row.bucket !== null)
            .filter((row) => (bucketFilter === null ? true : row.bucket === bucketFilter))
            .filter(
              (row) =>
                includesQuery(row.subscription.subscription_number, q) ||
                includesQuery(
                  store.state.customers.find((c) => c.id === row.subscription.customer_id)
                    ?.name,
                  q
                )
            )
            .sort((a, b) => {
              const aDay = renewalDayOf(a.subscription.next_renewal_at) ?? "9999-12-31";
              const bDay = renewalDayOf(b.subscription.next_renewal_at) ?? "9999-12-31";
              if (aDay !== bDay) return aDay < bDay ? -1 : 1;
              return a.subscription.id.localeCompare(b.subscription.id);
            })
            .map((row) => ({
              ...row.subscription,
              bucket: row.bucket,
              customer:
                store.state.customers.find((c) => c.id === row.subscription.customer_id) ??
                null,
              product:
                store.state.products.find((p) => p.id === row.subscription.product_id) ?? null,
              next_renewal_display: row.subscription.next_renewal_at
                ? formatDisplayDateDDMMYYYY(
                    row.subscription.next_renewal_at,
                    env.DEFAULT_TIMEZONE
                  )
                : null,
            }));
          return pagedCollectionResponse(items, limit, page);
        }

        // Batch 1: subscription detail.
        const mSubDetail = matchPath("/api/v1/admin/subscriptions/:subscriptionId", pathname);
        if (method === "GET" && mSubDetail) {
          await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "subscriptions.manage", requestId);
          // A-02: NO default key — without a header the service
          // derives ren_<id>_period_<n> from the next period.
          const res = await generateSubscriptionRenewalInvoice(
            store,
            principal,
            mSubRenewal.params.subscriptionId!,
            request.headers.get("Idempotency-Key"),
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "subscriptions.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
          // Never expose license_key_hash or raw keys in list responses (API Spec §12.3)
          const { q, limit, page } = parseListQuery(url.searchParams);
          const filteredLicenses = store.state.licenses.filter(
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
          );
          // Dashboard ordering: sort BEFORE the ?limit=100 window slices
          // (same gap as orders — the expiring-licenses panel sorts
          // client-side over the loaded set).
          const items = sortByTimestamp(
            filteredLicenses,
            "created_at",
            parseTimestampSort(url.searchParams, "created_at"),
          ).map((l) => {
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
          });
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/licenses/manual-grants") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
          const body = await readJsonBody(request);
          const granted = await createManualLicenseGrantByAdmin(
            store,
            principal,
            body,
            env.LICENSE_VERIFIER_SECRET,
            requestId
          );
          return jsonResponse(granted, 201);
        }

        // E-05: signing-key lifecycle admin API (PRD §13.5; API spec
        // §16.6). Rotation/revocation exist only as store methods
        // until now — these routes expose them, permission-gated and
        // audit-logged. Placed BEFORE the :licenseId detail match:
        // GET /admin/licenses/signing-keys would otherwise match
        // licenseId="signing-keys" and 404.
        // List: public JWKs (never private material) + status per key
        // (active vs retired — revoked keys leave the store, so they
        // never appear here, same as the public endpoint).
        if (method === "GET" && pathname === "/api/v1/admin/licenses/signing-keys") {
          await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
          const keys = store.listPublicSigningKeys();
          return jsonResponse({
            active_key_id: store.activeSigningKeyId,
            keys: keys.map((jwk) => ({
              key_id: (jwk as { kid?: unknown }).kid ?? null,
              status:
                (jwk as { kid?: unknown }).kid === store.activeSigningKeyId
                  ? "active"
                  : "retired",
              public_key_jwk: jwk,
            })),
          });
        }

        if (method === "POST" && pathname === "/api/v1/admin/licenses/signing-keys/rotate") {
          await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as { key_id?: unknown };
          const requestedId =
            typeof body.key_id === "string" && body.key_id.trim().length > 0
              ? body.key_id.trim()
              : undefined;
          // The store derives a fresh id when none is given
          // (DrizzleStore); the in-memory store needs an explicit one,
          // so derive the same shape here when absent.
          const nextKeyId =
            requestedId ??
            `key-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
          const rotated = await store.rotateSigningKey(nextKeyId);
          await store.withTransaction((state) => {
            appendAuditLog(state, {
              actor_type: "staff",
              actor_user_id: principal.user.id,
              action: "licenses.signing_key.rotated",
              resource_type: "signing_key",
              resource_id: rotated.keyId,
              outcome: "success",
              request_id: requestId,
              changes: { key_id: rotated.keyId },
            });
          });
          return jsonResponse(
            {
              key_id: rotated.keyId,
              status: "active",
              public_key_jwk: rotated.publicKeyJwk,
            },
            201
          );
        }

        const mSigningKeyRevoke = matchPath(
          "/api/v1/admin/licenses/signing-keys/:keyId/revoke",
          pathname
        );
        if (method === "POST" && mSigningKeyRevoke) {
          // Revoke is irreversible for that key id — licenses.revoke,
          // like license revocation. The active key can never be
          // revoked (rotate first); the store enforces it with 409.
          await assertStaffPermissionAudited(store, principal, "licenses.revoke", requestId);
          const keyId = mSigningKeyRevoke.params.keyId!;
          await store.revokeSigningKey(keyId);
          await store.withTransaction((state) => {
            appendAuditLog(state, {
              actor_type: "staff",
              actor_user_id: principal.user.id,
              action: "licenses.signing_key.revoked",
              resource_type: "signing_key",
              resource_id: keyId,
              outcome: "success",
              request_id: requestId,
              changes: { key_id: keyId },
            });
          });
          return jsonResponse({ revoked: true, key_id: keyId });
        }

        // Batch 1: license detail + activations.
        // NOTE: GET /api/v1/admin/licenses/manual-grants would also match
        // this pattern with licenseId="manual-grants" — but that path has
        // no GET route, so a 404 here is correct; the POST above runs first.
        const mLicenseDetail = matchPath("/api/v1/admin/licenses/:licenseId", pathname);
        if (method === "GET" && mLicenseDetail) {
          await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
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
          await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
          const lic = store.state.licenses.find(
            (l) => l.id === mLicenseActivations.params.licenseId
          );
          if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(lic.activations, limit, page);
        }

        const mActivationDeactivate = matchPath(
          "/api/v1/admin/licenses/:licenseId/activations/:activationId/deactivate",
          pathname
        );
        if (method === "POST" && mActivationDeactivate) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as { reason?: string };
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

        const mActivationTransfer = matchPath(
          "/api/v1/admin/licenses/:licenseId/activations/:activationId/transfer",
          pathname
        );
        if (method === "POST" && mActivationTransfer) {
          // E-03: audited activation transfer (Roadmap Stage 6 exit;
          // API spec §12.2).
          await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
          const body = await readJsonBody(request);
          const result = await transferActivation(
            store,
            principal,
            mActivationTransfer.params.licenseId!,
            mActivationTransfer.params.activationId!,
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
          // M-9: revoke is irreversible — it needs licenses.revoke;
          // suspend/resume need licenses.manage.
          await assertStaffPermissionAudited(
            store,
            principal,
            mLicenseAction.params.action === "revoke" ? "licenses.revoke" : "licenses.manage",
            requestId
          );
          const body = (await readJsonBodyLenient(request)) as { reason?: string };
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
          const body = (await readJsonBody(request)) as {
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
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const { q, limit, page } = parseListQuery(url.searchParams);
          const sites = store.state.integrated_sites
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
            }));
          return pagedCollectionResponse(sites, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/integrated-sites") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = (await readJsonBody(request)) as { product_id: string };
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const site = store.state.integrated_sites.find(
            (s) => s.id === mSiteCredentials.params.siteId
          );
          if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.site_credentials
              .filter((c) => c.integrated_site_id === site.id)
              .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
            limit, page
          );
        }

        if (method === "POST" && mSiteCredentials) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
          const body = await readJsonBody(request);
          // A-04: credential creation is idempotent per
          // Idempotency-Key. The raw secret is shown ONCE — it is
          // never stored in the idempotency row (A-03 class); on
          // replay it is re-derived by decrypting the stored
          // ciphertext of the created credential row.
          const created = await runIdempotentCommand({
            scope: `admin_credential_create:${mSiteCredentials.params.siteId}`,
            key: request.headers.get("Idempotency-Key"),
            payload: body,
            statusCode: 201,
            fn: () =>
              createSiteCredentialByAdmin(
                store,
                principal,
                mSiteCredentials.params.siteId!,
                body,
                {
                  encryptionKey: env.ENCRYPTION_KEY_V1,
                  keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
                  requestId,
                }
              ),
            redactForStore: (result) => ({ ...result, raw_secret_once: null }),
            reissueOnReplay: (stored) => {
              const storedResult = stored as {
                credential?: { id?: string };
                raw_secret_once?: string | null;
                [key: string]: unknown;
              };
              const credId = storedResult.credential?.id;
              const row = credId
                ? store.state.site_credentials.find((c) => c.id === credId)
                : undefined;
              return {
                ...storedResult,
                raw_secret_once:
                  row?.secret_ciphertext && row.secret_ciphertext.length > 0
                    ? decryptSecretAtRest(
                        row.secret_ciphertext,
                        env.ENCRYPTION_KEY_V1,
                        `site_credentials:${row.id}`
                      )
                    : null,
              } as Awaited<ReturnType<typeof createSiteCredentialByAdmin>>;
            },
          });
          return jsonResponse(created.body, created.replayed ? 200 : 201);
        }

        const mSiteCredRevoke = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/credentials/:credentialId/revoke",
          pathname
        );
        if (method === "POST" && mSiteCredRevoke) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = (await readJsonBodyLenient(request)) as {
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
          // A-04: rotation is idempotent per Idempotency-Key (a
          // retried rotation replays the first new credential instead
          // of minting a second one). The raw secret is re-derived
          // from the stored ciphertext on replay, never stored in the
          // idempotency row.
          const rotated = await runIdempotentCommand({
            scope: `admin_credential_rotate:${mRotateCred.params.credentialId}`,
            key: request.headers.get("Idempotency-Key"),
            payload: {},
            statusCode: 200,
            fn: () =>
              rotateSiteServerCredentialByAdmin(
                store,
                principal,
                mRotateCred.params.siteId!,
                mRotateCred.params.credentialId!,
                {
                  encryptionKey: env.ENCRYPTION_KEY_V1,
                  keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
                  requestId,
                }
              ),
            redactForStore: (result) => ({ ...result, raw_secret_once: null }),
            reissueOnReplay: (stored) => {
              const storedResult = stored as {
                new_credential?: { id?: string };
                raw_secret_once?: string | null;
                [key: string]: unknown;
              };
              const credId = storedResult.new_credential?.id;
              const row = credId
                ? store.state.site_credentials.find((c) => c.id === credId)
                : undefined;
              return {
                ...storedResult,
                raw_secret_once:
                  row?.secret_ciphertext && row.secret_ciphertext.length > 0
                    ? decryptSecretAtRest(
                        row.secret_ciphertext,
                        env.ENCRYPTION_KEY_V1,
                        `site_credentials:${row.id}`
                      )
                    : null,
              } as Awaited<ReturnType<typeof rotateSiteServerCredentialByAdmin>>;
            },
          });
          return jsonResponse(rotated.body);
        }

        const mSiteTracking = matchPath(
          "/api/v1/admin/integrated-sites/:siteId/tracking",
          pathname
        );
        if (method === "PUT" && mSiteTracking) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
          const body = await readJsonBody(request);
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
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
          const site = store.state.integrated_sites.find(
            (s) => s.id === mSiteTracking.params.siteId
          );
          if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.tracking_configurations
              .filter((tc) => tc.integrated_site_id === site.id)
              .map(({ access_token_ciphertext: _, ...safeTc }) => safeTc),
            limit, page
          );
        }

        if (method === "POST" && mSiteTracking) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
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
          // L-6: read-only roles hold tracking.read (migration 0016).
          await assertStaffPermissionAudited(store, principal, "tracking.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          // E-19: dedup flag on every row. Duplicates are never stored
          // (ingest returns the first-seen row instead of inserting a
          // second one), so a stored row is first-seen unless another
          // row shares (site, event_name, event_id) with an earlier
          // created_at — derived here, so the flag stays truthful if
          // duplicates ever do get stored.
          const firstSeenByKey = new Map<string, { created_at: string; id: string }>();
          for (const e of store.state.tracking_events) {
            const key = `${e.integrated_site_id}|${e.event_name}|${e.event_id}`;
            const prev = firstSeenByKey.get(key);
            if (
              !prev ||
              e.created_at < prev.created_at ||
              (e.created_at === prev.created_at && e.id < prev.id)
            ) {
              firstSeenByKey.set(key, { created_at: e.created_at, id: e.id });
            }
          }
          const items = store.state.tracking_events.map((e) => ({
            ...e,
            deduplicated:
              firstSeenByKey.get(`${e.integrated_site_id}|${e.event_name}|${e.event_id}`)
                ?.id !== e.id,
          }));
          // B-05: cursor pagination (?cursor=) — see audit-logs.
          const cursorParam = url.searchParams.get("cursor");
          if (cursorParam !== null) {
            const { page: cursorPage, nextCursor } = applyCursorPage(
              sortNewestFirst(items),
              limit,
              cursorParam
            );
            return collectionResponse(cursorPage, nextCursor, 200, items.length);
          }
          return pagedCollectionResponse(items, limit, page);
        }

        // E-18: send a tracking test event (PRD §15.6; API spec §17.5
        // — dedup policy must be verified in test events before
        // production). Ingests a synthetic event through the normal
        // pipeline with the pixel group's test code attached.
        if (method === "POST" && pathname === "/api/v1/admin/tracking/test-event") {
          await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
          const body = (await readJsonBody(request)) as {
            pixel_group_id?: unknown;
            event_name?: unknown;
          };
          if (
            typeof body.pixel_group_id !== "string" ||
            body.pixel_group_id.trim() === "" ||
            typeof body.event_name !== "string" ||
            body.event_name.trim() === ""
          ) {
            throw new AppError(
              "VALIDATION_ERROR",
              "pixel_group_id and event_name are required.",
              422
            );
          }
          const result = await sendTrackingTestEvent(store, principal, body, requestId);
          return jsonResponse(result, 202);
        }

        if (method === "GET" && pathname === "/api/v1/admin/webhooks") {
          // L-6: read-only roles hold integrations.read (migration 0016).
          await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
          const endpoints = store.state.webhook_endpoints.map(
            ({ secret_ciphertext: _, ...safe }) => safe
          );
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(endpoints, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/webhooks") {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const body = await readJsonBody(request);
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
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const deleted = await deleteWebhookEndpointByAdmin(
            store,
            principal,
            mWebhookDelete.params.webhookId!,
            requestId
          );
          return jsonResponse(deleted);
        }

        // E-17: edit a webhook endpoint (PRD §16; coverage P2) — URL +
        // subscribed events only; the secret is untouched (rotation is
        // the separate POST .../rotate below).
        if (method === "PATCH" && mWebhookDelete) {
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          // The service reads url / description / subscribed_events
          // (or subscribedEvents) off the raw body — pass it through.
          const body = await readJsonBody(request);
          const updated = await updateWebhookEndpoint(
            store,
            principal,
            mWebhookDelete.params.webhookId!,
            body,
            {
              allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
              requestId,
            }
          );
          return jsonResponse(updated);
        }

        // E-04: rotate a webhook secret (API spec §18.6) — mirrors the
        // site-credential rotate pattern: a new secret is issued
        // (shown once by the service), the old one retires.
        const mWebhookRotate = matchPath(
          "/api/v1/admin/webhooks/:webhookId/rotate",
          pathname
        );
        if (method === "POST" && mWebhookRotate) {
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const result = await rotateWebhookSecret(
            store,
            principal,
            mWebhookRotate.params.webhookId!,
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
              requestId,
            }
          );
          return jsonResponse(result);
        }

        // Batch 1: webhook test delivery + delivery history + outbox reads/replay.
        const mWebhookTest = matchPath(
          "/api/v1/admin/webhooks/:webhookId/test",
          pathname
        );
        if (method === "POST" && mWebhookTest) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
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
          // L-6: read-only roles hold integrations.read (migration 0016).
          await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
          const endpoint = store.state.webhook_endpoints.find(
            (ep) => ep.id === mWebhookDeliveries.params.webhookId
          );
          if (!endpoint) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", 404);
          const { limit, page } = parseListQuery(url.searchParams);
          return pagedCollectionResponse(
            store.state.webhook_deliveries.filter(
              (d) => d.webhook_endpoint_id === endpoint.id
            ),
            limit, page
          );
        }

        if (method === "GET" && pathname === "/api/v1/admin/outbox-events") {
          // L-6: read-only roles hold integrations.read (migration 0016).
          await assertStaffPermissionAudited(store, principal, "integrations.read", requestId);
          const statusFilter = url.searchParams.get("status");
          // Server-side `?q=` (search batch): matches event_key /
          // event_type / aggregate_type / aggregate_id / status
          // substrings, case-insensitive — the same `includesQuery`
          // helper every other list endpoint uses, so a match past the
          // loaded window is never missed. event_key MUST be in the
          // list: it is the first column the user reads, and for the
          // CAPI rows it carries words the event_type does not
          // (event_key "meta_capi.purchase:<id>" vs event_type
          // "tracking.meta_capi.dispatch" — "purchase" matched nothing
          // live until this was added, 2026-11-22).
          const { q, limit, page } = parseListQuery(url.searchParams);
          const items = store.state.outbox_events
            .filter((e) => (!statusFilter ? true : e.status === statusFilter))
            .filter(
              (e) =>
                includesQuery(e.event_key, q) ||
                includesQuery(e.event_type, q) ||
                includesQuery(e.aggregate_type, q) ||
                includesQuery(e.aggregate_id, q) ||
                includesQuery(e.status, q),
            );
          // B-05: cursor pagination (?cursor=) — see audit-logs.
          const cursorParam = url.searchParams.get("cursor");
          if (cursorParam !== null) {
            const { page: cursorPage, nextCursor } = applyCursorPage(
              sortNewestFirst(items),
              limit,
              cursorParam
            );
            return collectionResponse(cursorPage, nextCursor, 200, items.length);
          }
          return pagedCollectionResponse(items, limit, page);
        }

        const mOutboxReplay = matchPath(
          "/api/v1/admin/outbox-events/:eventId/replay",
          pathname
        );
        if (method === "POST" && mOutboxReplay) {
          // M-9: the mutation maps to its write permission at the
          // dispatcher (audited variant, so a denial is recorded).
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          const replayed = await replayOutboxEventByAdmin(
            store,
            principal,
            mOutboxReplay.params.eventId!,
            requestId
          );
          return jsonResponse(replayed);
        }

        if (method === "POST" && pathname === "/api/v1/admin/outbox/dispatch") {
          await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
          // C-2: pass the real transport — without it the dispatcher
          // runs simulated and records "simulated" (never "delivered").
          const summary = await processTransactionalOutboxBatch(store, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            transport: createRealWebhookTransport({
              allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            }),
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
          await assertStaffPermissionAudited(store, principal, "products.read", requestId);
          // M-8: revenue is finance data — only callers who can see
          // payments see it. There is no finance.* permission in the
          // seed catalogue (only the finance_manager ROLE, which holds
          // payments.read), so payments.read is the gate; null (not 0)
          // when the caller lacks it, so a missing value is never
          // mistaken for "no revenue". The SPA hides the revenue card
          // on null.
          const canSeeRevenue =
            principal.roles.includes("super_admin") ||
            principal.permissions.includes("payments.read");
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

          // B-06: one call instead of four — the overview carries the
          // three dashboard panels' top-5 rows (Worker D consumes
          // `panels`; the SPA's separate panel queries stay as a
          // fallback until it switches over). Panels are server-sorted
          // over the full set, so a row is never hidden by a
          // creation-sorted ?limit=100 window (the old D-02 gap).
          // E-11: upcoming_renewals = renewable subscriptions whose
          // next renewal falls within 30 days (the upcoming + due
          // buckets of the renewals view).
          const todayDay = new Date().toISOString().slice(0, 10);
          const upcomingRenewals = store.state.subscriptions.filter((s) => {
            const bucket = renewalBucketOf(s, todayDay);
            return bucket === "upcoming" || bucket === "due";
          });
          const customerById = new Map(store.state.customers.map((c) => [c.id, c]));
          const panels = {
            recent_orders: sortByTimestamp(store.state.orders, "created_at", "desc")
              .slice(0, 5)
              .map((o) => ({
                ...o,
                customer: customerById.get(o.customer_id) ?? null,
                paid_amount_minor: computeOrderPaid(store.state, o.id),
                remaining_minor: computeOrderRemaining(store.state, o),
                created_date_display: formatDisplayDateDDMMYYYY(
                  o.created_at,
                  env.DEFAULT_TIMEZONE
                ),
              })),
            pending_submissions: [...pendingSubmissions]
              .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
              .slice(0, 5)
              .map((s) => ({
                ...s,
                customer: customerById.get(s.customer_id) ?? null,
                order_number:
                  store.state.orders.find((o) => o.id === s.order_id)?.order_number ?? null,
              })),
            expiring_licenses: [...store.state.licenses]
              .filter((l) => {
                if (l.status !== "active") return false;
                const day = renewalDayOf(l.expires_at);
                return (
                  day !== null &&
                  day >= todayDay &&
                  day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)
                );
              })
              .sort((a, b) => (a.expires_at ?? "") < (b.expires_at ?? "") ? -1 : 1)
              .slice(0, 5)
              .map((l) => {
                const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = l;
                const customer = customerById.get(l.customer_id);
                const product = store.state.products.find((p) => p.id === l.product_id);
                return {
                  ...safe,
                  customer_name: customer?.name ?? null,
                  product_code: product?.code ?? null,
                  product_name: product?.name ?? null,
                  active_activations_count: l.activations.filter((a) => a.status === "active")
                    .length,
                  expires_date_display: l.expires_at
                    ? formatDisplayDateDDMMYYYY(l.expires_at, env.DEFAULT_TIMEZONE)
                    : "Lifetime",
                };
              }),
          };

          return jsonResponse({
            currency_code: env.DEFAULT_CURRENCY,
            total_products: store.state.products.length,
            active_products: store.state.products.filter((p) => p.status === "active").length,
            total_customers: store.state.customers.length,
            // F-02: order/payment counts are finance data too — gated
            // on the same canSeeRevenue predicate as
            // verified_revenue_minor (null, not 0, when the caller
            // lacks payments.read, so a missing value is never
            // mistaken for "no orders"). The SPA hides these cards on
            // null, as it does for revenue.
            total_orders: canSeeRevenue ? ordersInRange.length : null,
            paid_orders: canSeeRevenue ? paidOrdersInRange.length : null,
            pending_payment_submissions: canSeeRevenue ? pendingSubmissions.length : null,
            upcoming_renewals: upcomingRenewals.length,
            panels,
            active_subscriptions: store.state.subscriptions.filter((s) => s.status === "active")
              .length,
            active_licenses: store.state.licenses.filter((l) => l.status === "active").length,
            expired_or_revoked_licenses: store.state.licenses.filter(
              (l) => l.status === "expired" || l.status === "revoked"
            ).length,
            verified_revenue_minor: canSeeRevenue ? verifiedRevenueMinor : null,
            pending_outbox_events: store.state.outbox_events.filter(
              (e) => e.status === "pending"
            ).length,
            range,
          });
        }

        // Expense module — categories + expenses + P&L analytics.
        // `?pageSize=` is accepted as an alias for the standard
        // `?limit=` (M-1: 1..100, default 25); `?page=` as usual.
        // `?from=&to=` follow parseOverviewRange semantics (both or
        // neither, YYYY-MM-DD, max 366 days, 400 otherwise).
        const parseExpenseListQuery = () => {
          const { q, limit, page } = parseListQuery(url.searchParams);
          const rawPageSize = Number(url.searchParams.get("pageSize"));
          const effectiveLimit =
            Number.isFinite(rawPageSize) && rawPageSize >= 1
              ? Math.min(Math.floor(rawPageSize), 100)
              : limit;
          return { q, limit: effectiveLimit, page };
        };

        if (method === "GET" && pathname === "/api/v1/admin/expense-categories") {
          await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
          const { q, limit, page } = parseExpenseListQuery();
          const isActiveRaw = url.searchParams.get("is_active");
          const isActive =
            isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : null;
          const items = await listExpenseCategories(store, principal, {
            q,
            isActive,
          });
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/expense-categories") {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expense_categories.manage",
            requestId,
          );
          const body = await readJsonBody(request);
          const created = await createExpenseCategory(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mExpenseCategoryDetail = matchPath(
          "/api/v1/admin/expense-categories/:categoryId",
          pathname,
        );
        if (method === "GET" && mExpenseCategoryDetail) {
          await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
          const category = await getExpenseCategory(
            store,
            principal,
            mExpenseCategoryDetail.params.categoryId!,
          );
          return jsonResponse(category);
        }

        if (method === "PATCH" && mExpenseCategoryDetail) {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expense_categories.manage",
            requestId,
          );
          const body = await readJsonBody(request);
          const updated = await updateExpenseCategory(
            store,
            principal,
            mExpenseCategoryDetail.params.categoryId!,
            body,
            requestId,
          );
          return jsonResponse(updated);
        }

        if (method === "DELETE" && mExpenseCategoryDetail) {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expense_categories.manage",
            requestId,
          );
          const deleted = await deleteExpenseCategory(
            store,
            principal,
            mExpenseCategoryDetail.params.categoryId!,
            requestId,
          );
          return jsonResponse(deleted);
        }

        if (method === "GET" && pathname === "/api/v1/admin/expenses") {
          await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
          const { q, limit, page } = parseExpenseListQuery();
          const range = parseOverviewRange(url.searchParams);
          const items = await listExpenses(store, principal, {
            q,
            categoryId: url.searchParams.get("categoryId"),
            productId: url.searchParams.get("productId"),
            from: range?.from ?? null,
            to: range?.to ?? null,
          });
          return pagedCollectionResponse(items, limit, page);
        }

        if (method === "POST" && pathname === "/api/v1/admin/expenses") {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expenses.manage",
            requestId,
          );
          const body = await readJsonBody(request);
          const created = await createExpense(store, principal, body, requestId);
          return jsonResponse(created, 201);
        }

        const mExpenseDetail = matchPath("/api/v1/admin/expenses/:expenseId", pathname);
        if (method === "GET" && mExpenseDetail) {
          await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
          const expense = await getExpense(
            store,
            principal,
            mExpenseDetail.params.expenseId!,
          );
          return jsonResponse(expense);
        }

        if (method === "PATCH" && mExpenseDetail) {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expenses.manage",
            requestId,
          );
          const body = await readJsonBody(request);
          const updated = await updateExpense(
            store,
            principal,
            mExpenseDetail.params.expenseId!,
            body,
            requestId,
          );
          return jsonResponse(updated);
        }

        if (method === "DELETE" && mExpenseDetail) {
          await assertStaffPermissionAudited(
            store,
            principal,
            "expenses.manage",
            requestId,
          );
          const deleted = await deleteExpense(
            store,
            principal,
            mExpenseDetail.params.expenseId!,
            requestId,
          );
          return jsonResponse(deleted);
        }

        // Profit & Loss — sales are the dashboard verified-revenue
        // definition (paid + completed in range, order totals) minus
        // succeeded refunds recorded in range; see pnl.ts header.
        if (method === "GET" && pathname === "/api/v1/admin/analytics/profit-loss") {
          await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
          const range = parseOverviewRange(url.searchParams);
          const productId = url.searchParams.get("productId");
          const result = computeProfitLoss(store.state, {
            range,
            productId,
            timeZone: env.DEFAULT_TIMEZONE,
          });
          return jsonResponse(result);
        }

        if (method === "GET" && pathname === "/api/v1/admin/audit-logs") {
          await assertStaffPermissionAudited(store, principal, "audit_logs.read", requestId);
          // H-05: server-side filters (like the other list endpoints).
          // ?q= matches action / resource type / resource id / actor /
          // display name; ?action=, ?resource=, ?outcome=, ?actor=
          // filter exact. Unknown params are ignored.
          const { q, limit, page } = parseListQuery(url.searchParams);
          const actionFilter = url.searchParams.get("action");
          const resourceFilter = url.searchParams.get("resource");
          const outcomeFilter = url.searchParams.get("outcome");
          const actorFilter = url.searchParams.get("actor");
          const items = store.state.audit_logs
            .filter((a) => (!actionFilter ? true : a.action === actionFilter))
            .filter((a) => (!resourceFilter ? true : a.resource_type === resourceFilter))
            .filter((a) => (!outcomeFilter ? true : a.outcome === outcomeFilter))
            .filter((a) => (!actorFilter ? true : a.actor_user_id === actorFilter))
            .map((a) => ({
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
            }))
            .filter(
              (a) =>
                includesQuery(a.action, q) ||
                includesQuery(a.resource_type, q) ||
                includesQuery(a.resource_id, q) ||
                includesQuery(a.actor_user_id, q) ||
                includesQuery(a.resource_display_name, q),
            );
          // B-05: cursor pagination (?cursor=) for this append-heavy
          // list — offset paging can skip/duplicate rows as new audit
          // rows are appended. ?cursor= absent keeps the offset path.
          const cursorParam = url.searchParams.get("cursor");
          if (cursorParam !== null) {
            const { page: cursorPage, nextCursor } = applyCursorPage(
              sortNewestFirst(items),
              limit,
              cursorParam
            );
            return collectionResponse(cursorPage, nextCursor, 200, items.length);
          }
          return pagedCollectionResponse(items, limit, page);
        }

        // E-21: scheduled-jobs visibility (PRD §22) — runs of the
        // every-minute cron (outbox drain + renewal sweep) and any
        // other scheduled job, read DIRECTLY from the
        // scheduled_job_runs table (Worker C: db/schema/jobs.ts —
        // id, job_key, started_at, finished_at, status, summary,
        // error; index on (job_key, started_at DESC)). Never through
        // the store load. No drizzleDb (in-memory store) → 503; table
        // not migrated yet (42P01) → 503 with a plain message, never
        // a 500. Response: collection of { job_key, started_at,
        // finished_at, status, summary }.
        if (method === "GET" && pathname === "/api/v1/admin/jobs") {
          await assertStaffPermissionAudited(store, principal, "audit_logs.read", requestId);
          const { limit, page } = parseListQuery(url.searchParams);
          const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
          if (!maybeDrizzle.drizzleDb) {
            throw new AppError(
              "STORE_UNAVAILABLE",
              "Scheduled jobs require a database.",
              503
            );
          }
          const db = maybeDrizzle.drizzleDb as Parameters<typeof listMediaAssets>[0];
          const offset = (page - 1) * limit;
          let rows: Array<Record<string, unknown>>;
          let total: number;
          try {
            const rowsRes = (await db.execute(
              sql`SELECT job_key, started_at, finished_at, status, summary
                   FROM scheduled_job_runs
                   ORDER BY started_at DESC
                   LIMIT ${limit} OFFSET ${offset}`
            )) as unknown as { rows?: Array<Record<string, unknown>> };
            rows = rowsRes.rows ?? [];
            const countRes = (await db.execute(
              sql`SELECT count(*) AS value FROM scheduled_job_runs`
            )) as unknown as { rows?: Array<Record<string, unknown>> };
            total = Number(countRes.rows?.[0]?.value ?? 0);
          } catch (err) {
            if ((err as { code?: unknown } | null)?.code === "42P01") {
              throw new AppError(
                "STORE_UNAVAILABLE",
                "Scheduled jobs are not available yet (scheduled_job_runs is not migrated).",
                503
              );
            }
            throw err;
          }
          const toIso = (v: unknown): string | null =>
            v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
          return collectionResponse(
            rows.map((r) => ({
              job_key: r.job_key ?? null,
              started_at: toIso(r.started_at),
              finished_at: toIso(r.finished_at),
              status: r.status ?? null,
              summary: (r.summary as Record<string, unknown> | null) ?? null,
            })),
            null,
            200,
            total
          );
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
    // A-05 guard (cron lease, platform/cron-lease.ts): one lease per
    // job per tick — outbox_drain + renewal_sweep are independent jobs,
    // so a stuck drain never blocks the sweep and vice versa. A job
    // whose lease is still held by a previous tick is SKIPPED (logged),
    // never run twice. Each lease releases with a run summary in the
    // inner finally, BEFORE closeRequestStore ends the store's pg
    // client (the release itself needs the DB). No drizzleDb
    // (in-memory/test store) → no lease, the tick runs unguarded as
    // today. (The task's pinned 'cron_tick' single lease predates the
    // landed module — the landed per-job leases are wired instead.)
    const leaseDb = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
      | Parameters<typeof tryAcquireCronLease>[0]
      | undefined;
    const acquireLease = async (jobKey: string): Promise<boolean> => {
      if (!leaseDb) return true;
      try {
        return await tryAcquireCronLease(leaseDb, jobKey);
      } catch (err) {
        // A lease-acquire DB failure must not kill the tick (the
        // 2026-11-16 uncaught-exception pattern) — log loudly and run
        // this job unguarded, as today.
        console.error(
          `[stackmate-cron] lease acquire failed for '${jobKey}' — running unguarded`,
          err instanceof Error ? err.message : "unknown error"
        );
        return true;
      }
    };
    const releaseLease = async (jobKey: string, summary: unknown): Promise<void> => {
      if (!leaseDb) return;
      await releaseCronLease(leaseDb, jobKey, summary).catch((err) => {
        console.error(
          `[stackmate-cron] failed to release '${jobKey}' lease`,
          err instanceof Error ? err.message : "unknown error"
        );
      });
    };
    try {
      // A-09: URL-var validation is in resolveRuntimeConfig (above) —
      // no per-request check here either.
      // The await is LOAD-BEARING (cron bug 2026-11-16): `return
      // <pending promise>` runs this finally block BEFORE the promise
      // settles, so without it closeRequestStore ends the store's pg
      // client while the drain is still running and the drain's first
      // BEGIN throws "Client was closed and is not queryable" — every
      // cron invocation errored (~1/min uncaught exceptions in the
      // Cloudflare metrics) and the outbox never drained on schedule.
      // fetchHandler already awaits for the same reason.
      // C-2: the cron passes the real transport — without it the
      // dispatcher runs simulated and records "simulated" (never
      // "delivered"). Meta CAPI events stay simulated by design
      // (Batch 4 builds the real Meta client).
      let drainResult: Awaited<ReturnType<typeof processTransactionalOutboxBatch>> | null =
        null;
      if (await acquireLease(CRON_JOB_OUTBOX_DRAIN)) {
        try {
          drainResult = await processTransactionalOutboxBatch(store, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            transport: createRealWebhookTransport({
              allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
            }),
          });
        } finally {
          await releaseLease(CRON_JOB_OUTBOX_DRAIN, drainResult ?? { skipped: false });
        }
      } else {
        console.log(
          "[stackmate-cron] outbox drain skipped: previous tick still holds the lease"
        );
      }
      // Renewal + expiry sweep (ADR-0009): runs AFTER the drain, so a
      // sweep failure can never block outbox delivery. The sweep itself
      // never throws (its report carries per-item errors); the reminder
      // sends below are best-effort and a failed send is NOT marked
      // sent, so the next minute's run retries it (send-first-then-mark).
      if (await acquireLease(CRON_JOB_RENEWAL_SWEEP)) {
        let sweepSummary: Record<string, unknown> = { skipped: false };
        try {
          const sweep = await runRenewalExpirySweep(store, {
            licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
            requestId: `cron:sweep:${new Date().toISOString()}`,
            timeZone: env.DEFAULT_TIMEZONE,
          });
          // B-15: load SMTP settings ONCE per tick (decrypt included)
          // and reuse for every reminder send, instead of one load +
          // decrypt per reminder. When SMTP is not configured the loop
          // is skipped outright — no per-reminder load at all. The
          // preloaded settings are threaded through sendEmailViaSmtp
          // (Worker B's optional param on sendStackMateEmail — not
          // landed yet, so the per-send load inside it still runs;
          // the tick-level gate + plumbing are in place).
          const smtpDb = (store as unknown as { drizzleDb?: unknown })
            .drizzleDb as Parameters<typeof sendStackMateEmail>[0] | undefined;
          let preloadedSmtp: ResolvedSmtpSettings | null = null;
          if (smtpDb) {
            preloadedSmtp = await loadSmtpSettings(smtpDb, {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            }).catch(() => null);
          }
          const smtpReady =
            preloadedSmtp !== null &&
            preloadedSmtp.enabled &&
            Boolean(preloadedSmtp.host) &&
            Boolean(preloadedSmtp.from_address);
          const sent: typeof sweep.reminders_due = [];
          if (sweep.reminders_due.length > 0 && !smtpReady) {
            console.log(
              "[stackmate-cron] SMTP not configured — skipping",
              sweep.reminders_due.length,
              "reminder(s) this tick"
            );
          }
          for (const reminder of sweep.reminders_due) {
            if (!smtpReady) break;
            const result = await sendEmailViaSmtp(
              store,
              env,
              {
                to: reminder.to_email,
                subject: reminder.subject,
                text: reminder.text,
              },
              preloadedSmtp
            );
            if (result.sent) sent.push(reminder);
          }
          if (sent.length > 0) await markSweepRemindersSent(store, sent);
          sweepSummary = {
            reminders_due: sweep.reminders_due.length,
            reminders_sent: sent.length,
          };
        } catch (err) {
          // Never fail the cron (and never mask the drain result) for
          // sweep or reminder-mail errors — the next run retries.
          // F-10: log the message only, never the raw error object.
          console.error(
            "[stackmate-cron] renewal sweep failed",
            err instanceof Error ? err.message : "unknown error"
          );
          sweepSummary = {
            sweep_error: err instanceof Error ? err.message : "unknown error",
          };
        } finally {
          await releaseLease(CRON_JOB_RENEWAL_SWEEP, sweepSummary);
        }
      } else {
        console.log(
          "[stackmate-cron] renewal sweep skipped: previous tick still holds the lease"
        );
      }
      // The scheduled return type is the drain report — a skipped drain
      // answers with the zeroed report shape, never a different object.
      return (
        drainResult ?? {
          claimed: 0,
          delivered: 0,
          simulated: 0,
          skipped: 0,
          retrying: 0,
          dead_lettered: 0,
        }
      );
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
    const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const trustedOrigins = env.TRUSTED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const originHeader = request.headers.get("Origin");
    const earlyUrl = new URL(request.url);
    const earlyPathname = earlyUrl.pathname.replace(/\/+$/, "") || "/";
    const earlyMethod = request.method.toUpperCase();
    const earlyResponse = (data: unknown, status = 200) =>
      new Response(JSON.stringify(createSuccessEnvelope(data, requestId)), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
      });

    // A-10: /health and /setup-status answer BEFORE any store
    // resolution — the cheapest, most-polled endpoints used to pay a
    // full store creation (~10 pg queries + a fresh connect) for a
    // one-bit answer.
    //  - health/ready: env/bindings only, no database at all.
    //  - setup-status: one `SELECT EXISTS (… super_admin …)` on a
    //    lightweight throwaway client in storeFactory mode (closed
    //    before answering), or the injected store's own check in
    //    injected-store mode (no factory call either way). A failure
    //    of the lightweight query falls through to the normal store
    //    path, which answers STORE_UNAVAILABLE as before.
    if (
      earlyMethod === "GET" &&
      (earlyPathname === "/api/v1/health" || earlyPathname === "/api/v1/ready")
    ) {
      return earlyResponse({
        status: "ok",
        service: "stackmate-api",
        environment: env.APP_ENV,
        default_currency: env.DEFAULT_CURRENCY,
        default_timezone: env.DEFAULT_TIMEZONE,
        hyperdrive: {
          uncached_binding_configured: Boolean(env.HYPERDRIVE_NO_CACHE?.connectionString),
          cached_binding_configured: Boolean(env.HYPERDRIVE_CACHED?.connectionString),
        },
        timestamp: new Date().toISOString(),
      });
    }
    if (earlyMethod === "GET" && earlyPathname === "/api/v1/setup-status") {
      try {
        let provisioned: boolean;
        if (!storeFactory && injectedStore) {
          provisioned = await isSuperAdminProvisioned(injectedStore);
        } else {
          const { Client } = await import("pg");
          const probe = new Client({
            connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
          });
          try {
            await probe.connect();
            const res = await probe.query(
              "SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'super_admin') AS provisioned"
            );
            provisioned = res.rows[0]?.provisioned === true;
          } finally {
            await probe.end().catch(() => {});
          }
        }
        return earlyResponse({ setup_required: !provisioned });
      } catch {
        // Fall through to the normal store path below.
      }
    }

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
      const failureRequestId = requestId;
      console.error(
        "[stackmate] store creation failed",
        failureRequestId,
        error instanceof Error ? error.message : "unknown error"
      );
      return new Response(
        JSON.stringify(
          createErrorEnvelope(
            "STORE_UNAVAILABLE",
            "The data store is temporarily unavailable. Please retry.",
            failureRequestId
          )
        ),
        {
          status: 500,
          headers: buildStandardHeaders(failureRequestId, originHeader, trustedOrigins),
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
      // C-10: end any Better Auth fallback pg.Client created for this
      // request (injected-store mode only — factory stores always have
      // drizzleDb, so they never take the fallback branch).
      await closeBetterAuthFallbackClients(store);
    }
  }

  return {
    store: injectedStore ?? null,
    fetch: fetchHandler,
    scheduled: handleScheduled,
  };
}
