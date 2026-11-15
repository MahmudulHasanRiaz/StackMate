/**
 * Admin shell (design spec §12 + owner decisions 2026-11-15).
 *
 * Two layouts, chosen by route — never both at once:
 *  - MainShell: operational nav (6 groups, 15 sections) + topbar.
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
 *    settings nav is the drawer. Settings contents are placeholders —
 *    owner decision pending.
 *
 * Topbar (both shells): ⌘K QuickNav (client-side section/action
 * search) + ONE account button (avatar initials + name + chevron)
 * opening the account menu. The theme choice (System / Dark / Light)
 * lives ONLY in the account menu — there is no standalone topbar
 * toggle. Theme choice persists in localStorage key `sm-theme`
 * (default dark); "system" follows prefers-color-scheme live.
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
  CreditCard,
  Globe,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Tags,
  User,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { ApiClientError, apiRequest } from "../lib/api-client";
import { queryClient } from "../lib/query";
import { applyTheme, resolveThemeChoice, type ThemeChoice } from "../lib/theme";
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
  useToast,
} from "./primitives";
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
/* Nav collapse — one persisted state, shared by both shells.           */
/* `sm-nav-collapsed`: "true" | "false". MainShell defaults to         */
/* expanded; SettingsShell defaults to collapsed AND collapses the     */
/* main menu on entry (owner decision 2026-11-15: entering Settings    */
/* collapses the main menu; the toggle can expand it again within      */
/* Settings). Once the user toggles, the stored value wins in both     */
/* shells.                                                              */
/* ------------------------------------------------------------------ */
const NAV_COLLAPSED_KEY = "sm-nav-collapsed";

function useNavCollapsed(
  defaultCollapsed: boolean,
): [boolean, () => void, (next: boolean) => void] {
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
  return [collapsed, toggle, setCollapsed];
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
  const can = (permission?: string) =>
    !permission || principal.permissions.includes(permission);
  // Groups with no visible item are dropped; a 1px divider separates the
  // groups that remain (Neon sidebar pattern) and the System group.
  const visibleGroups = NAVIGATION_GROUPS.map((group) => ({
    group: group.group,
    items: group.items.filter((item) => can(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <aside className={className ?? "sm-sidebar"} aria-label="Primary navigation">
      <div className="sm-sidebar-brand">
        <span className="sm-brand-mark">
          <Package size={20} strokeWidth={2} />
        </span>
        <span className="sm-brand-name">StackMate</span>
      </div>
      <nav style={{ flex: 1 }}>
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
        onClick={onToggleCollapse}
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        title={collapsed ? "Expand menu" : "Collapse menu"}
      >
        {collapsed ? (
          <PanelLeftOpen size={16} strokeWidth={2} />
        ) : (
          <PanelLeftClose size={16} strokeWidth={2} />
        )}
        <span className="sm-nav-label">
          {collapsed ? "Expand menu" : "Collapse menu"}
        </span>
      </button>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* QuickNav — ⌘K client-side navigation (sections + common actions).    */
/* Navigation only: it never searches record data and never triggers    */
/* create dialogs — an action item navigates to the page where the      */
/* action lives.                                                         */
/* ------------------------------------------------------------------ */
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
    list.push({ to: "/settings", label: "Settings", group: "System", icon: SettingsIcon });
    list.push({ to: "/products", label: "Create product", group: "Actions", icon: Package });
    list.push({ to: "/payment-review", label: "Record payment", group: "Actions", icon: ClipboardCheck });
    list.push({ to: "/staff", label: "Invite staff member", group: "Actions", icon: ShieldCheck });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal.permissions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q),
    );
  }, [items, query]);

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

  const go = (to: string) => {
    setOpen(false);
    setQuery("");
    // `to` is a runtime string (the item list is built dynamically);
    // the codebase's established pattern for this is a `never` cast
    // (see tracking.tsx useRouteNavigate).
    void navigate({ to } as never);
  };

  return (
    <>
      <button
        type="button"
        className="sm-quicknav-btn"
        aria-label="Quick navigation (Ctrl+K)"
        title="Quick navigation (Ctrl+K)"
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
        }}
        title="Quick navigation"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                const item = filtered[active];
                if (item) go(item.to);
              }
            }}
            placeholder="Search sections and actions…"
            aria-label="Search sections and actions"
          />
          {filtered.length === 0 ? (
            <p className="sm-hint">No matching section or action.</p>
          ) : (
            <div className="sm-quicknav-list" role="listbox" aria-label="Sections and actions">
              {filtered.map((item, i) => (
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
              ))}
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
function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { principal } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(principal.user.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Profile"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error ? <Alert variant="danger">{error}</Alert> : null}
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
          <Input id="profile-roles" value={principal.roles.join(", ")} disabled />
        </Field>
      </div>
    </Dialog>
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
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Change password
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="sm-hint" style={{ margin: 0 }}>
          Changing your password signs out your other sessions. This session
          stays signed in.
        </p>
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

function AccountMenu() {
  const { principal, signOut } = useAuth();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() =>
    resolveThemeChoice(),
  );

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
            <Avatar name={principal.user.name} />
            <span className="sm-account-name">{principal.user.name}</span>
            <ChevronDown size={14} strokeWidth={2} className="sm-account-chevron" />
          </>
        }
      >
        <MenuHeader>
          <Avatar name={principal.user.name} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div className="sm-menu-header-name">{principal.user.name}</div>
            <div className="sm-menu-header-sub">{principal.user.email}</div>
            <div className="sm-menu-header-sub">{principal.roles.join(", ")}</div>
          </div>
        </MenuHeader>
        <MenuDivider />
        <MenuSectionLabel>Theme</MenuSectionLabel>
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
        <MenuDivider />
        <MenuItem icon={User} onClick={() => setProfileOpen(true)}>
          Profile
        </MenuItem>
        <MenuItem icon={KeyRound} onClick={() => setPasswordOpen(true)}>
          Change password
        </MenuItem>
        <MenuItem icon={SettingsIcon} onClick={() => void navigate({ to: "/settings" })}>
          Settings
        </MenuItem>
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
          <IconButton
            label="Open navigation menu"
            icon={drawerOpen ? X : MenuIcon}
            className="sm-hamburger"
            onClick={() => setDrawerOpen((v) => !v)}
          />
          <div style={{ flex: 1 }} />
          <QuickNav />
          <div style={{ flex: 1 }} />
          <AccountMenu />
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
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, toggleNavCollapsed, setNavCollapsed] = useNavCollapsed(true);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Entering Settings collapses the main menu (owner decision
  // 2026-11-15): the rail is collapsed on entry — never expanded.
  // The toggle can expand it again within Settings. Once per mount;
  // navigating between Settings categories does not re-collapse.
  useEffect(() => {
    setNavCollapsed(true);
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
            icon={navOpen ? X : MenuIcon}
            className="sm-hamburger"
            onClick={() => setNavOpen((v) => !v)}
          />
          <span style={{ fontSize: 13, color: "var(--sm-text-muted)" }}>
            Settings — contents pending owner decision
          </span>
          <div style={{ flex: 1 }} />
          <QuickNav />
          <AccountMenu />
        </header>
        <main className="sm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
