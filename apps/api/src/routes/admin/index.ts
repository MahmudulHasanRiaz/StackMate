/**
 * Admin route barrel (Hono migration, Phase 1).
 *
 * Re-exports the register functions of ALL admin route modules.
 * Each module owns its own file under `routes/admin/` — this barrel
 * only composes them. Registration order does not change routing
 * (Hono matches by method + path), but one canonical order keeps
 * `app.routes` stable and reviewable.
 */
export { registerAdminCoreRoutes } from "./core.ts";
export { registerAdminAuthConfigRoutes } from "./auth-config.ts";
export { registerAdminGeneralSettingsRoutes } from "./general-settings.ts";
export { registerAdminMediaRoutes } from "./media.ts";
export { registerAdminSettingsRoutes } from "./settings.ts";
export { registerAdminIdentityRoutes } from "./identity.ts";
export { registerAdminUsersRoutes } from "./users.ts";
export { registerAdminProductsRoutes } from "./products.ts";
export { registerProductFeaturesRoutes } from "./product-features.ts";
export { registerProductPackagesRoutes } from "./product-packages.ts";
export { registerAdminCustomersRoutes } from "./customers.ts";
export { registerCustomerDetailRoutes } from "./customer-detail.ts";
export { registerAdminOrdersRoutes } from "./orders.ts";
export { registerAdminInvoicesRoutes } from "./invoices.ts";
export { registerAdminTicketsRoutes } from "./tickets.ts";
export { registerAdminLeadsRoutes } from "./leads.ts";
export { registerAdminPaymentsRoutes } from "./payments.ts";
export { registerAdminPaymentSubmissionsRoutes } from "./payments-submissions.ts";
export { registerAdminPaymentApprovalsRoutes } from "./payments-approvals.ts";
export { registerAdminSubscriptionsRoutes } from "./subscriptions.ts";
export { registerAdminLicensesRoutes } from "./licenses.ts";
export { registerAdminSitesRoutes } from "./sites.ts";
export { registerAdminSiteCredentialsRoutes } from "./sites-credentials.ts";
export { registerAdminApiTokensRoutes } from "./api-tokens.ts";
export { registerAdminSiteDomainsRoutes } from "./sites-domains.ts";
export { registerAdminSiteTrackingRoutes } from "./sites-tracking.ts";
export { registerAdminWebhooksRoutes } from "./webhooks.ts";
export { registerAdminExpensesRoutes } from "./expenses.ts";
export { registerAdminPlatformRoutes } from "./platform.ts";
export { registerAdminPlatformAnalyticsRoutes } from "./platform-analytics.ts";
export { registerAdminPlatformAuditRoutes } from "./platform-audit.ts";
