/**
 * TanStack Router tree (design spec §12.1, PRD §2.1).
 *
 * Two layout routes — never both mounted at once:
 *  - _main: the operational shell (14 sections, grouped sidebar).
 *  - /settings: the DEDICATED Settings shell (path route, no `id` —
 *    TanStack Router forbids a route having both `id` and `path`;
 *    2026-11-15 this threw at bundle load and blanked the whole SPA).
 *    Entering /settings collapses the main menu to a 64px icon rail
 *    beside the expanded Settings nav (collapse ≠ hide, owner
 *    decision 2026-11-15); leaving restores the main menu. Settings
 *    holds ALL configuration pages as explicit routes
 *    (/settings/websites, /settings/payment-methods,
 *    /settings/webhooks, /settings/tracking) — no generic $category
 *    placeholder route.
 *
 * Every operational section is a route component under src/sections/
 * (one createRoute per section, list + detail where the API supports it).
 * List routes validate search with listSearch: q/page/pageSize parsed by
 * parseListSearch, plus any extra string filter params a section uses
 * (status, product, payment_status, action, resource_type, outcome,
 * actor_type, …) preserved verbatim so URL-backed filters survive
 * navigation. Auth is gated at the root: no session → the sign-in /
 * first-admin-setup screens; the shell never renders unauth.
 */
import { useEffect, useState, Suspense, lazy } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, apiRequest, onApiUnauthorized } from "./lib/api-client";
import { queryClient } from "./lib/query";
import { isChunkLoadError, maybeReloadForStaleChunk } from "./lib/chunk-retry";
import { parseListSearch, type ListSearch } from "./lib/section-kit";
import {
  AuthProvider,
  MainShell,
  SettingsShell,
  type StaffPrincipalDto,
} from "./components/shell";
import { AuthScreen } from "./components/auth";
import {
  AcceptInvitationPage,
  ResetPasswordPage,
  TwoFactorRecoveryPage,
} from "./components/public-pages";
import { DashboardSection } from "./sections/dashboard";
import { Button, ErrorState, Skeleton, TableSkeleton } from "./components/primitives";

/**
 * Route-level code splitting (design spec §5.6): every section loads on
 * demand; the dashboard (index) and auth stay in the initial bundle.
 * Sections export named components, so each lazy() maps to a default.
 */
