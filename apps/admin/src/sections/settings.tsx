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
import { BarChart3, CreditCard, Globe, Webhook, type LucideIcon } from "lucide-react";

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
];
