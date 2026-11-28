/**
 * Hono route registry (Hono migration Phase 0/1).
 *
 * Every route module under `apps/api/src/routes/` exports one
 * `register<Name>Routes(app: Hono<AppEnv>): void` function. This file
 * only composes them — it contains no handlers, no business logic.
 *
 * Order follows the migration plan's module list. Registration order
 * does not change routing (Hono matches by method + path), but keeping
 * one canonical order makes the conformance test's `app.routes` dump
 * stable and reviewable.
 *
 * NOTE — `registerAuthFallbackRoutes` MUST stay last: it is
 * `app.all("/api/auth/*")` (Better Auth delegation) and would shadow
 * the specific auth routes if registered before them.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types/context.ts";
import { registerMetaRoutes } from "./meta.ts";
import { registerAuthRoutes } from "./auth.ts";
import { registerAuthPasswordRoutes } from "./auth/password.ts";
import { registerAuthTwoFactorRoutes } from "./auth/two-factor.ts";
import { registerAuthFallbackRoutes } from "./auth/fallback.ts";
import { registerLicensesRoutes } from "./licenses/index.ts";
import { registerPublicRoutes } from "./public/index.ts";
import { registerPublicCheckoutRoutes } from "./public/checkout.ts";
import { registerPublicTrackingRoutes } from "./public/tracking.ts";
import { registerIntegrationsRoutes } from "./integrations/index.ts";
import { registerIntegrationOrdersRoutes } from "./integrations/orders.ts";
import { registerIntegrationEventsRoutes } from "./integrations/events.ts";
import {
  registerAdminAuthConfigRoutes,
  registerAdminCoreRoutes,
  registerAdminCustomersRoutes,
  registerAdminExpensesRoutes,
  registerAdminGeneralSettingsRoutes,
  registerAdminIdentityRoutes,
  registerAdminInvoicesRoutes,
  registerAdminLeadsRoutes,
  registerAdminLicensesRoutes,
  registerAdminMediaRoutes,
  registerAdminOrdersRoutes,
  registerAdminPaymentApprovalsRoutes,
  registerAdminPaymentSubmissionsRoutes,
  registerAdminPaymentsRoutes,
  registerAdminPlatformAnalyticsRoutes,
  registerAdminPlatformAuditRoutes,
  registerAdminPlatformRoutes,
  registerAdminProductsRoutes,
  registerAdminSettingsRoutes,
  registerAdminSiteCredentialsRoutes,
  registerAdminApiTokensRoutes,
  registerAdminSiteDomainsRoutes,
  registerAdminSiteTrackingRoutes,
  registerAdminSitesRoutes,
  registerAdminSubscriptionsRoutes,
  registerAdminTicketsRoutes,
  registerAdminUsersRoutes,
  registerAdminWebhooksRoutes,
  registerCustomerDetailRoutes,
  registerProductFeaturesRoutes,
  registerProductPackagesRoutes,
} from "./admin/index.ts";
import { registerGraphQLRoutes } from "./graphql.ts";

export function registerAllRoutes(app: Hono<AppEnv>): void {
  registerMetaRoutes(app);
  registerAuthRoutes(app);
  registerAuthPasswordRoutes(app);
  registerAuthTwoFactorRoutes(app);
  registerLicensesRoutes(app);
  registerPublicRoutes(app);
  registerPublicCheckoutRoutes(app);
  registerPublicTrackingRoutes(app);
  registerIntegrationsRoutes(app);
  registerIntegrationOrdersRoutes(app);
  registerIntegrationEventsRoutes(app);
  registerAdminCoreRoutes(app);
  registerAdminAuthConfigRoutes(app);
  registerAdminGeneralSettingsRoutes(app);
  registerAdminMediaRoutes(app);
  registerAdminSettingsRoutes(app);
  registerAdminIdentityRoutes(app);
  registerAdminUsersRoutes(app);
  registerAdminProductsRoutes(app);
  registerProductFeaturesRoutes(app);
  registerProductPackagesRoutes(app);
  registerAdminCustomersRoutes(app);
  registerCustomerDetailRoutes(app);
  registerAdminOrdersRoutes(app);
  registerAdminInvoicesRoutes(app);
  registerAdminTicketsRoutes(app);
  registerAdminLeadsRoutes(app);
  registerAdminPaymentsRoutes(app);
  registerAdminPaymentSubmissionsRoutes(app);
  registerAdminPaymentApprovalsRoutes(app);
  registerAdminSubscriptionsRoutes(app);
  registerAdminLicensesRoutes(app);
  registerAdminSitesRoutes(app);
  registerAdminSiteCredentialsRoutes(app);
  registerAdminApiTokensRoutes(app);
  registerAdminSiteDomainsRoutes(app);
  registerAdminSiteTrackingRoutes(app);
  registerAdminWebhooksRoutes(app);
  registerAdminExpensesRoutes(app);
  registerAdminPlatformRoutes(app);
  registerAdminPlatformAnalyticsRoutes(app);
  registerAdminPlatformAuditRoutes(app);
  registerGraphQLRoutes(app);
  // LAST — the Better Auth catch-all must not shadow specific auth routes.
  registerAuthFallbackRoutes(app);
}