// D-16: TwoFactorSetup pulls in qrcode-generator — lazy so the QR
// library is downloaded only on the forced-2FA screen / 2FA dialogs.
const TwoFactorSetup = lazy(() =>
  import("./components/two-factor-setup").then((m) => ({ default: m.TwoFactorSetup })),
);
const GeneralSettingsSection = lazy(() =>
  import("./sections/general-settings").then((m) => ({ default: m.GeneralSettingsSection })),
);
const AuditLogsSection = lazy(() =>
  import("./sections/audit-logs").then((m) => ({ default: m.AuditLogsSection })),
);
const AuthSettingsSection = lazy(() =>
  import("./sections/auth-settings").then((m) => ({ default: m.AuthSettingsSection })),
);
const EmailSettingsSection = lazy(() =>
  import("./sections/email-settings").then((m) => ({ default: m.EmailSettingsSection })),
);
const CustomersSection = lazy(() =>
  import("./sections/customers").then((m) => ({ default: m.CustomersSection })),
);
const CustomerDetailSection = lazy(() =>
  import("./sections/customers").then((m) => ({ default: m.CustomerDetailSection })),
);
const FeaturesSection = lazy(() =>
  import("./sections/features").then((m) => ({ default: m.FeaturesSection })),
);
const FeatureDetailSection = lazy(() =>
  import("./sections/features").then((m) => ({ default: m.FeatureDetailSection })),
);
const IntegrationsSection = lazy(() =>
  import("./sections/integrations").then((m) => ({ default: m.IntegrationsSection })),
);
const IntegratedSiteDetailSection = lazy(() =>
  import("./sections/integrations").then((m) => ({
    default: m.IntegratedSiteDetailSection,
  })),
);
const LicensesSection = lazy(() =>
  import("./sections/licenses").then((m) => ({ default: m.LicensesSection })),
);
const LicenseDetailSection = lazy(() =>
  import("./sections/licenses").then((m) => ({ default: m.LicenseDetailSection })),
);
const OrdersSection = lazy(() =>
  import("./sections/orders").then((m) => ({ default: m.OrdersSection })),
);
const OrderDetailSection = lazy(() =>
  import("./sections/orders").then((m) => ({ default: m.OrderDetailSection })),
);
const PackagesSection = lazy(() =>
  import("./sections/packages").then((m) => ({ default: m.PackagesSection })),
);
const PackageDetailSection = lazy(() =>
  import("./sections/packages").then((m) => ({ default: m.PackageDetailSection })),
);
const PaymentMethodsSection = lazy(() =>
  import("./sections/payment-methods").then((m) => ({
    default: m.PaymentMethodsSection,
  })),
);
const PaymentMethodDetailSection = lazy(() =>
  import("./sections/payment-methods").then((m) => ({
    default: m.PaymentMethodDetailSection,
  })),
);
const PaymentReviewSection = lazy(() =>
  import("./sections/payment-review").then((m) => ({
    default: m.PaymentReviewSection,
  })),
);
const PaymentSubmissionDetailSection = lazy(() =>
  import("./sections/payment-review").then((m) => ({
    default: m.PaymentSubmissionDetailSection,
  })),
);
const RefundsSection = lazy(() =>
  import("./sections/refunds").then((m) => ({ default: m.RefundsSection })),
);
// Expense Module (2026-11-25): Finance pages in the main menu and
// the category config page under Settings.
const ExpensesSection = lazy(() =>
  import("./sections/expenses").then((m) => ({ default: m.ExpensesSection })),
);
const ProfitLossSection = lazy(() =>
  import("./sections/profit-loss").then((m) => ({ default: m.ProfitLossSection })),
);
const ExpenseCategoriesSection = lazy(() =>
  import("./sections/expense-categories").then((m) => ({
    default: m.ExpenseCategoriesSection,
  })),
);
const ProductsSection = lazy(() =>
  import("./sections/products").then((m) => ({ default: m.ProductsSection })),
);
const ProductDetailSection = lazy(() =>
  import("./sections/products").then((m) => ({ default: m.ProductDetailSection })),
);
const StaffSection = lazy(() =>
  import("./sections/staff").then((m) => ({ default: m.StaffSection })),
);
const StaffUserDetailSection = lazy(() =>
  import("./sections/staff").then((m) => ({ default: m.StaffUserDetailSection })),
);
const SubscriptionsSection = lazy(() =>
  import("./sections/subscriptions").then((m) => ({
    default: m.SubscriptionsSection,
  })),
);
const SubscriptionDetailSection = lazy(() =>
  import("./sections/subscriptions").then((m) => ({
    default: m.SubscriptionDetailSection,
  })),
);
const TrackingSection = lazy(() =>
  import("./sections/tracking").then((m) => ({ default: m.TrackingSection })),
);
const TicketsSection = lazy(() =>
  import("./sections/tickets").then((m) => ({ default: m.TicketsSection })),
);
const TicketDetailSection = lazy(() =>
  import("./sections/tickets").then((m) => ({ default: m.TicketDetailSection })),
);
const LeadsSection = lazy(() =>
  import("./sections/leads").then((m) => ({ default: m.LeadsSection })),
);
const LeadDetailSection = lazy(() =>
  import("./sections/leads").then((m) => ({ default: m.LeadDetailSection })),
);
const MediaLibrarySection = lazy(() =>
  import("./sections/media-library").then((m) => ({ default: m.MediaLibrarySection })),
);
const StorageSettingsSection = lazy(() =>
  import("./sections/storage-settings").then((m) => ({ default: m.StorageSettingsSection })),
);
const IntegrationGuideSection = lazy(() =>
  import("./sections/integration-guide").then((m) => ({
    default: m.IntegrationGuideSection,
  })),
);
const TrackingConfigSection = lazy(() =>
  import("./sections/tracking-config").then((m) => ({
    default: m.TrackingConfigSection,
  })),
);
const OutboxSection = lazy(() =>
  import("./sections/outbox").then((m) => ({ default: m.OutboxSection })),
);
const WebhooksSection = lazy(() =>
  import("./sections/webhooks").then((m) => ({ default: m.WebhooksSection })),
);
const WebhookDetailSection = lazy(() =>
  import("./sections/webhooks").then((m) => ({ default: m.WebhookDetailSection })),
);
// E-21: Jobs/Runs view (scheduled jobs + sweep runs).
const JobsSection = lazy(() =>
  import("./sections/jobs").then((m) => ({ default: m.JobsSection })),
);
// E-09: Renewals view (upcoming/due/overdue/failed/cancelled buckets).
const RenewalsSection = lazy(() =>
  import("./sections/renewals").then((m) => ({ default: m.RenewalsSection })),
);
// E-05: Signing-key lifecycle surface (Settings/Licenses).
const SigningKeysSection = lazy(() =>
  import("./sections/signing-keys").then((m) => ({ default: m.SigningKeysSection })),
);
const GettingStartedPage = lazy(() =>
  import("./components/getting-started").then((m) => ({ default: m.GettingStartedPage })),
);

