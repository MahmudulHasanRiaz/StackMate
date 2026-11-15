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
import { randomUUID } from "node:crypto";
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
import { AppError } from "./shared/errors.ts";
import {
  assertStaffPermission,
  bootstrapInitialSuperAdmin,
  createStaffUserByAdmin,
  resolveStaffPrincipalFromToken,
  signInStaffSession,
  type StaffPrincipal,
  updateStaffUserRoles,
} from "./modules/identity/service.ts";
import {
  createNewPackageVersion,
  createPackagePrice,
  createProduct,
  createProductFeature,
  createProductPackageWithDraftVersion,
  publishPackageVersion,
  updateProductMetadata,
  updateProductStatus,
} from "./modules/catalog/service.ts";
import { createCustomerByAdmin } from "./modules/customers/service.ts";
import {
  createOrderByAdmin,
  createPublicCheckoutOrder,
} from "./modules/commerce/service.ts";
import {
  approvePaymentSubmissionByStaff,
  createPaymentMethodByAdmin,
  rejectPaymentSubmissionByStaff,
  submitManualPaymentClaim,
  toPublicPaymentMethodDto,
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
  deactivateLicenseInstallation,
  transitionLicenseStatusByAdmin,
  validateLicenseInstallation,
} from "./modules/licensing/service.ts";
import {
  authenticateSignedServerRequest,
  registerIntegratedSiteByAdmin,
  rotateSiteServerCredentialByAdmin,
} from "./modules/integrations/service.ts";
import {
  configureSiteTrackingByAdmin,
  ingestExternalTrackingEvent,
} from "./modules/tracking/service.ts";
import {
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
} from "./modules/webhooks/service.ts";

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
      rawName === "better-auth.session_token"
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
   * Build the Better Auth instance for one request from the request's store.
   * A DrizzleStore exposes its `drizzleDb` directly. Any other store (the
   * in-memory test adapter) gets a lazily created `pg` Client + drizzle()
   * over the Hyperdrive uncached connection string — constructing a `pg`
   * Client and calling drizzle() opens NO connection, so Better Auth paths
   * that never query (e.g. GET /api/auth/ok) need no live database.
   */
  async function getBetterAuth(env: StackMateBindings, store: StackMateDataStore) {
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    if (maybeDrizzle.drizzleDb) {
      return createBetterAuth(
        env,
        maybeDrizzle.drizzleDb as Parameters<typeof createBetterAuth>[1]
      );
    }
    const { Client } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const client = new Client({
      connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
    });
    return createBetterAuth(env, drizzle(client));
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

    const collectionResponse = <T>(
      items: T[],
      nextCursor: string | null = null,
      status = 200
    ) =>
      new Response(JSON.stringify(createCollectionEnvelope(items, nextCursor, requestId)), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
      });

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

      // 2. Authentication Routes (/api/auth/*)
      if (pathname.startsWith("/api/auth")) {
        checkRateLimit(`auth:${clientIp}`, 60);

        if (method === "POST" && pathname === "/api/auth/bootstrap-super-admin") {
          const body = (await request.json()) as {
            name?: string;
            email?: string;
            password?: string;
          };
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
          return jsonResponse(created, 201);
        }

        if (method === "POST" && pathname === "/api/auth/sign-in") {
          const body = (await request.json()) as { email?: string; password?: string };
          if (!body.email || !body.password) {
            throw new AppError("VALIDATION_ERROR", "email and password are required.", 422);
          }
          const signedIn = await signInStaffSession(store, {
            email: body.email,
            password: body.password,
            ipAddress: clientIp,
            userAgent: request.headers.get("User-Agent"),
            requestId,
          });
          const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
          const cookieName = isProd ? "__Host-stackmate_session" : "stackmate_session";
          const cookieValue = `${cookieName}=${signedIn.session_token}; Path=/; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`;
          return jsonResponse(signedIn, 200, { "Set-Cookie": cookieValue });
        }

        if (method === "POST" && pathname === "/api/auth/sign-out") {
          const token =
            parseSessionCookie(request.headers.get("Cookie")) ??
            extractBearerToken(request.headers.get("Authorization"));
          if (token) {
            await store.withTransaction((state) => {
              state.sessions = state.sessions.filter((s) => s.token !== token);
            });
          }
          return jsonResponse(
            { signed_out: true },
            200,
            {
              "Set-Cookie":
                "stackmate_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
            }
          );
        }

        if (method === "GET" && pathname === "/api/auth/session") {
          const token =
            parseSessionCookie(request.headers.get("Cookie")) ??
            extractBearerToken(request.headers.get("Authorization"));
          const principal = resolveStaffPrincipalFromToken(store, token);
          if (!principal) {
            throw new AppError("UNAUTHORIZED", "No active staff session.", 401);
          }
          return jsonResponse({ principal });
        }

        // Fallback: every other /api/auth/* path is handled by real Better Auth.
        //
        // SESSION SEAM — read before "unifying" anything: staff sessions live
        // in the store's `sessions` state and are served by the custom
        // identity service above (/api/auth/session stays the custom one).
        // Better Auth sessions live in the Drizzle `sessions` table and are
        // served by Better Auth's own endpoints (e.g. /api/auth/get-session,
        // /api/auth/ok). The two session systems are NOT yet unified; this
        // fallback only makes Better Auth's standard paths reachable.
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

        const principal: StaffPrincipal | null = resolveStaffPrincipalFromToken(
          store,
          sessionCookie ?? bearerToken
        );
        if (!principal) {
          throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
        }

        // Identity & RBAC routes
        if (method === "GET" && pathname === "/api/v1/admin/me") {
          return jsonResponse(principal);
        }

        if (method === "GET" && pathname === "/api/v1/admin/users") {
          assertStaffPermission(principal, "users.manage");
          const users = store.state.users.map((u) => {
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

        // Products, Features, Packages & Prices
        if (method === "GET" && pathname === "/api/v1/admin/products") {
          assertStaffPermission(principal, "products.read");
          const items = store.state.products.map((p) => ({
            ...p,
            features_count: store.state.product_features.filter((f) => f.product_id === p.id)
              .length,
            packages_count: store.state.product_packages.filter((pkg) => pkg.product_id === p.id)
              .length,
            created_date_display: formatDisplayDateDDMMYYYY(p.created_at, env.DEFAULT_TIMEZONE),
          }));
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
          const items = store.state.product_features.filter(
            (f) => f.product_id === mProductFeatures.params.productId
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
          return jsonResponse(created, 201);
        }

        const mProductPackages = matchPath("/api/v1/admin/products/:productId/packages", pathname);
        if (method === "GET" && mProductPackages) {
          assertStaffPermission(principal, "products.read");
          const pkgs = store.state.product_packages
            .filter((p) => p.product_id === mProductPackages.params.productId)
            .map((p) => ({
              ...p,
              versions: store.state.package_versions
                .filter((v) => v.package_id === p.id)
                .map((v) => ({
                  ...v,
                  prices: store.state.package_prices.filter(
                    (pr) => pr.package_version_id === v.id
                  ),
                })),
            }));
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

        // Customers, Orders & Invoices
        if (method === "GET" && pathname === "/api/v1/admin/customers") {
          assertStaffPermission(principal, "customers.read");
          const items = store.state.customers.map((c) => ({
            ...c,
            created_date_display: formatDisplayDateDDMMYYYY(c.created_at, env.DEFAULT_TIMEZONE),
          }));
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
          return jsonResponse({
            ...customer,
            orders: store.state.orders.filter((o) => o.customer_id === customer.id),
            subscriptions: store.state.subscriptions.filter((s) => s.customer_id === customer.id),
            licenses: store.state.licenses.filter((l) => l.customer_id === customer.id),
          });
        }

        if (method === "GET" && pathname === "/api/v1/admin/orders") {
          assertStaffPermission(principal, "orders.read");
          const statusFilter = url.searchParams.get("payment_status");
          const items = store.state.orders
            .filter((o) => (!statusFilter ? true : o.payment_status === statusFilter))
            .map((o) => ({
              ...o,
              customer: store.state.customers.find((c) => c.id === o.customer_id) ?? null,
              created_date_display: formatDisplayDateDDMMYYYY(o.created_at, env.DEFAULT_TIMEZONE),
            }));
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

        // Payment Providers, Methods, Submissions & Verification
        if (method === "GET" && pathname === "/api/v1/admin/payment-providers") {
          assertStaffPermission(principal, "payments.read");
          return collectionResponse(store.state.payment_providers);
        }

        if (method === "GET" && pathname === "/api/v1/admin/payment-methods") {
          assertStaffPermission(principal, "payments.read");
          return collectionResponse(store.state.payment_methods);
        }

        if (method === "POST" && pathname === "/api/v1/admin/payment-methods") {
          const body = await request.json();
          const created = await createPaymentMethodByAdmin(store, principal, body, requestId);
          return jsonResponse(created, 201);
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
          const items = store.state.subscriptions.map((s) => ({
            ...s,
            customer: store.state.customers.find((c) => c.id === s.customer_id) ?? null,
            product: store.state.products.find((p) => p.id === s.product_id) ?? null,
            next_renewal_display: s.next_renewal_at
              ? formatDisplayDateDDMMYYYY(s.next_renewal_at, env.DEFAULT_TIMEZONE)
              : null,
          }));
          return collectionResponse(items);
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
          const items = store.state.licenses.map((l) => {
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
          const sites = store.state.integrated_sites.map((s) => ({
            ...s,
            credentials: store.state.site_credentials
              .filter((c) => c.integrated_site_id === s.id)
              .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
            tracking: store.state.tracking_configurations
              .filter((tc) => tc.integrated_site_id === s.id)
              .map(({ access_token_ciphertext: _a, ...safeTc }) => safeTc),
          }));
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

        if (method === "POST" && pathname === "/api/v1/admin/outbox/dispatch") {
          assertStaffPermission(principal, "integrations.manage");
          const summary = await processTransactionalOutboxBatch(store, {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
          });
          return jsonResponse(summary);
        }

        // Dashboard & Analytics Overview (PRD §18: Pending payments are NEVER counted as revenue!)
        if (method === "GET" && pathname === "/api/v1/admin/analytics/overview") {
          assertStaffPermission(principal, "products.read");
          const paidOrders = store.state.orders.filter((o) => o.payment_status === "paid");
          const verifiedRevenueMinor = paidOrders.reduce((acc, o) => acc + o.total_minor, 0);
          const pendingSubmissions = store.state.payment_submissions.filter(
            (s) => s.status === "submitted" || s.status === "under_review"
          );

          return jsonResponse({
            currency_code: env.DEFAULT_CURRENCY,
            total_products: store.state.products.length,
            active_products: store.state.products.filter((p) => p.status === "active").length,
            total_customers: store.state.customers.length,
            total_orders: store.state.orders.length,
            paid_orders: paidOrders.length,
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
          });
        }

        if (method === "GET" && pathname === "/api/v1/admin/audit-logs") {
          assertStaffPermission(principal, "audit_logs.read");
          const items = store.state.audit_logs.map((a) => ({
            ...a,
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
    return processTransactionalOutboxBatch(store, {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
    });
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
    const store = await resolveRequestStore(env, ctx);
    return handleRequest(store, request, env, ctx);
  }

  return {
    store: injectedStore ?? null,
    fetch: fetchHandler,
    scheduled: handleScheduled,
  };
}
