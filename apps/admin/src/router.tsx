/**
 * TanStack Router tree (design spec §12.1, PRD §2.1).
 *
 * Two layout routes — never both mounted at once:
 *  - _main: the operational shell (13 sections, grouped sidebar).
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
import { apiRequest } from "./lib/api-client";
import { parseListSearch, type ListSearch } from "./lib/section-kit";
import {
  AuthProvider,
  MainShell,
  SettingsShell,
  type StaffPrincipalDto,
} from "./components/shell";
import { AuthScreen } from "./components/auth";
import { DashboardSection } from "./sections/dashboard";
import { Skeleton, TableSkeleton } from "./components/primitives";

/**
 * Route-level code splitting (design spec §5.6): every section loads on
 * demand; the dashboard (index) and auth stay in the initial bundle.
 * Sections export named components, so each lazy() maps to a default.
 */
const AuditLogsSection = lazy(() =>
  import("./sections/audit-logs").then((m) => ({ default: m.AuditLogsSection })),
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

function RootComponent() {
  const [principal, setPrincipal] = useState<StaffPrincipalDto | null>(null);
  const session = useQuery({
    queryKey: ["admin", "me"],
    queryFn: () => apiRequest<StaffPrincipalDto>("/api/v1/admin/me"),
    retry: false,
  });

  useEffect(() => {
    if (session.data) setPrincipal(session.data);
  }, [session.data]);

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

  if (!principal) {
    return <AuthScreen onSignedIn={setPrincipal} />;
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
const subscriptionsRoute = makeListRoute("/subscriptions", SubscriptionsSection);
const subscriptionDetailRoute = makeDetailRoute("/subscriptions/$subscriptionId", "subscriptionId", SubscriptionDetailSection);
const licensesRoute = makeListRoute("/licenses", LicensesSection);
const licenseDetailRoute = makeDetailRoute("/licenses/$licenseId", "licenseId", LicenseDetailSection);
// Tracking events + outbox are audit/report views (Administration).
// The config pages (websites, payment methods, webhooks, tracking
// pixel-groups) live under /settings/* — see the settings routes below.
const trackingEventsRoute = makeListRoute("/tracking-events", TrackingSection);
const outboxRoute = makeListRoute("/outbox", OutboxSection);
const staffRoute = makeListRoute("/staff", StaffSection);
const staffUserDetailRoute = makeDetailRoute("/staff/$userId", "userId", StaffUserDetailSection);
const auditLogsRoute = makeListRoute("/audit-logs", AuditLogsSection);

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

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: () => <Navigate to="/settings/websites" />,
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
    subscriptionsRoute,
    subscriptionDetailRoute,
    licensesRoute,
    licenseDetailRoute,
    trackingEventsRoute,
    outboxRoute,
    staffRoute,
    staffUserDetailRoute,
    auditLogsRoute,
  ]),
  settingsRoute.addChildren([
    settingsIndexRoute,
    settingsWebsitesRoute,
    settingsWebsiteDetailRoute,
    settingsPaymentMethodsRoute,
    settingsPaymentMethodDetailRoute,
    settingsWebhooksRoute,
    settingsWebhookDetailRoute,
    settingsTrackingRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
