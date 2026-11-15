/**
 * Admin shell (design spec §12 + owner decisions 2026-11-15).
 *
 * Two layouts, chosen by route — never both at once:
 *  - MainShell: operational nav (6 groups, 15 sections) + topbar.
 *    Sidebar is 248px; 900–1280px it collapses to a 64px icon rail;
 *    <900px it becomes an overlay drawer (hamburger + backdrop + Esc).
 *  - SettingsShell: the DEDICATED Settings area. The main operational
 *    menu is NOT rendered while inside Settings (it collapses/hides);
 *    Settings opens expanded with its own sub-menu (settings nav +
 *    wide content). Leaving Settings restores the main menu.
 *    Settings contents are placeholders — owner decision pending.
 *
 * Theme toggle: dark is the default (Neon), light the alternate;
 * persisted in localStorage key `sm-theme`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  BarChart3,
  ClipboardCheck,
  CreditCard,
  Globe,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Sun,
  Tags,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { queryClient } from "../lib/query";
import { applyTheme, resolveTheme, type Theme } from "../lib/theme";
import { Button, IconButton } from "./primitives";
import { SETTINGS_CATEGORIES } from "../sections/settings";

/* ------------------------------------------------------------------ */
/* Auth context — principal is fetched once by the root route           */
/* ------------------------------------------------------------------ */
export interface StaffPrincipalDto {
  user: { id: string; name: string; email: string; status: string };
  roles: string[];
  permissions: string[];
}