function RootComponent() {
  const [principal, setPrincipal] = useState<StaffPrincipalDto | null>(null);
  const session = useQuery({
    queryKey: ["admin", "me"],
    queryFn: () => apiRequest<StaffPrincipalDto>("/api/v1/admin/me"),
    // Session-check retries (live bug 2026-11-22): the previous
    // `retry: false` made ANY transient /me failure (network blip,
    // 500, cold Worker) render the sign-in screen, so the owner
    // perceived a sign-out after reload and had to sign in again.
    // A 401 means definitively no session — retrying is pointless.
    // Anything else is retried twice with backoff, and if it still
    // fails the connection-error screen below renders instead of
    // the sign-in screen (the API answers 500, not 401, for backend
    // failures — see resolveStaffPrincipal).
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && error.statusCode === 401) return false;
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  useEffect(() => {
    if (session.data) setPrincipal(session.data);
  }, [session.data]);

  // Mid-session expiry (live bug 2026-11-22): when a signed-in tab's
  // session dies (12h expiry, suspension), every section query 401s
  // and each section shows "Something went wrong" instead of the
  // sign-in screen. While a principal is held, a 401 from any admin
  // endpoint drops straight to the sign-in screen. The handler is
  // only registered while signed in, so sign-in's own 401s (wrong
  // password) never trigger it, and it is scoped to /api/v1/admin/*
  // inside api-client.
  useEffect(() => {
    if (!principal) return;
    onApiUnauthorized(() => setPrincipal(null));
    return () => onApiUnauthorized(null);
  }, [principal]);

  // Public pages (Auth + Email batch): /reset-password, /accept-invitation
  // and /two-factor-recovery render OUTSIDE the principal gate — they are
  // reached from email links by signed-out users. The pathname check runs
  // before any principal logic, so the AuthScreen never flashes here.
  const publicPath = window.location.pathname.replace(/\/+$/, "") || "/";
  if (publicPath === "/reset-password") return <ResetPasswordPage />;
  if (publicPath === "/accept-invitation") return <AcceptInvitationPage />;
  if (publicPath === "/two-factor-recovery") return <TwoFactorRecoveryPage />;

  if (session.isPending && !principal) {
    return (
      <main className="sm-auth">
        <div style={{ width: "100%", maxWidth: 400 }}>
          <Skeleton height={24} width="50%" />
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={32} width="40%" />
          </div>
        </div>
      </main>
    );
  }

  // Session check failed (live bug 2026-11-22): only a 401 means
  // "no session" and shows the sign-in screen. Any other failure —
  // network, 500, timeout — means the check itself failed, not that
  // the user is signed out, so it renders a retry screen instead:
  // the session cookie is untouched and Retry re-runs the check.
  if (session.isError && !principal) {
    const err = session.error;
    if (err instanceof ApiClientError && err.statusCode === 401) {
      return <AuthScreen onSignedIn={setPrincipal} />;
    }
    return (
      <main className="sm-auth">
        <section className="sm-auth-card" aria-labelledby="session-check-heading">
          <h1 id="session-check-heading" className="sm-page-title">
            Couldn&apos;t reach the server
          </h1>
          <p className="sm-hint" style={{ marginTop: 12 }}>
            Your sign-in could not be checked — the server did not answer. You have not
            been signed out. Try again.
          </p>
          <p style={{ marginTop: 8 }}>
            {err instanceof Error ? err.message : "Request failed"}
          </p>
          <div style={{ marginTop: 16 }}>
            <Button variant="primary" onClick={() => void session.refetch()}>
              Retry
            </Button>
          </div>
        </section>
      </main>
    );
  }

  if (!principal) {
    return <AuthScreen onSignedIn={setPrincipal} />;
  }

  // Forced 2FA setup (Auth + Email batch): the policy requires 2FA for
  // one of the user's roles and it is not set up yet. The session is
  // restricted server-side (every admin endpoint returns 403
  // TWO_FACTOR_SETUP_REQUIRED), so the app shell must not render — the
  // wizard is the whole screen. On done, /me is reloaded; the flag
  // clears and the shell renders.
  if (principal.two_factor_setup_required) {
    return (
      <main className="sm-auth">
        <section className="sm-auth-card" aria-labelledby="forced-2fa-heading">
          <h1 id="forced-2fa-heading" className="sm-page-title">
            Set up two-factor authentication
          </h1>
          <Suspense
            fallback={
              <div style={{ marginTop: 16 }}>
                <Skeleton height={120} />
              </div>
            }
          >
            <TwoFactorSetup
              forced
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: ["admin", "me"] });
              }}
            />
          </Suspense>
        </section>
      </main>
    );
  }

  return (
    <AuthProvider principal={principal} onSignedOut={() => setPrincipal(null)}>
      <Outlet />
    </AuthProvider>
  );
}

