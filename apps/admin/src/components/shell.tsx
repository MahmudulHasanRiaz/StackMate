/**
 * Admin shell (design spec §12 + owner decisions 2026-11-15).
 *
 * Two layouts, chosen by route — never both at once:
 *  - MainShell: operational nav (5 groups, 14 sections) + topbar.
 *    Sidebar is 248px; the "Collapse menu" button at the sidebar
 *    bottom toggles it to a 64px icon rail (persisted in localStorage
 *    `sm-nav-collapsed`); 900–1280px it is a rail regardless;
 *    <900px it becomes an overlay drawer (hamburger + backdrop + Esc).
 *  - SettingsShell: the DEDICATED Settings area. The main operational
 *    menu stays visible as a COLLAPSED icon rail (64px) beside the
 *    EXPANDED Settings nav (240px) — collapse ≠ hide (owner
 *    correction 2026-11-15). The same collapse toggle + persisted
 *    state work here as in MainShell; entering Settings defaults the
 *    main rail to collapsed. <900px the main rail is hidden and the
 *    settings nav is the drawer. Settings holds ALL configuration
 *    (Websites, Webhooks, Tracking pixel-groups, Payment Methods) in
 *    real categories — the main menu carries no config items
 *    (restructure batch, owner decision 2026-11-16).
 *
 * Topbar (both shells): ⌘K global search (server-side entity search +
 * quick navigation to pages) + ONE account button (avatar photo or
 * initials + name + chevron) opening the account menu. The theme choice
 * (System / Dark / Light) lives ONLY in the account menu — there is no
 * standalone topbar toggle. Theme choice persists in localStorage key
 * `sm-theme` (default dark); "system" follows prefers-color-scheme live.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useGeneralConfig } from "../lib/general-config";
import type {
  GlobalSearchGroup,
  GlobalSearchResponse,
} from "../../../../packages/contracts/src/index.ts";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ClipboardCheck,
  Images,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  Package,
  Receipt,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  SunMoon,
  Tags,
  TrendingUp,
  Undo2,
  User,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { ApiClientError, apiRequest } from "../lib/api-client";
import { queryClient } from "../lib/query";
import { humanizeType } from "../lib/resolve-names";
import { applyTheme, resolveThemeChoice, type ThemeChoice } from "../lib/theme";
import { TwoFactorDisable, TwoFactorSetup } from "./two-factor-setup";
import { MediaPicker } from "./media-picker";
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  MenuDivider,
  MenuHeader,
  MenuItem,
  MenuSectionLabel,
  MenuSub,
  StatusBadge,
  useToast,
} from "./primitives";
import { SETTINGS_CATEGORIES } from "../sections/settings";

/* ------------------------------------------------------------------ */
/* Auth context — principal is fetched once by the root route           */
/* ------------------------------------------------------------------ */
export interface StaffPrincipalDto {
  user: {
    id: string;
    name: string;
    email: string;
    status: string;
    /** Custom avatar URL (users.avatar_url, audit M-23) — null when
     *  the user has none; Avatar falls back to Gravatar, then initials. */
    avatar_url?: string | null;
  };
  roles: string[];
  permissions: string[];
  two_factor_enabled: boolean;
  two_factor_setup_required: boolean;
}

