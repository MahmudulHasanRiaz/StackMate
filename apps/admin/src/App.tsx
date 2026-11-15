/**
 * StackMate Central Admin Application (UI/UX & Design System Specification v1.0).
 *
 * Implements the 6 primary navigation groups:
 * 1. Overview: Dashboard (real verified revenue & operational counts)
 * 2. Product: Products, Features, Packages & Pricing
 * 3. Commerce: Customers, Orders & Custom Package Builder, Invoices, Payment Methods, Payment Review
 * 4. Recurring & Access: Subscriptions & Renewals, Licenses & Activations
 * 5. Integrations: Websites & Domains, Credentials, Webhooks, Tracking / Meta CAPI
 * 6. Administration: Staff & Roles, Audit Log
 */
import React, { useEffect, useState } from "react";
import {
  apiRequest,
  formatDisplayDateDDMMYYYY,
  formatMinorMoney,
} from "./lib/api-client.ts";
import { DateCell, EmptyState, MoneyCell, StatusBadge } from "./components/primitives.tsx";

export type AdminSectionKey =
  | "dashboard"
  | "products"
  | "features"
  | "packages"
  | "customers"
  | "orders"
  | "payment_methods"
  | "payment_review"
  | "subscriptions"
  | "licenses"
  | "integrations"
  | "tracking"
  | "webhooks"
  | "staff"
  | "audit_logs";