function NotFound() {
  return (
    <main className="sm-auth">
      <section className="sm-auth-card" aria-labelledby="not-found-heading">
        <h1 id="not-found-heading" className="sm-page-title">
          Page not found
        </h1>
        <p className="sm-hint" style={{ marginTop: 12 }}>
          This admin page does not exist.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link to="/">Back to Dashboard</Link>
        </p>
      </section>
    </main>
  );
}

/**
 * List-route search validation: q/page/pageSize via parseListSearch, plus
 * any extra string filter params the section puts in the URL (status,
 * product, payment_status, action, resource_type, outcome, actor_type).
 * Sections read search loosely (useSearch strict:false / router state),
 * so the exact set per route does not need to be enumerated here.
 */
function listSearch(search: Record<string, unknown>): ListSearch & Record<string, string | number> {
  const base = parseListSearch(search);
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (key !== "q" && key !== "page" && key !== "pageSize" && typeof value === "string") {
      extra[key] = value;
    }
  }
  return { ...base, ...extra };
}

const rootRoute = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFound,
});

const mainRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_main",
  component: MainShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => mainRoute,
  path: "/",
  component: DashboardSection,
});

type LazySection = React.LazyExoticComponent<() => React.JSX.Element>;
type LazyDetailSection = React.LazyExoticComponent<(props: {
  id: string;
}) => React.JSX.Element>;

function makeListRoute(path: string, Section: LazySection) {
  return createRoute({
    getParentRoute: () => mainRoute,
    path,
    validateSearch: listSearch,
    component: function ListRoute() {
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <Section />
        </Suspense>
      );
    },
  });
}

function makeDetailRoute(path: string, param: string, Section: LazyDetailSection) {
  return createRoute({
    getParentRoute: () => mainRoute,
    path,
    component: function DetailRoute() {
      const params = useParams({ strict: false }) as Record<string, string | undefined>;
      const id = params[param];
      if (!id) return null;
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <Section id={id} />
        </Suspense>
      );
    },
  });
}

