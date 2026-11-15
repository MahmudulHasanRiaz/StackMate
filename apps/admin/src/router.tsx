/**
 * TanStack Router tree (design spec §12.1, PRD §2.1).
 *
 * Two layout routes — never both mounted at once:
 *  - _main: the operational shell (15 sections, grouped sidebar).
 *  - /settings: the DEDICATED Settings shell (path route, no `id` —
 *    TanStack Router forbids a route having both `id` and `path`;
 *    2026-11-15 this threw at bundle load and blanked the whole SPA).
 *    Entering /settings unmounts the main menu (it collapses/hides)
 *    and opens the Settings area expanded with its own sub-menu.
 *    Leaving restores the main menu.
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
import { SettingsCategoryPage } from "./sections/settings";
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
const paymentMethodsRoute = makeListRoute("/payment-methods", PaymentMethodsSection);
const paymentMethodDetailRoute = makeDetailRoute("/payment-methods/$methodId", "methodId", PaymentMethodDetailSection);
const paymentReviewRoute = makeListRoute("/payment-review", PaymentReviewSection);
const paymentSubmissionDetailRoute = makeDetailRoute("/payment-review/$submissionId", "submissionId", PaymentSubmissionDetailSection);
const subscriptionsRoute = makeListRoute("/subscriptions", SubscriptionsSection);
const subscriptionDetailRoute = makeDetailRoute("/subscriptions/$subscriptionId", "subscriptionId", SubscriptionDetailSection);
const licensesRoute = makeListRoute("/licenses", LicensesSection);
const licenseDetailRoute = makeDetailRoute("/licenses/$licenseId", "licenseId", LicenseDetailSection);
const integrationsRoute = makeListRoute("/integrations", IntegrationsSection);
const integratedSiteDetailRoute = makeDetailRoute("/integrations/$siteId", "siteId", IntegratedSiteDetailSection);
const trackingRoute = makeListRoute("/tracking", TrackingSection);
const webhooksRoute = makeListRoute("/webhooks", WebhooksSection);
const webhookDetailRoute = makeDetailRoute("/webhooks/$webhookId", "webhookId", WebhookDetailSection);
const staffRoute = makeListRoute("/staff", StaffSection);
const staffUserDetailRoute = makeDetailRoute("/staff/$userId", "userId", StaffUserDetailSection);
const auditLogsRoute = makeListRoute("/audit-logs", AuditLogsSection);

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsShell,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: () => <Navigate to="/settings/$category" params={{ category: "category-1" }} />,
});

function SettingsCategoryRoute() {
  const { category } = useParams({ from: "/settings/$category" });
  return <SettingsCategoryPage category={category} />;
}

const settingsCategoryRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "$category",
  component: SettingsCategoryRoute,
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
    paymentMethodsRoute,
    paymentMethodDetailRoute,
    paymentReviewRoute,
    paymentSubmissionDetailRoute,
    subscriptionsRoute,
    subscriptionDetailRoute,
    licensesRoute,
    licenseDetailRoute,
    integrationsRoute,
    integratedSiteDetailRoute,
    trackingRoute,
    webhooksRoute,
    webhookDetailRoute,
    staffRoute,
    staffUserDetailRoute,
    auditLogsRoute,
  ]),
  settingsRoute.addChildren([settingsIndexRoute, settingsCategoryRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