const AuthContext = createContext<{
  principal: StaffPrincipalDto;
  signOut: () => Promise<void>;
}>({
  principal: { user: { id: "", name: "", email: "", status: "" }, roles: [], permissions: [] },
  signOut: async () => undefined,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({
  principal,
  onSignedOut,
  children,
}: {
  principal: StaffPrincipalDto;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const signOut = async () => {
    try {
      await apiRequest("/api/auth/sign-out", { method: "POST" });
    } catch {
      /* best-effort: clear local state either way */
    }
    queryClient.clear();
    onSignedOut();
  };
  return (
    <AuthContext.Provider value={{ principal, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation model — the 15 operational sections (PRD §2.1)            */
/* ------------------------------------------------------------------ */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission?: string;
}

export const NAVIGATION_GROUPS: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<NavItem>;
}> = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    group: "Product",
    items: [
      { to: "/products", label: "Products", icon: Package, permission: "products.read" },
      { to: "/features", label: "Features", icon: ListChecks, permission: "products.read" },
      { to: "/packages", label: "Packages & Pricing", icon: Tags, permission: "products.read" },
    ],
  },
  {
    group: "Commerce",
    items: [
      { to: "/customers", label: "Customers", icon: Users, permission: "customers.read" },
      { to: "/orders", label: "Orders & Invoices", icon: ShoppingCart, permission: "orders.read" },
      { to: "/payment-methods", label: "Payment Methods", icon: CreditCard, permission: "payments.read" },
      { to: "/payment-review", label: "Payment Review", icon: ClipboardCheck, permission: "payments.read" },
    ],
  },
  {
    group: "Recurring & Access",
    items: [
      { to: "/subscriptions", label: "Subscriptions", icon: RefreshCw, permission: "subscriptions.read" },
      { to: "/licenses", label: "Licenses & Activations", icon: KeyRound, permission: "licenses.read" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { to: "/integrations", label: "Websites & Credentials", icon: Globe, permission: "integrations.manage" },
      { to: "/tracking", label: "Tracking / Meta CAPI", icon: BarChart3, permission: "tracking.manage" },
      { to: "/webhooks", label: "Webhooks & Outbox", icon: Webhook, permission: "integrations.manage" },
    ],
  },
  {
    group: "Administration",
    items: [
      { to: "/staff", label: "Staff & Roles", icon: ShieldCheck, permission: "users.manage" },
      { to: "/audit-logs", label: "Audit Log", icon: ScrollText, permission: "audit_logs.read" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Theme toggle                                                        */
/* ------------------------------------------------------------------ */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return (
    <IconButton
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      icon={theme === "dark" ? Sun : Moon}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    />
  );
}

function UserMenu() {
  const { principal, signOut } = useAuth();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, color: "var(--sm-text-muted)" }}>
        {principal.user.name}
        <span style={{ marginLeft: 6, color: "var(--sm-text-muted)" }}>
          ({principal.roles.join(", ")})
        </span>
      </span>
      <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MainShell — operational area                                        */
/* ------------------------------------------------------------------ */
export function MainShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { principal } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const can = (permission?: string) =>
    !permission || principal.permissions.includes(permission);

  return (
    <div className="sm-shell" data-sidebar={drawerOpen ? "open" : undefined}>
      <div
        className="sm-sidebar-backdrop"
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />
      <aside className="sm-sidebar" aria-label="Primary navigation">
        <div className="sm-sidebar-brand">
          <span className="sm-brand-mark">
            <Package size={20} strokeWidth={2} />
          </span>
          <span className="sm-brand-name">StackMate</span>
        </div>
        <nav style={{ flex: 1 }}>
          {NAVIGATION_GROUPS.map((group) => {
            const visible = group.items.filter((item) => can(item.permission));
            if (visible.length === 0) return null;
            return (
              <div key={group.group}>
                <div className="sm-nav-group-label">{group.group}</div>
                {visible.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="sm-nav-btn"
                    activeProps={{ "aria-current": "page" }}
                    title={item.label}
                  >
                    <item.icon size={16} strokeWidth={2} />
                    <span className="sm-nav-label">{item.label}</span>
                  </Link>
                ))}
              </div>
            );
          })}
          <div>
            <div className="sm-nav-group-label">System</div>
            <Link
              to="/settings"
              className="sm-nav-btn"
              activeProps={{ "aria-current": "page" }}
              title="Settings"
            >
              <SettingsIcon size={16} strokeWidth={2} />
              <span className="sm-nav-label">Settings</span>
            </Link>
          </div>
        </nav>
      </aside>

      <div className="sm-main">
        <header className="sm-topbar">
          <IconButton
            label="Open navigation menu"
            icon={drawerOpen ? X : Menu}
            className="sm-hamburger"
            onClick={() => setDrawerOpen((v) => !v)}
          />
          <div style={{ flex: 1 }} />
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="sm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SettingsShell — dedicated area; main menu is NOT rendered here       */
/* ------------------------------------------------------------------ */
export function SettingsShell() {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className="sm-settings-shell" data-settings-nav={navOpen ? "open" : undefined}>
      <aside className="sm-settings-nav" aria-label="Settings navigation">
        <div className="sm-sidebar-brand">
          <span className="sm-brand-mark">
            <SettingsIcon size={20} strokeWidth={2} />
          </span>
          <span className="sm-brand-name">Settings</span>
        </div>
        <nav style={{ flex: 1 }}>
          <div className="sm-nav-group-label">Categories</div>
          {SETTINGS_CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              to="/settings/$category"
              params={{ category: cat.slug }}
              className="sm-nav-btn"
              activeProps={{ "aria-current": "page" }}
              title={cat.label}
            >
              <cat.icon size={16} strokeWidth={2} />
              <span className="sm-nav-label">{cat.label}</span>
            </Link>
          ))}
        </nav>
        <div style={{ borderTop: "1px solid var(--sm-border)", paddingTop: 12 }}>
          <Link to="/" className="sm-nav-btn">
            <ArrowLeft size={16} strokeWidth={2} />
            <span className="sm-nav-label">Back to admin</span>
          </Link>
        </div>
      </aside>

      <div className="sm-main">
        <header className="sm-topbar">
          <IconButton
            label="Open settings menu"
            icon={navOpen ? X : Menu}
            className="sm-hamburger"
            onClick={() => setNavOpen((v) => !v)}
          />
          <span style={{ fontSize: 13, color: "var(--sm-text-muted)" }}>
            Settings — contents pending owner decision
          </span>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="sm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