const AuthContext = createContext<{
  principal: StaffPrincipalDto;
  signOut: () => Promise<void>;
}>({
  principal: {
    user: { id: "", name: "", email: "", status: "" },
    roles: [],
    permissions: [],
    two_factor_enabled: false,
    two_factor_setup_required: false,
  },
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
/* Navigation model — the 14 operational sections (PRD §2.1).           */
/* Configuration lives ONLY in Settings (restructure batch): the       */
/* Integrations group is gone — Websites / Webhooks / Tracking config  */
/* moved to /settings/*, Payment Methods to /settings/payment-methods; */
/* the Tracking events list and Outbox & Deliveries are audit/report   */
/* views, so they live under Administration.                            */
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
      { to: "/media", label: "Media Library", icon: Images, permission: "media.view" },
    ],
  },
  {
    group: "Commerce",
    items: [
      { to: "/customers", label: "Customers", icon: Users, permission: "customers.read" },
      { to: "/orders", label: "Orders & Invoices", icon: ShoppingCart, permission: "orders.read" },
      { to: "/payment-review", label: "Payment Review", icon: ClipboardCheck, permission: "payments.read" },
      { to: "/refunds", label: "Refunds", icon: Undo2, permission: "payments.read" },
      { to: "/leads", label: "Leads", icon: UserPlus, permission: "leads.view" },
    ],
  },
  {
    group: "Finance",
    items: [
      // Expense Module (2026-11-25): operational finance pages.
      // Expense categories are config, so they live in Settings
      // (/settings/expense-categories), not here.
      { to: "/expenses", label: "Expenses", icon: Receipt, permission: "expenses.read" },
      { to: "/analytics/profit-loss", label: "Profit & Loss", icon: TrendingUp, permission: "expenses.read" },
    ],
  },
  {
    group: "Support",
    items: [
      { to: "/tickets", label: "Support Tickets", icon: LifeBuoy, permission: "tickets.view" },
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
    group: "Administration",
    items: [
      { to: "/staff", label: "Staff & Roles", icon: ShieldCheck, permission: "users.manage" },
      { to: "/audit-logs", label: "Audit Log", icon: ScrollText, permission: "audit_logs.read" },
      { to: "/tracking-events", label: "Tracking Events", icon: BarChart3, permission: "tracking.manage" },
      { to: "/outbox", label: "Outbox & Deliveries", icon: Send, permission: "integrations.manage" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Nav collapse — one persisted state, shared by both shells.           */
/* `sm-nav-collapsed`: "true" | "false". MainShell defaults to         */
/* expanded; SettingsShell defaults to collapsed AND collapses the     */
/* main menu on entry (owner decision 2026-11-15: entering Settings    */
/* collapses the main menu; the toggle can expand it again within      */
/* Settings). Once the user toggles, the stored value wins in both     */
/* shells.                                                              */
/*                                                                      */
/* PIN SURVIVES SETTINGS (owner decision 2026-11-16): the entry         */
/* collapse is VISUAL ONLY — it must NOT overwrite the stored pin.     */
/* `setCollapsedVisual` changes state without touching localStorage,    */
/* so returning to Dashboard/MainShell reads the preserved value and    */
/* restores the pinned state. Only an explicit toggle persists.         */
/* ------------------------------------------------------------------ */
const NAV_COLLAPSED_KEY = "sm-nav-collapsed";

function useNavCollapsed(
  defaultCollapsed: boolean,
): [
  boolean,
  () => void,
  (next: boolean) => void,
  (next: boolean) => void,
] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(NAV_COLLAPSED_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
    } catch {
      /* storage unavailable — fall through to the default */
    }
    return defaultCollapsed;
  });
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "true" : "false");
    } catch {
      /* storage unavailable — the state still applies for this load */
    }
  }, []);
  // State-only collapse/expand: the visual state changes, the stored
  // pin is untouched (pin-survives-Settings, owner 2026-11-16).
  const setCollapsedVisual = useCallback((next: boolean) => {
    setCollapsedState(next);
  }, []);
  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "true" : "false");
      } catch {
        /* storage unavailable — the state still applies for this load */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle, setCollapsed, setCollapsedVisual];
}

/* ------------------------------------------------------------------ */
/* Sidebar expand/collapse icons — Neon's glyph (owner 2026-11-16,     */
/* images 104 + 4b75079f): a panel rect with a narrow left divider     */
/* strip and a FULL horizontal ARROW (shaft + head) — → to expand, ←   */
/* to collapse. Lucide has no exact panel+arrow icon (PanelLeftOpen /  */
/* PanelLeftClose are the same panel with a small CHEVRON ›/‹ instead  */
/* of an arrow — the difference the owner noticed), so these two tiny   */
/* local components match Lucide's construction exactly (24 viewBox,   */
/* fill none, stroke currentColor, round caps/joins, 16px rendered)    */
/* and are used ONLY on the nav collapse toggle.                       */
/* ------------------------------------------------------------------ */
function SidebarExpandIcon({
  size = 16,
  strokeWidth = 2,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="12" y1="12" x2="17" y2="12" />
      <polyline points="14,9 17,12 14,15" />
    </svg>
  );
}