export const NAVIGATION_GROUPS: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ key: AdminSectionKey; label: string; requiredPermission?: string }>;
}> = [
  {
    group: "Overview",
    items: [{ key: "dashboard", label: "Dashboard" }],
  },
  {
    group: "Product",
    items: [
      { key: "products", label: "Products", requiredPermission: "products.read" },
      { key: "features", label: "Features", requiredPermission: "products.read" },
      { key: "packages", label: "Packages & Pricing", requiredPermission: "products.read" },
    ],
  },
  {
    group: "Commerce",
    items: [
      { key: "customers", label: "Customers", requiredPermission: "customers.read" },
      { key: "orders", label: "Orders & Invoices", requiredPermission: "orders.read" },
      { key: "payment_methods", label: "Payment Methods", requiredPermission: "payments.read" },
      { key: "payment_review", label: "Payment Review", requiredPermission: "payments.read" },
    ],
  },
  {
    group: "Recurring & Access",
    items: [
      { key: "subscriptions", label: "Subscriptions", requiredPermission: "subscriptions.read" },
      { key: "licenses", label: "Licenses & Activations", requiredPermission: "licenses.read" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { key: "integrations", label: "Websites & Credentials", requiredPermission: "integrations.manage" },
      { key: "tracking", label: "Tracking / Meta CAPI", requiredPermission: "tracking.manage" },
      { key: "webhooks", label: "Webhooks & Outbox", requiredPermission: "integrations.manage" },
    ],
  },
  {
    group: "Administration",
    items: [
      { key: "staff", label: "Staff & Roles", requiredPermission: "users.manage" },
      { key: "audit_logs", label: "Audit Log", requiredPermission: "audit_logs.read" },
    ],
  },
];

interface StaffPrincipalDto {
  user: { id: string; name: string; email: string; status: string };
  roles: string[];
  permissions: string[];
}

interface AnalyticsOverviewDto {
  currency_code: string;
  total_products: number;
  active_products: number;
  total_customers: number;
  total_orders: number;
  paid_orders: number;
  pending_payment_submissions: number;
  active_subscriptions: number;
  active_licenses: number;
  expired_or_revoked_licenses: number;
  verified_revenue_minor: number;
  pending_outbox_events: number;
}

export function App() {
  const [principal, setPrincipal] = useState<StaffPrincipalDto | null>(null);
  const [activeSection, setActiveSection] = useState<AdminSectionKey>("dashboard");
  const [overview, setOverview] = useState<AnalyticsOverviewDto | null>(null);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [submissions, setSubmissions] = useState<Array<Record<string, unknown>>>([]);
  const [licenses, setLicenses] = useState<Array<Record<string, unknown>>>([]);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  // First-admin setup (Security, 2026-11-15): the setup form is shown
  // ONLY when GET /api/v1/setup-status positively says setup is
  // required. Any fetch error fails closed toward the sign-in form.
  const [setupStatus, setSetupStatus] = useState<"loading" | "required" | "not-required">(
    "loading"
  );
  const [setupName, setSetupName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupTokenInput, setSetupTokenInput] = useState("");
  const [setupSuccess, setSetupSuccess] = useState<string | null>(null);

  async function loadSetupStatus() {
    try {
      const res = await apiRequest<{ setup_required: boolean }>("/api/v1/setup-status");
      setSetupStatus(res.setup_required ? "required" : "not-required");
    } catch {
      setSetupStatus("not-required");
    }
  }

  async function loadInitialSession() {
    try {
      const me = await apiRequest<StaffPrincipalDto>("/api/v1/admin/me");
      setPrincipal(me);
      const stats = await apiRequest<AnalyticsOverviewDto>("/api/v1/admin/analytics/overview");
      setOverview(stats);
    } catch {
      setPrincipal(null);
    }
  }

  useEffect(() => {
    void loadInitialSession();
    void loadSetupStatus();
  }, []);

  async function handleSetupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    setSetupSuccess(null);
    try {
      await apiRequest("/api/auth/bootstrap-super-admin", {
        method: "POST",
        body: JSON.stringify({
          name: setupName,
          email: setupEmail,
          password: setupPassword,
          setupToken: setupTokenInput,
        }),
      });
      setSetupSuccess("First admin created. Sign in with the new account.");
      setSetupStatus("not-required");
      setEmailInput(setupEmail);
      setSetupPassword("");
      setSetupTokenInput("");
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    try {
      const res = await apiRequest<{ principal: StaffPrincipalDto }>("/api/auth/sign-in", {
        method: "POST",
        body: JSON.stringify({ email: emailInput, password: passwordInput }),
      });
      setPrincipal(res.principal);
      const stats = await apiRequest<AnalyticsOverviewDto>("/api/v1/admin/analytics/overview");
      setOverview(stats);
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  }

  async function handleSignOut() {
    try {
      await apiRequest("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Sign-out is best-effort client-side: the session may already be
      // revoked server-side. Clear local auth state either way.
    }
    setPrincipal(null);
    setOverview(null);
  }

  async function loadSectionData(section: AdminSectionKey) {
    setActiveSection(section);
    setErrorBanner(null);
    try {
      if (section === "dashboard") {
        const stats = await apiRequest<AnalyticsOverviewDto>("/api/v1/admin/analytics/overview");
        setOverview(stats);
      } else if (section === "products" || section === "features" || section === "packages") {
        const res = await apiRequest<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/products"
        );
        setProducts(res.items);
      } else if (section === "payment_review") {
        const res = await apiRequest<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/payment-submissions"
        );
        setSubmissions(res.items);
      } else if (section === "licenses") {
        const res = await apiRequest<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/licenses"
        );
        setLicenses(res.items);
      } else if (section === "audit_logs") {
        const res = await apiRequest<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/audit-logs"
        );
        setAuditLogs(res.items);
      }
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  }

  if (!principal) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <section className="sm-card" style={{ width: "100%", maxWidth: "400px" }}>
          <h1 className="sm-page-title" style={{ marginBottom: "16px" }}>
            {setupStatus === "required" ? "Set up your first admin" : "StackMate Staff Sign In"}
          </h1>
          {setupSuccess ? (
            <div
              role="status"
              className="sm-badge sm-badge-success"
              style={{ display: "block", marginBottom: "12px", padding: "8px 12px" }}
            >
              {setupSuccess}
            </div>
          ) : null}
          {errorBanner ? (
            <div
              role="alert"
              className="sm-badge sm-badge-danger"
              style={{ display: "block", marginBottom: "12px", padding: "8px 12px" }}
            >
              {errorBanner}
            </div>
          ) : null}
          {setupStatus === "loading" ? (
            <div style={{ fontSize: "14px", color: "var(--sm-text-muted)" }}>Loading…</div>
          ) : setupStatus === "required" ? (
            <form onSubmit={handleSetupSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ fontSize: "13px", color: "var(--sm-text-muted)" }}>
                No admin account exists yet. Create the first one — this form
                appears only once. The setup token is the secret set by the
                owner in the Cloudflare dashboard (Worker secret SETUP_TOKEN).
              </div>
              <div className="sm-field">
                <label className="sm-label" htmlFor="sm-setup-name">
                  Name
                </label>
                <input
                  id="sm-setup-name"
                  type="text"
                  className="sm-input"
                  required
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                />
              </div>
              <div className="sm-field">
                <label className="sm-label" htmlFor="sm-setup-email">
                  Email
                </label>
                <input
                  id="sm-setup-email"
                  type="email"
                  className="sm-input"
                  required
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                />
              </div>
              <div className="sm-field">
                <label className="sm-label" htmlFor="sm-setup-password">
                  Password (at least 10 characters)
                </label>
                <input
                  id="sm-setup-password"
                  type="password"
                  className="sm-input"
                  required
                  minLength={10}
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                />
              </div>
              <div className="sm-field">
                <label className="sm-label" htmlFor="sm-setup-token">
                  Setup token
                </label>
                <input
                  id="sm-setup-token"
                  type="password"
                  className="sm-input"
                  required
                  autoComplete="off"
                  value={setupTokenInput}
                  onChange={(e) => setSetupTokenInput(e.target.value)}
                />
              </div>
              <button type="submit" className="sm-btn sm-btn-primary" style={{ justifyContent: "center" }}>
                Create first admin
              </button>
            </form>
          ) : (
          <form onSubmit={handleSignIn} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div className="sm-field">
              <label className="sm-label" htmlFor="sm-email">
                Email
              </label>
              <input
                id="sm-email"
                type="email"
                className="sm-input"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
              />
            </div>
            <div className="sm-field">
              <label className="sm-label" htmlFor="sm-password">
                Password
              </label>
              <input
                id="sm-password"
                type="password"
                className="sm-input"
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
              />
            </div>
            <button type="submit" className="sm-btn sm-btn-primary" style={{ justifyContent: "center" }}>
              Sign In
            </button>
          </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <div className="sm-shell">
      <aside className="sm-sidebar" aria-label="Primary Navigation">
        <div style={{ fontWeight: 700, fontSize: "16px", letterSpacing: "-0.02em" }}>
          StackMate
        </div>
        <nav style={{ flex: 1 }}>
          {NAVIGATION_GROUPS.map((group) => (
            <div key={group.group}>
              <div className="sm-nav-group-label">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="sm-nav-btn"
                  aria-current={activeSection === item.key ? "page" : undefined}
                  onClick={() => void loadSectionData(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="sm-main">
        <header className="sm-topbar">
          <div style={{ fontSize: "13px", color: "var(--sm-text-muted)" }}>
            Signed in as <strong>{principal.user.name}</strong> ({principal.roles.join(", ")})
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              className="sm-nav-btn"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </button>
            <div className="sm-mono" style={{ color: "var(--sm-text-muted)" }}>
              {formatDisplayDateDDMMYYYY(new Date())}
            </div>
          </div>
        </header>

        <main className="sm-content">
          {errorBanner ? (
            <div
              role="alert"
              className="sm-badge sm-badge-danger"
              style={{ display: "block", marginBottom: "16px", padding: "10px 14px" }}
            >
              {errorBanner}
            </div>
          ) : null}

          {activeSection === "dashboard" && overview ? (
            <section aria-labelledby="dash-heading">
              <div className="sm-page-header">
                <h1 id="dash-heading" className="sm-page-title">
                  Operational Overview
                </h1>
              </div>
              <div className="sm-kpi-grid">
                <div className="sm-card">
                  <div className="sm-label">Verified Revenue</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {formatMinorMoney(overview.verified_revenue_minor, overview.currency_code)}
                  </div>
                </div>
                <div className="sm-card">
                  <div className="sm-label">Pending Payment Review</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {overview.pending_payment_submissions}
                  </div>
                </div>
                <div className="sm-card">
                  <div className="sm-label">Active Products</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {overview.active_products} / {overview.total_products}
                  </div>
                </div>
                <div className="sm-card">
                  <div className="sm-label">Paid Orders</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {overview.paid_orders} / {overview.total_orders}
                  </div>
                </div>
                <div className="sm-card">
                  <div className="sm-label">Active Subscriptions</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {overview.active_subscriptions}
                  </div>
                </div>
                <div className="sm-card">
                  <div className="sm-label">Active Licenses</div>
                  <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "6px" }}>
                    {overview.active_licenses}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "products" ? (
            <section aria-labelledby="products-heading">
              <div className="sm-page-header">
                <h1 id="products-heading" className="sm-page-title">
                  Product Catalog
                </h1>
              </div>
              {products.length === 0 ? (
                <EmptyState title="No products registered yet" />
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th className="sm-tabular">Features</th>
                        <th className="sm-tabular">Packages</th>
                        <th>Created (DD/MM/YYYY)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p) => (
                        <tr key={String(p.id)}>
                          <td className="sm-mono">{String(p.code)}</td>
                          <td>{String(p.name)}</td>
                          <td className="sm-mono">{String(p.product_type)}</td>
                          <td>
                            <StatusBadge status={String(p.status)} />
                          </td>
                          <td className="sm-tabular">{Number(p.features_count ?? 0)}</td>
                          <td className="sm-tabular">{Number(p.packages_count ?? 0)}</td>
                          <td>
                            <DateCell isoValue={String(p.created_at)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {activeSection === "payment_review" ? (
            <section aria-labelledby="pay-review-heading">
              <div className="sm-page-header">
                <h1 id="pay-review-heading" className="sm-page-title">
                  Manual Payment Verification Queue
                </h1>
              </div>
              {submissions.length === 0 ? (
                <EmptyState title="No manual payment submissions in queue" />
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Customer</th>
                        <th>Method</th>
                        <th className="sm-tabular">Submitted Amount</th>
                        <th>Sender / Reference</th>
                        <th>Status</th>
                        <th>Submitted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {submissions.map((s) => (
                        <tr key={String(s.id)}>
                          <td className="sm-mono">{String(s.order_number ?? s.order_id)}</td>
                          <td>{String(s.customer_name ?? s.customer_id)}</td>
                          <td>{String(s.payment_method_name ?? s.payment_method_id)}</td>
                          <td className="sm-tabular">
                            <MoneyCell
                              amountMinor={Number(s.amount_minor)}
                              currencyCode={String(s.currency_code)}
                            />
                          </td>
                          <td className="sm-mono">
                            {String(s.sender_phone ?? s.sender_bank_name ?? "—")} /{" "}
                            {String(s.transaction_reference ?? "No Txn ID")}
                          </td>
                          <td>
                            <StatusBadge status={String(s.status)} />
                          </td>
                          <td className="sm-mono">{String(s.submitted_date_display ?? s.submitted_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {activeSection === "licenses" ? (
            <section aria-labelledby="licenses-heading">
              <div className="sm-page-header">
                <h1 id="licenses-heading" className="sm-page-title">
                  Licenses & Activations
                </h1>
              </div>
              {licenses.length === 0 ? (
                <EmptyState title="No licenses issued yet" />
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th>License #</th>
                        <th>Key Hint</th>
                        <th>Product</th>
                        <th>Customer</th>
                        <th>Status</th>
                        <th className="sm-tabular">Activations</th>
                        <th>Expires (DD/MM/YYYY)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {licenses.map((l) => (
                        <tr key={String(l.id)}>
                          <td className="sm-mono">{String(l.license_number)}</td>
                          <td className="sm-mono">{String(l.license_key_hint)}</td>
                          <td>{String(l.product_name ?? l.product_code)}</td>
                          <td>{String(l.customer_name ?? l.customer_id)}</td>
                          <td>
                            <StatusBadge status={String(l.status)} />
                          </td>
                          <td className="sm-tabular">
                            {Number(l.active_activations_count ?? 0)} / {Number(l.activation_limit)}
                          </td>
                          <td className="sm-mono">{String(l.expires_date_display)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {activeSection === "audit_logs" ? (
            <section aria-labelledby="audit-heading">
              <div className="sm-page-header">
                <h1 id="audit-heading" className="sm-page-title">
                  Security & Administrative Audit Log
                </h1>
              </div>
              {auditLogs.length === 0 ? (
                <EmptyState title="No audit events recorded" />
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th>Timestamp (DD/MM/YYYY)</th>
                        <th>Action</th>
                        <th>Resource</th>
                        <th>Actor</th>
                        <th>Outcome</th>
                        <th>Request ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((a) => (
                        <tr key={String(a.id)}>
                          <td className="sm-mono">{String(a.created_date_display ?? a.created_at)}</td>
                          <td className="sm-mono">{String(a.action)}</td>
                          <td className="sm-mono">
                            {String(a.resource_type)}:{String(a.resource_id).slice(0, 12)}
                          </td>
                          <td className="sm-mono">{String(a.actor_type)}</td>
                          <td>
                            <StatusBadge status={String(a.outcome)} />
                          </td>
                          <td className="sm-mono">{String(a.request_id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
