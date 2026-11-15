/**
 * Settings — dedicated area (owner decision 2026-11-15).
 *
 * Structure only: the Settings shell + organized sub-menu exist and the
 * main operational menu collapses while inside Settings. The CONTENTS
 * are placeholders — the actual categories/options are a PENDING OWNER
 * DECISION. Do NOT fill these slots with invented settings; replace a
 * slot with a real category only when the owner defines it.
 */
import { CircleDashed, type LucideIcon } from "lucide-react";
import { Alert, StatusBadge } from "../components/primitives";
import { PageHeader } from "../lib/section-kit";

export interface SettingsCategory {
  slug: string;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { slug: "category-1", label: "Category 1", icon: CircleDashed },
  { slug: "category-2", label: "Category 2", icon: CircleDashed },
  { slug: "category-3", label: "Category 3", icon: CircleDashed },
];

export function SettingsCategoryPage({ category }: { category: string }) {
  const found = SETTINGS_CATEGORIES.find((c) => c.slug === category);
  const label = found?.label ?? category;
  return (
    <section aria-labelledby="settings-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings", href: "/settings" }, { label }]}
        title={label}
        subtitle="Settings area — dedicated, separate from operational pages"
      />
      <Alert variant="info">
        Settings contents — owner decision pending. This category is a
        placeholder slot; no settings have been defined for it yet.
      </Alert>
      <div className="sm-card">
        <div
          style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <h2 className="sm-card-title">{label}</h2>
          <StatusBadge status="pending" label="Pending owner decision" />
        </div>
        <p className="sm-hint" style={{ marginTop: 12 }}>
          When the owner defines this category, its options will live here —
          and only here. Operational pages never carry settings controls.
        </p>
      </div>
    </section>
  );
}