const productsRoute = makeListRoute("/products", ProductsSection);
const productDetailRoute = makeDetailRoute("/products/$productId", "productId", ProductDetailSection);
const featuresRoute = makeListRoute("/features", FeaturesSection);
const featureDetailRoute = makeDetailRoute("/features/$featureId", "featureId", FeatureDetailSection);
const packagesRoute = makeListRoute("/packages", PackagesSection);
const packageDetailRoute = makeDetailRoute("/packages/$packageId", "packageId", PackageDetailSection);
const customersRoute = makeListRoute("/customers", CustomersSection);
const customerDetailRoute = makeDetailRoute("/customers/$customerId", "customerId", CustomerDetailSection);
const ordersRoute = makeListRoute("/orders", OrdersSection);
const orderDetailRoute = makeDetailRoute("/orders/$orderId", "orderId", OrderDetailSection);
const paymentReviewRoute = makeListRoute("/payment-review", PaymentReviewSection);
const paymentSubmissionDetailRoute = makeDetailRoute("/payment-review/$submissionId", "submissionId", PaymentSubmissionDetailSection);
// Refunds standalone list — same list as the Payment Review Refunds tab
// (D-4), on its own Commerce nav entry.
const refundsRoute = makeListRoute("/refunds", RefundsSection);
// Expense Module (2026-11-25): Finance group — operational expense
// list + P&L analytics. Categories are config, so they live under
// /settings/* (see the settings routes below).
const expensesRoute = makeListRoute("/expenses", ExpensesSection);
const profitLossRoute = makeListRoute("/analytics/profit-loss", ProfitLossSection);
const subscriptionsRoute = makeListRoute("/subscriptions", SubscriptionsSection);
const subscriptionDetailRoute = makeDetailRoute("/subscriptions/$subscriptionId", "subscriptionId", SubscriptionDetailSection);
const licensesRoute = makeListRoute("/licenses", LicensesSection);
const licenseDetailRoute = makeDetailRoute("/licenses/$licenseId", "licenseId", LicenseDetailSection);
// Tracking events + outbox are audit/report views (Administration).
// The config pages (websites, payment methods, webhooks, tracking
// pixel-groups) live under /settings/* — see the settings routes below.
const trackingEventsRoute = makeListRoute("/tracking-events", TrackingSection);
const jobsRoute = makeListRoute("/jobs", JobsSection);
const renewalsRoute = makeListRoute("/renewals", RenewalsSection);
const outboxRoute = makeListRoute("/outbox", OutboxSection);
const staffRoute = makeListRoute("/staff", StaffSection);
const staffUserDetailRoute = makeDetailRoute("/staff/$userId", "userId", StaffUserDetailSection);
const auditLogsRoute = makeListRoute("/audit-logs", AuditLogsSection);
// Customer+Order batch (ADR-0009): Support Tickets + Leads are
// operational main-menu sections (not Settings).
const ticketsRoute = makeListRoute("/tickets", TicketsSection);
const ticketDetailRoute = makeDetailRoute("/tickets/$ticketId", "ticketId", TicketDetailSection);
const leadsRoute = makeListRoute("/leads", LeadsSection);
const leadDetailRoute = makeDetailRoute("/leads/$leadId", "leadId", LeadDetailSection);
// Media library (PLAN §31): main-menu section under Product.
const mediaRoute = makeListRoute("/media", MediaLibrarySection);
// Help menu (audit D-7): small Getting Started page, real content only.
const gettingStartedRoute = makeListRoute("/getting-started", GettingStartedPage);

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsShell,
});

/**
 * Settings children (restructure batch): every config page is an
 * explicit route under the Settings shell — no generic $category
 * placeholder route. The sections are the same components as before,
 * re-parented; their internal navigation targets were updated to the
 * /settings/* paths. The helpers are generic over the path literal so
 * the router type keeps "/settings/websites" etc. as valid `to`
 * targets for typed navigate/Navigate — a plain `path: string`
 * widens the literal and typed navigation to these routes fails
 * (tsc 2026-11-16).
 */
function makeSettingsListRoute<TPath extends string>(path: TPath, Section: LazySection) {
  return createRoute({
    getParentRoute: () => settingsRoute,
    path,
    validateSearch: listSearch,
    component: function ListRoute() {
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <Section />
        </Suspense>
      );
    },
  });
}

function makeSettingsDetailRoute<TPath extends string>(path: TPath, param: string, Section: LazyDetailSection) {
  return createRoute({
    getParentRoute: () => settingsRoute,
    path,
    component: function DetailRoute() {
      const params = useParams({ strict: false }) as Record<string, string | undefined>;
      const id = params[param];
      if (!id) return null;
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <Section id={id} />
        </Suspense>
      );
    },
  });
}