function SidebarCollapseIcon({
  size = 16,
  strokeWidth = 2,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="12" y1="12" x2="17" y2="12" />
      <polyline points="15,9 12,12 15,15" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* MainNav — the operational nav, rendered as a full sidebar (MainShell) */
/* or as the icon rail beside the Settings nav (SettingsShell).          */
/* ------------------------------------------------------------------ */
function MainNav({
  collapsed,
  onToggleCollapse,
  className,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
}) {
  const { principal } = useAuth();
  // General Settings (Auth + Email batch): the brand shows the configured
  // App Name, falling back to StackMate before the config loads.
  const { data: generalConfig } = useGeneralConfig();
  const can = (permission?: string) =>
    !permission || principal.permissions.includes(permission);
  // Groups with no visible item are dropped; a 1px divider separates the
  // groups that remain (Neon sidebar pattern) and the System group.
  const visibleGroups = NAVIGATION_GROUPS.map((group) => ({
    group: group.group,
    items: group.items.filter((item) => can(item.permission)),
  })).filter((group) => group.items.length > 0);

  // Peek suppression (live bug 2026-11-16, follow-up fix; CORRECTED in
  // fix batch #2): the hover/focus-within peek is CSS-only, so after
  // clicking "Collapse menu" the pointer is still over the toggle AND
  // the button keeps focus — both :hover and :focus-within keep
  // matching and the nav stays expanded even though the pinned state
  // is collapsed (only a fresh navigation cleared it). While
  // suppressed, the `sm-peek-off` class gates the peek selectors in
  // tokens.css. Focus is deliberately NOT moved: the button keeps
  // focus and the rail still returns at once.
  //
  // RE-ARM RULES — the first fix cleared suppression on mouse-leave,
  // which DEFEATED it live: moving the mouse to the main content
  // fired mouse-leave, cleared the flag, and :focus-within (focus
  // still on the toggle) re-opened the nav. Suppression now survives
  // mouse-leave and clears ONLY on a FRESH intent to use the nav:
  //   - the pointer ENTERS the aside from outside (mouse-enter), or
  //   - keyboard focus moves to a DIFFERENT element inside the nav
  //     (focus-in on a non-toggle element), or
  //   - focus leaves the nav entirely (blur), or
  //   - the toggle is clicked again (pin).
  // Deliberate wart: moving the pointer WITHIN the aside (toggle →
  // nav icon) without ever leaving does not re-arm the peek — any
  // within-aside re-arm re-introduces the live bug, because a diagonal
  // move toward the main content crosses the nav's box on its way out
  // (pointer-path analysis, 2026-11-16). Moving the mouse out and
  // back in — the normal re-hover — peeks as expected.
  const [peekSuppressed, setPeekSuppressed] = useState(false);
  const handleToggleCollapse = () => {
    // Unpinning (expanded → collapsed) suppresses the peek; pinning
    // (collapsed → expanded) clears any suppression.
    setPeekSuppressed(!collapsed);
    onToggleCollapse();
  };

  return (
    <aside
      className={`${className ?? "sm-sidebar"}${peekSuppressed ? " sm-peek-off" : ""}`}
      aria-label="Primary navigation"
      onMouseEnter={(e) => {
        // Genuine entry ONLY: the collapse itself shifts the layout
        // under a stationary pointer (the toggle's icon recenters as
        // the rail shrinks), which fires a second mouse-enter with a
        // relatedTarget INSIDE the nav — that is not fresh intent and
        // must not clear the suppression (it re-introduced the live
        // bug the first time this handler was written without the
        // guard). A real re-entry comes from outside the aside.
        // relatedTarget is NOT always an element: null when the
        // pointer enters from outside the document, and the WINDOW
        // object when it enters from outside the window — and
        // contains(window) throws ("Failed to execute 'contains' on
        // 'Node'", caught by the responsive audit 2026-11-18).
        // A non-Node relatedTarget is treated as NOT fresh intent:
        // it also fires for the layout shift / reload artifacts, and
        // clearing suppression on it re-opens the peek right after
        // an unpin click (focus stays on the toggle, so :focus-within
        // holds it open) — the sidebar-hover audit caught that
        // regression 36/41. The old code's throw accidentally
        // preserved the suppression; the guard below preserves it
        // WITHOUT throwing. Genuine re-entry still re-arms: moving
        // in from the main content gives a Node relatedTarget
        // outside the aside.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
          setPeekSuppressed(false);
        }
      }}
      onFocus={(e) => {
        // Keyboard re-arm: focus moving to a nav link (or any other
        // element inside the nav) is fresh intent — the focus-within
        // peek must work again. Focus landing back on the toggle
        // itself does NOT re-arm: that is the stale focus left by the
        // unpin click.
        const t = e.target as HTMLElement | null;
        if (t && !t.closest?.(".sm-nav-collapse-btn")) {
          setPeekSuppressed(false);
        }
      }}
      onBlur={(e) => {
        // Same guard as onMouseEnter: only a Node relatedTarget
        // outside the aside is a blur-out that re-arms. A non-Node
        // relatedTarget (null, or the window when focus leaves the
        // document) is a no-op — never passed to contains().
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
          setPeekSuppressed(false);
        }
      }}
    >
      <div className="sm-sidebar-brand">
        <span className="sm-brand-mark">
          <Package size={20} strokeWidth={2} />
        </span>
        <span className="sm-brand-name">{generalConfig?.app_name ?? "StackMate"}</span>
      </div>
      <nav className="sm-flex-1">
        {visibleGroups.map((group, i) => (
          <div key={group.group}>
            {i > 0 ? <div className="sm-nav-divider" aria-hidden="true" /> : null}
            <div className="sm-nav-group-label">{group.group}</div>
            {group.items.map((item) => (
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
        ))}
        <div>
          <div className="sm-nav-divider" aria-hidden="true" />
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
      <button
        type="button"
        className="sm-nav-collapse-btn"
        onClick={handleToggleCollapse}
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        title={collapsed ? "Expand menu" : "Collapse menu"}
      >
        {collapsed ? (
          <SidebarExpandIcon size={16} strokeWidth={2} />
        ) : (
          <SidebarCollapseIcon size={16} strokeWidth={2} />
        )}
        <span className="sm-nav-label">
          {collapsed ? "Expand menu" : "Collapse menu"}
        </span>
      </button>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Global search — ⌘K (PLAN §29, ADR-0010).                            */
/* A REAL search bar, not only quick navigation: typing ≥2 characters  */
/* queries GET /api/v1/admin/search (debounced 250ms) — each group is  */
/* searched server-side over the full table (≤8 per group, never a     */
/* filter over a loaded page). Entity results render first, grouped;   */
/* quick navigation to pages stays as the "Pages" group below them.    */
/* Keyboard: arrows move through the flat result list, Enter opens     */
/* the active result, Esc closes.                                      */
/* Audit L-03: each entity group maps to its list route — the "See     */
/* all in X →" link under each group opens that list with ?q=          */
/* prefilled (all nine routes validate q via parseListSearch).         */
/* ------------------------------------------------------------------ */
const GROUP_LIST_ROUTES: Record<string, string> = {
  customers: "/customers",
  orders: "/orders",
  products: "/products",
  licenses: "/licenses",
  subscriptions: "/subscriptions",
  tickets: "/tickets",
  leads: "/leads",
  staff: "/staff",
  sites: "/settings/websites",
};
interface QuickNavItem {
  to: string;
  label: string;
  group: string;
  icon: LucideIcon;
}

function QuickNav() {
  const { principal } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchGroups, setSearchGroups] = useState<GlobalSearchGroup[]>([]);

  const can = (permission?: string) =>
    !permission || principal.permissions.includes(permission);

  const items = useMemo<QuickNavItem[]>(() => {
    const list: QuickNavItem[] = [];
    for (const group of NAVIGATION_GROUPS) {
      for (const item of group.items) {
        if (can(item.permission)) {
          list.push({ to: item.to, label: item.label, group: group.group, icon: item.icon });
        }
      }
    }
    // Settings categories (restructure batch): the moved config pages
    // are searchable here too, grouped under "Settings".
    for (const cat of SETTINGS_CATEGORIES) {
      if (can(cat.permission)) {
        list.push({ to: cat.to, label: cat.label, group: "Settings", icon: cat.icon });
      }
    }
    list.push({ to: "/settings", label: "Settings", group: "System", icon: SettingsIcon });
    list.push({ to: "/products", label: "Create product", group: "Actions", icon: Package });
    list.push({ to: "/payment-review", label: "Record payment", group: "Actions", icon: ClipboardCheck });
    list.push({ to: "/staff", label: "Invite staff member", group: "Actions", icon: ShieldCheck });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal.permissions]);

  const pageResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Server-side entity search (debounced 250ms, aborted on retype).
  // Queries under 2 characters return nothing — no full-table dump.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setSearchGroups([]);
      setSearching(false);
      setSearchError(false);
      return;
    }
    setSearching(true);
    setSearchError(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiRequest<GlobalSearchResponse>(
        `/api/v1/admin/search?q=${encodeURIComponent(q)}`,
        { signal: controller.signal },
      )
        .then((res) => {
          setSearchGroups(res.groups);
          setSearching(false);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setSearchGroups([]);
          setSearching(false);
          setSearchError(true);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Flat keyboard order: entity results (group order) first, then pages.
  // A group's "See all" entry follows its items, so arrows/Enter track
  // the rendered order exactly (audit L-03).
  const flat = useMemo(() => {
    const list: { to: string; key: string; search?: { q: string } }[] = [];
    const q = query.trim();
    for (const group of searchGroups) {
      for (const item of group.items) {
        list.push({ to: item.to, key: `entity:${group.key}:${item.id}` });
      }
      const listRoute = GROUP_LIST_ROUTES[group.key];
      if (listRoute && group.items.length > 0) {
        list.push({ to: listRoute, key: `seeall:${group.key}`, search: { q } });
      }
    }
    for (const item of pageResults) {
      list.push({ to: item.to, key: `page:${item.to}:${item.label}` });
    }
    return list;
  }, [searchGroups, pageResults, query]);

  const go = (to: string, search?: { q: string }) => {
    setOpen(false);
    setQuery("");
    setSearchGroups([]);
    // `to` is a runtime string (the item list is built dynamically);
    // the codebase's established pattern for this is a `never` cast
    // (see tracking.tsx useRouteNavigate).
    void navigate({ to, ...(search ? { search } : {}) } as never);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const item = flat[active];
      if (item) go(item.to, item.search);
    }
  };

  // Index into the flat list while rendering, so arrows/Enter track the
  // grouped buttons exactly.
  let flatIndex = -1;
  const nextIndex = () => {
    flatIndex += 1;
    return flatIndex;
  };

  return (
    <>
      <button
        type="button"
        className="sm-quicknav-btn"
        aria-label="Search (Ctrl+K)"
        title="Search (Ctrl+K)"
        onClick={() => setOpen(true)}
      >
        <Search size={16} strokeWidth={2} />
        <span className="sm-quicknav-label">Search…</span>
        <kbd className="sm-kbd">⌘K</kbd>
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery("");
          setSearchGroups([]);
        }}
        title="Search"
      >
        <div className="sm-stack-sm">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onListKeyDown}
            placeholder="Search customers, orders, products…"
            aria-label="Search everything"
          />
          {searching ? <p className="sm-hint">Searching…</p> : null}
          {searchError ? (
            <p className="sm-hint">Search failed — try again.</p>
          ) : null}
          {flat.length === 0 && !searching && query.trim().length >= 2 ? (
            <p className="sm-hint">No results for “{query.trim()}”.</p>
          ) : (
            <div className="sm-quicknav-list" role="listbox" aria-label="Search results">
              {searchGroups.map((group) => (
                <div key={group.key}>
                  <div className="sm-quicknav-heading">{group.label}</div>
                  {group.items.map((item) => {
                    const i = nextIndex();
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-active={i === active || undefined}
                        className="sm-quicknav-item"
                        onClick={() => go(item.to)}
                        onMouseEnter={() => setActive(i)}
                      >
                        {item.type === "staff" ? (
                          <span className="sm-quicknav-person">
                            <Avatar name={item.label} email={item.sublabel} />
                            <span className="sm-quicknav-person-main">
                              <span className="sm-quicknav-person-name">
                                {item.label}
                              </span>
                              {item.sublabel ? (
                                <span className="sm-quicknav-person-sub">
                                  {item.sublabel}
                                </span>
                              ) : null}
                            </span>
                            {item.badge ? (
                              <span className="sm-quicknav-person-role">
                                {item.badge}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <>
                            {item.label}
                            {item.sublabel ? (
                              <span className="sm-quicknav-group">
                                {item.sublabel}
                              </span>
                            ) : null}
                          </>
                        )}
                      </button>
                    );
                  })}
                  {/* Audit L-03: the group is capped at 8 with no way
                      to see the rest — this link opens the section
                      list with the same query prefilled. It takes the
                      next flat index so keyboard navigation tracks
                      the rendered order. */}
                  {group.items.length > 0
                    ? (() => {
                        const i = nextIndex();
                        const listRoute = GROUP_LIST_ROUTES[group.key];
                        return listRoute ? (
                          <button
                            key={`seeall:${group.key}`}
                            type="button"
                            role="option"
                            aria-selected={i === active}
                            data-active={i === active || undefined}
                            className="sm-quicknav-item"
                            onClick={() => go(listRoute, { q: query.trim() })}
                            onMouseEnter={() => setActive(i)}
                          >
                            See all in {group.label} →
                          </button>
                        ) : null;
                      })()
                    : null}
                </div>
              ))}
              {pageResults.length > 0 ? (
                <div>
                  <div className="sm-quicknav-heading">Pages</div>
                  {pageResults.map((item) => {
                    const i = nextIndex();
                    return (
                      <button
                        key={`${item.to}:${item.label}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-active={i === active || undefined}
                        className="sm-quicknav-item"
                        onClick={() => go(item.to)}
                        onMouseEnter={() => setActive(i)}
                      >
                        <item.icon size={16} strokeWidth={2} />
                        {item.label}
                        <span className="sm-quicknav-group">{item.group}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Account menu — ONE button (avatar + name + chevron) → dropdown.      */
/* Theme (System / Dark / Light) lives here only. Profile updates the  */
/* user's own NAME (PATCH /api/v1/admin/me); email is read-only (the   */
/* login identity — administrator change only) and roles are           */
/* read-only. Change password uses POST /api/auth/change-password and  */
/* revokes the user's other sessions.                                   */
/* ------------------------------------------------------------------ */
/**
 * M-23: users.avatar_url stores an object KEY (an `avatars/` key or a
 * media-library key), never a URL. The principal's avatar is served
 * at GET /api/v1/admin/me/avatar; the key rides as a cache-buster so
 * a changed avatar is never served stale from the 1h private cache.
 */
function ownAvatarSrc(key: string | null | undefined): string | null {
  return key ? `/api/v1/admin/me/avatar?k=${encodeURIComponent(key)}` : null;
}

function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { principal } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(principal.user.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // Two-factor setup/disable opens as a second dialog from here.
  const [twoFactorMode, setTwoFactorMode] = useState<"none" | "setup" | "disable">("none");
  // Avatar (audit M-23): the media picker opens as a sibling dialog.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);

  // Avatar updates PATCH immediately (separate from the Name save):
  // the picker hands back a media asset; its content URL is sent and
  // the API resolves it to the stored object key (image-only).
  // Remove clears it back to Gravatar/initials. Rendering goes
  // through GET /me/avatar (see ownAvatarSrc) — avatar_url itself
  // is a key, never a URL.
  const setAvatar = async (url: string | null) => {
    setAvatarSaving(true);
    setError(null);
    try {
      await apiRequest<StaffPrincipalDto>("/api/v1/admin/me", {
        method: "PATCH",
        body: JSON.stringify({ avatar_url: url }),
      });
      await queryClient.invalidateQueries({ queryKey: ["admin", "me"] });
      toast({
        title: url ? "Avatar updated" : "Avatar removed",
        message: url
          ? "Your new photo is showing."
          : "Showing your Gravatar photo or initials instead.",
      });
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not update your avatar.",
      );
    } finally {
      setAvatarSaving(false);
    }
  };

  useEffect(() => {
    if (open) {
      setName(principal.user.name);
      setError(null);
      setFieldError(undefined);
    }
  }, [open, principal.user.name]);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      setFieldError("Name must be between 1 and 120 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await apiRequest<StaffPrincipalDto>("/api/v1/admin/me", {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      // Refresh the principal the shell shows: RootComponent reloads it
      // from the ["admin", "me"] query when invalidated.
      await queryClient.invalidateQueries({ queryKey: ["admin", "me"] });
      toast({ title: "Profile updated", message: `Name changed to ${updated.user.name}.` });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not update your profile.",
      );
    } finally {
      setSaving(false);
    }
  };

  const refreshPrincipal = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "me"] });
    setTwoFactorMode("none");
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={onClose}
      title="Profile"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="sm-stack">
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {/* Audit M-23: the avatar control — pick from the media
            library (or upload new from the same place) or remove the
            custom photo. The media-picker pattern is used everywhere
            an upload exists (ADR-0011). */}
        <Field
          label="Avatar"
          hint="Your photo — shown in the account menu and search results. Without one, your Gravatar photo shows, or your initials."
        >
          <div className="sm-inline-row">
            <Avatar
              name={principal.user.name}
              email={principal.user.email}
              avatarUrl={ownAvatarSrc(principal.user.avatar_url)}
              size="lg"
            />
            <Button
              variant="secondary"
              loading={avatarSaving}
              onClick={() => setPickerOpen(true)}
            >
              Choose from library
            </Button>
            {principal.user.avatar_url ? (
              <Button
                variant="ghost"
                disabled={avatarSaving}
                onClick={() => void setAvatar(null)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </Field>
        <Field label="Name" required error={fieldError} htmlFor="profile-name">
          <Input
            id="profile-name"
            value={name}
            autoComplete="name"
            aria-invalid={fieldError ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setFieldError(undefined);
            }}
          />
        </Field>
        <Field
          label="Email"
          htmlFor="profile-email"
          hint="Contact an admin to change your email — it is your login identity."
        >
          <Input id="profile-email" value={principal.user.email} disabled />
        </Field>
        <Field
          label="Roles"
          htmlFor="profile-roles"
          hint="Roles are set by an administrator."
        >
          <Input id="profile-roles" value={principal.roles.map((r) => humanizeType(r)).join(", ")} disabled />
        </Field>
        <Field
          label="Two-factor authentication"
          hint={
            principal.two_factor_enabled
              ? "On — sign-in asks for a code from your authenticator app."
              : "Off — sign-in needs only your password."
          }
        >
          <div className="sm-inline-row">
            <StatusBadge status={principal.two_factor_enabled ? "enabled" : "disabled"} />
            {principal.two_factor_enabled ? (
              <Button variant="secondary" onClick={() => setTwoFactorMode("disable")}>
                Turn off
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setTwoFactorMode("setup")}>
                Set up
              </Button>
            )}
          </div>
        </Field>
      </div>
    </Dialog>
    <Dialog
      open={twoFactorMode !== "none"}
      onClose={() => setTwoFactorMode("none")}
      title={
        twoFactorMode === "disable"
          ? "Turn off two-factor authentication"
          : "Set up two-factor authentication"
      }
    >
      {twoFactorMode === "setup" ? (
        <TwoFactorSetup
          onDone={() => {
            toast({ title: "Two-factor authentication is on" });
            void refreshPrincipal();
          }}
          onCancel={() => setTwoFactorMode("none")}
        />
      ) : twoFactorMode === "disable" ? (
        <TwoFactorDisable
          onDone={() => {
            toast({ title: "Two-factor authentication is off" });
            void refreshPrincipal();
          }}
          onCancel={() => setTwoFactorMode("none")}
        />
      ) : null}
    </Dialog>
    <MediaPicker
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onSelect={(asset) => {
        setPickerOpen(false);
        void setAvatar(asset.content_url);
      }}
      kinds={["image"]}
      title="Choose avatar from media library"
    />
    </>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ next?: string; confirm?: string }>({});

  useEffect(() => {
    if (open) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
      setFieldErrors({});
    }
  }, [open]);

  const save = async () => {
    const errors: { next?: string; confirm?: string } = {};
    if (next.length < 10) {
      errors.next = "New password must be at least 10 characters.";
    }
    if (next !== confirm) {
      errors.confirm = "Passwords do not match.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await apiRequest("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      toast({
        title: "Password changed",
        message: "Your other sessions were signed out.",
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not change your password.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change password"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={saving} onClick={() => void save()}>
            Change password
          </Button>
        </>
      }
    >
      <div className="sm-stack">
        <div className="sm-hint">
          Changing your password signs out your other sessions. This session
          stays signed in.
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <Field label="Current password" required htmlFor="pw-current">
          <Input
            id="pw-current"
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field
          label="New password"
          required
          hint="At least 10 characters."
          error={fieldErrors.next}
          htmlFor="pw-new"
        >
          <Input
            id="pw-new"
            type="password"
            value={next}
            autoComplete="new-password"
            aria-invalid={fieldErrors.next ? true : undefined}
            onChange={(e) => {
              setNext(e.target.value);
              setFieldErrors({});
            }}
          />
        </Field>
        <Field
          label="Confirm new password"
          required
          error={fieldErrors.confirm}
          htmlFor="pw-confirm"
        >
          <Input
            id="pw-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            aria-invalid={fieldErrors.confirm ? true : undefined}
            onChange={(e) => {
              setConfirm(e.target.value);
              setFieldErrors({});
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}

const THEME_CHOICES: { key: ThemeChoice; label: string }[] = [
  { key: "system", label: "System" },
  { key: "dark", label: "Dark" },
  { key: "light", label: "Light" },
];

/* API status for the account menu (Neon "Status — All OK" pill, image-78).
   One GET /api/v1/health per session, cached at module level so both
   shells share it. Honest values only: "checking" until the fetch
   settles, then "ok" (HTTP 200) or "down" (anything else). */
let apiHealthPromise: Promise<boolean> | null = null;
function fetchApiHealth(): Promise<boolean> {
  if (!apiHealthPromise) {
    apiHealthPromise = apiRequest<unknown>("/api/v1/health")
      .then(() => true)
      .catch(() => false);
  }
  return apiHealthPromise;
}
type ApiStatus = "checking" | "ok" | "down";
function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>("checking");
  useEffect(() => {
    let alive = true;
    void fetchApiHealth().then((ok) => {
      if (alive) setStatus(ok ? "ok" : "down");
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/* The account menu (Neon image-78): avatar + name + chevron opens a
   square dark menu with sections — header (avatar, name, email, roles),
   "Manage" (Profile, Change password, Settings, Help, Theme submenu), a
   live API Status row (one GET /api/v1/health per session), then Sign
   out. */
function AccountMenu() {
  const { principal, signOut } = useAuth();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() =>
    resolveThemeChoice(),
  );
  const apiStatus = useApiStatus();

  const chooseTheme = (choice: ThemeChoice) => {
    setThemeChoice(choice);
    applyTheme(choice);
  };

  return (
    <>
      <Menu
        triggerLabel="Account menu"
        triggerClassName="sm-account-btn"
        trigger={
          <>
            <Avatar
              name={principal.user.name}
              email={principal.user.email}
              avatarUrl={ownAvatarSrc(principal.user.avatar_url)}
            />
            <span className="sm-account-name">{principal.user.name}</span>
            <ChevronDown size={14} strokeWidth={2} className="sm-account-chevron" />
          </>
        }
      >
        <MenuHeader>
          <Avatar
            name={principal.user.name}
            email={principal.user.email}
            avatarUrl={ownAvatarSrc(principal.user.avatar_url)}
            size="lg"
          />
          <div className="sm-menu-header-body">
            <div className="sm-menu-header-name">{principal.user.name}</div>
            <div className="sm-menu-header-sub">{principal.user.email}</div>
            <div className="sm-menu-header-roles">
              {principal.roles.map((r) => (
                <span key={r} className="sm-badge sm-badge-neutral">
                  {humanizeType(r)}
                </span>
              ))}
            </div>
          </div>
        </MenuHeader>
        <MenuDivider />
        <MenuSectionLabel>Manage</MenuSectionLabel>
        <MenuItem icon={User} onClick={() => setProfileOpen(true)}>
          Profile
        </MenuItem>
        <MenuItem icon={KeyRound} onClick={() => setPasswordOpen(true)}>
          Change password
        </MenuItem>
        <MenuItem icon={SettingsIcon} onClick={() => void navigate({ to: "/settings" })}>
          Settings
        </MenuItem>
        {/* Audit L-14 (decision D-7): the Help entry — a small Getting
            Started page built only from the existing flows, plus the
            in-app Integration Guide linked from it. */}
        <MenuItem icon={LifeBuoy} onClick={() => void navigate({ to: "/getting-started" } as never)}>
          Help
        </MenuItem>
        <MenuSub icon={SunMoon} label="Theme">
          {THEME_CHOICES.map((choice) => (
            <MenuItem
              key={choice.key}
              role="menuitemradio"
              checked={themeChoice === choice.key}
              onClick={() => chooseTheme(choice.key)}
            >
              {choice.label}
            </MenuItem>
          ))}
        </MenuSub>
        <div className="sm-menu-status-row" role="status">
          <span className="sm-menu-item-label">Status</span>
          {apiStatus === "ok" ? (
            <StatusBadge status="active" label="All OK" />
          ) : apiStatus === "down" ? (
            <StatusBadge status="failed" label="Unavailable" />
          ) : (
            <StatusBadge status="pending" label="Checking…" />
          )}
        </div>
        <MenuDivider />
        <MenuItem icon={LogOut} danger onClick={() => void signOut()}>
          Sign out
        </MenuItem>
      </Menu>
      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* MainShell — operational area                                        */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* TopbarBrand — centered brand in the mobile topbar (owner           */
/* 2026-11-18, Neon screenshots 111–113): the same mark + app name    */
/* as the sidebar brand. Hidden on desktop (the sidebar carries the   */
/* brand there); shown ≤900px between the two equal-width topbar       */
/* clusters, so it sits exactly centered.                              */
/* ------------------------------------------------------------------ */
function TopbarBrand() {
  const { data: generalConfig } = useGeneralConfig();
  return (
    <div className="sm-topbar-brand">
      <span className="sm-brand-mark">
        <Package size={20} strokeWidth={2} />
      </span>
      <span className="sm-brand-name">{generalConfig?.app_name ?? "StackMate"}</span>
    </div>
  );
}

export function MainShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navCollapsed, toggleNavCollapsed] = useNavCollapsed(false);
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

  return (
    <div
      className="sm-shell"
      data-sidebar={drawerOpen ? "open" : undefined}
      data-nav-collapsed={navCollapsed ? "true" : "false"}
    >
      <div
        className="sm-sidebar-backdrop"
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />
      <MainNav collapsed={navCollapsed} onToggleCollapse={toggleNavCollapsed} />

      <div className="sm-main">
        <header className="sm-topbar">
          <div className="sm-topbar-cluster sm-topbar-cluster-start">
            <IconButton
              label="Open navigation menu"
              icon={drawerOpen ? X : MenuIcon}
              className="sm-hamburger"
              onClick={() => setDrawerOpen((v) => !v)}
            />
            <div className="sm-topbar-spacer" />
          </div>
          <TopbarBrand />
          <div className="sm-topbar-cluster sm-topbar-cluster-end">
            <div className="sm-topbar-spacer" />
            <QuickNav />
            <AccountMenu />
          </div>
        </header>
        <main className="sm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SettingsShell — dedicated area; the main nav stays as a collapsed    */
/* icon rail beside the expanded Settings nav (collapse ≠ hide).        */
/* ------------------------------------------------------------------ */
export function SettingsShell() {
  const { principal } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, toggleNavCollapsed, , setNavCollapsedVisual] =
    useNavCollapsed(true);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Settings categories, permission-filtered like the main nav and
  // grouped by their `group` field (first-seen order).
  const categoryGroups = useMemo(() => {
    const can = (permission?: string) =>
      !permission || principal.permissions.includes(permission);
    const groups: Array<{
      group: string;
      items: typeof SETTINGS_CATEGORIES;
    }> = [];
    for (const cat of SETTINGS_CATEGORIES) {
      if (!can(cat.permission)) continue;
      const found = groups.find((g) => g.group === cat.group);
      if (found) found.items.push(cat);
      else groups.push({ group: cat.group, items: [cat] });
    }
    return groups;
  }, [principal.permissions]);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Escape closes the settings drawer (mirrors MainShell). Without
  // this + the backdrop below, the open drawer covered its own
  // hamburger (z 50 over the topbar) and had no touch way to close
  // — a trap on mobile (Chromium audit 2026-11-16).
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Entering Settings collapses the main menu (owner decision
  // 2026-11-15): the rail is collapsed on entry — never expanded.
  // The toggle can expand it again within Settings. Once per mount;
  // navigating between Settings categories does not re-collapse.
  // VISUAL ONLY (pin survives Settings, owner 2026-11-16): the stored
  // `sm-nav-collapsed` pin is NOT overwritten, so returning to the
  // Dashboard restores the pinned state from storage.
  useEffect(() => {
    setNavCollapsedVisual(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="sm-settings-shell"
      data-settings-nav={navOpen ? "open" : undefined}
      data-nav-collapsed={navCollapsed ? "true" : "false"}
    >
      <MainNav
        collapsed={navCollapsed}
        onToggleCollapse={toggleNavCollapsed}
        className="sm-sidebar sm-main-rail"
      />
      <div
        className="sm-sidebar-backdrop"
        aria-hidden="true"
        onClick={() => setNavOpen(false)}
      />
      <aside className="sm-settings-nav" aria-label="Settings navigation">
        <div className="sm-sidebar-brand">
          <span className="sm-brand-mark">
            <SettingsIcon size={20} strokeWidth={2} />
          </span>
          <span className="sm-brand-name">Settings</span>
        </div>
        <nav className="sm-flex-1">
          {categoryGroups.map((g, i) => (
            <div key={g.group}>
              {i > 0 ? <div className="sm-nav-divider" aria-hidden="true" /> : null}
              <div className="sm-nav-group-label">{g.group}</div>
              {g.items.map((cat) => (
                <Link
                  key={cat.slug}
                  to={cat.to}
                  className="sm-nav-btn"
                  activeProps={{ "aria-current": "page" }}
                  title={cat.label}
                >
                  <cat.icon size={16} strokeWidth={2} />
                  <span className="sm-nav-label">{cat.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sm-settings-back">
          <Link to="/" className="sm-nav-btn">
            <ArrowLeft size={16} strokeWidth={2} />
            <span className="sm-nav-label">Back to admin</span>
          </Link>
        </div>
      </aside>

      <div className="sm-main">
        <header className="sm-topbar">
          <div className="sm-topbar-cluster sm-topbar-cluster-start">
            <IconButton
              label="Open settings menu"
              icon={navOpen ? X : MenuIcon}
              className="sm-hamburger"
              onClick={() => setNavOpen((v) => !v)}
            />
            <div className="sm-topbar-spacer" />
          </div>
          <TopbarBrand />
          <div className="sm-topbar-cluster sm-topbar-cluster-end">
            <QuickNav />
            <AccountMenu />
          </div>
        </header>
        <main className="sm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
