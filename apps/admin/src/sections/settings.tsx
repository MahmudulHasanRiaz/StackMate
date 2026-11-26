/**
 * Settings — dedicated area (owner decision 2026-11-15).
 *
 * ALL configuration-type things live ONLY here, never in the main
 * menu (owner decision 2026-11-16 ~00:00 +06 — the restructure
 * batch). Each category is a real section with a backend: Websites &
 * Credentials, Webhooks, Tracking pixel-groups config, Payment
 * Methods. Categories are grouped in the Settings sub-menu and
 * permission-filtered (a category without its permission is hidden,
 * like the main nav). The old placeholder slots are gone — every
 * category below renders real content.
 *
 * Routes (router.tsx): each category is an explicit route under
 * /settings (e.g. /settings/websites) with its own detail routes;
 * the settings index redirects to the first category.
 */
import { BarChart3, BookOpen, CreditCard, Globe, HardDrive, KeyRound, Mail, Settings2, ShieldCheck, Webhook, type LucideIcon } from "lucide-react";

export interface SettingsCategory {
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Full route for the category (under /settings). */
  to: string;
  /** Sub-menu group heading in the Settings nav. */
  group: string;
  /** Staff permission that gates the category (hidden without it). */
  permission?: string;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    slug: "general",
    label: "General",
    icon: Settings2,
    to: "/settings/general",
    group: "General",
    permission: "users.manage",
  },
  {
    // SMTP timeout fix batch (2026-11-16, owner order): email delivery
    // is not authentication — SMTP gets its own Settings menu item.
    // Same `users.manage` gate as Authentication (the SMTP endpoints
    // require it); API paths unchanged.
    slug: "email",
    label: "Email",
    icon: Mail,
    to: "/settings/email",
    group: "General",
    permission: "users.manage",
  },
  {
    // Media library batch (PLAN §31 / ADR-0011): the storage driver
    // (R2 vs Local) is Settings config, never main-menu. Same
    // `users.manage` gate as General/Email — the endpoints require it.
    slug: "storage",
    label: "Storage",
    icon: HardDrive,
    to: "/settings/storage",
    group: "General",
    permission: "users.manage",
  },
  {
    slug: "websites",
    label: "Websites & Credentials",
    icon: Globe,
    to: "/settings/websites",
    group: "Integrations",
    permission: "integrations.manage",
  },
  {
    slug: "tracking",
    label: "Tracking / Meta CAPI",
    icon: BarChart3,
    to: "/settings/tracking",
    group: "Integrations",
    permission: "tracking.manage",
  },
  {
    slug: "webhooks",
    label: "Webhooks",
    icon: Webhook,
    to: "/settings/webhooks",
    group: "Integrations",
    permission: "integrations.manage",
  },
  {
    slug: "payment-methods",
    label: "Payment Methods",
    icon: CreditCard,
    to: "/settings/payment-methods",
    group: "Commerce",
    permission: "payments.read",
  },
  {
    slug: "authentication",
    label: "Authentication",
    icon: ShieldCheck,
    to: "/settings/authentication",
    group: "Security",
    permission: "users.manage",
  },
  {
    // E-05: signing-key lifecycle (rotate/revoke) lives in Settings
    // with the other license material, not in the main menu.
    slug: "signing-keys",
    label: "Signing Keys",
    icon: KeyRound,
    to: "/settings/signing-keys",
    group: "Security",
    permission: "licenses.manage",
  },
  {
    // Customer+Order batch (ADR-0009): the receiver requirements for
    // products built on StackMate — license validation, entitlement
    // tokens, webhook receiver spec, renewal prompts. Documentation,
    // not configuration, but it lives in Settings with the other
    // integration material (owner decision: Integration Guide under
    // Settings). Gated on integrations.manage like the other
    // integration pages.
    slug: "integration-guide",
    label: "Integration Guide",
    icon: BookOpen,
    to: "/settings/integration-guide",
    group: "Documentation",
    permission: "integrations.manage",
  },
];