const settingsWebsitesRoute = makeSettingsListRoute("/websites", IntegrationsSection);
const settingsWebsiteDetailRoute = makeSettingsDetailRoute(
  "/websites/$siteId",
  "siteId",
  IntegratedSiteDetailSection,
);
const settingsPaymentMethodsRoute = makeSettingsListRoute(
  "/payment-methods",
  PaymentMethodsSection,
);
const settingsExpenseCategoriesRoute = makeSettingsListRoute(
  "/expense-categories",
  ExpenseCategoriesSection,
);
const settingsPaymentMethodDetailRoute = makeSettingsDetailRoute(
  "/payment-methods/$methodId",
  "methodId",
  PaymentMethodDetailSection,
);
const settingsWebhooksRoute = makeSettingsListRoute("/webhooks", WebhooksSection);
const settingsWebhookDetailRoute = makeSettingsDetailRoute(
  "/webhooks/$webhookId",
  "webhookId",
  WebhookDetailSection,
);
const settingsTrackingRoute = makeSettingsListRoute("/tracking", TrackingConfigSection);
const settingsAuthRoute = makeSettingsListRoute("/authentication", AuthSettingsSection);
const settingsSigningKeysRoute = makeSettingsListRoute(
  "/signing-keys",
  SigningKeysSection,
);
const settingsEmailRoute = makeSettingsListRoute("/email", EmailSettingsSection);
const settingsGeneralRoute = makeSettingsListRoute("/general", GeneralSettingsSection);
const settingsStorageRoute = makeSettingsListRoute("/storage", StorageSettingsSection);
const settingsIntegrationGuideRoute = makeSettingsListRoute(
  "/integration-guide",
  IntegrationGuideSection,
);

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: () => <Navigate to="/settings/general" />,
});

const routeTree = rootRoute.addChildren([
  mainRoute.addChildren([
    dashboardRoute,
    productsRoute,
    productDetailRoute,
    featuresRoute,
    featureDetailRoute,
    packagesRoute,
    packageDetailRoute,
    customersRoute,
    customerDetailRoute,
    ordersRoute,
    orderDetailRoute,
    paymentReviewRoute,
    paymentSubmissionDetailRoute,
    refundsRoute,
    expensesRoute,
    profitLossRoute,
    subscriptionsRoute,
    subscriptionDetailRoute,
    licensesRoute,
    licenseDetailRoute,
    trackingEventsRoute,
    outboxRoute,
    jobsRoute,
    renewalsRoute,
    staffRoute,
    staffUserDetailRoute,
    auditLogsRoute,
    ticketsRoute,
    ticketDetailRoute,
    leadsRoute,
    leadDetailRoute,
    mediaRoute,
    gettingStartedRoute,
  ]),
  settingsRoute.addChildren([
    settingsIndexRoute,
    settingsWebsitesRoute,
    settingsWebsiteDetailRoute,
    settingsPaymentMethodsRoute,
    settingsPaymentMethodDetailRoute,
    settingsExpenseCategoriesRoute,
    settingsWebhooksRoute,
    settingsWebhookDetailRoute,
    settingsTrackingRoute,
    settingsAuthRoute,
    settingsSigningKeysRoute,
    settingsEmailRoute,
    settingsGeneralRoute,
    settingsStorageRoute,
    settingsIntegrationGuideRoute,
  ]),
]);

/**
 * Router-level error screen (live bug 2026-11-22): every route uses
 * TanStack Router's default error component unless it defines its
 * own, so a failed lazy import rendered the bare "Something went
 * wrong!" with no recovery. This replaces it app-wide:
 *  - a chunk-load failure reloads once (fresh index.html carries the
 *    current chunk hashes after a deploy); if the reload already
 *    happened recently, or the error is not a chunk failure, the
 *    screen below renders instead of reload-looping.
 *  - other render errors get the app's ErrorState with a Retry that
 *    resets the boundary; a chunk failure's Retry reloads the page
 *    instead, because React.lazy caches a rejected import and reset()
 *    alone cannot re-fetch it.
 */
function RouteErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const chunkError = isChunkLoadError(error);
  useEffect(() => {
    if (chunkError) maybeReloadForStaleChunk(error);
    // Reload exactly once per mount for a chunk failure; the
    // timestamp guard inside maybeReloadForStaleChunk is what
    // stops a loop, so this effect intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const message = chunkError
    ? "The app was updated and this page failed to load. It should reload once on its own — if it is still showing this, use the button below."
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  return (
    <ErrorState
      message={message}
      onRetry={chunkError ? () => window.location.reload() : reset}
    />
  );
}

export const router = createRouter({ routeTree, defaultErrorComponent: RouteErrorComponent });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
