/**
 * Shared date helpers for the admin SPA (PLAN §23).
 *
 * - API date-only values are ISO YYYY-MM-DD; user-facing dates are
 *   DD/MM/YYYY (repo AGENTS.md §7 — never Date.parse on ambiguous input).
 * - "Today" and presets are computed in Asia/Dhaka (the fixed product
 *   timezone), explicitly via Intl — never the browser's local zone.
 * - `ddmmyyyyToIso` / `isoToDdmmyyyy` moved here from sections/orders.tsx
 *   (same implementations, now shared with the dashboard filter).
 */

const DHAKA_TIME_ZONE = "Asia/Dhaka";

/** Strict DD/MM/YYYY → YYYY-MM-DD (null when invalid). Mirrors the
 *  server's strict date parser; never uses Date.parse. */
export function ddmmyyyyToIso(value: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** YYYY-MM-DD → DD/MM/YYYY for display in date inputs. */
export function isoToDdmmyyyy(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Today's calendar date in Asia/Dhaka as YYYY-MM-DD. */
export function dhakaTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DHAKA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Add (or subtract) whole days to a YYYY-MM-DD date. */
export function addDaysToIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** First day of the month containing the given YYYY-MM-DD date. */
export function firstDayOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export type DashboardPreset = "today" | "7d" | "30d" | "month" | "all";

export const DASHBOARD_PRESETS: Array<{ key: DashboardPreset; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
];

/** Inclusive [from, to] (YYYY-MM-DD) for a preset, or null for All time. */
export function presetRange(
  preset: DashboardPreset,
  now = new Date(),
): { from: string; to: string } | null {
  const today = dhakaTodayIso(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDaysToIsoDate(today, -6), to: today };
    case "30d":
      return { from: addDaysToIsoDate(today, -29), to: today };
    case "month":
      return { from: firstDayOfMonthIso(today), to: today };
    case "all":
      return null;
  }
}

/** "All time", or "DD/MM/YYYY – DD/MM/YYYY" (single date when from == to). */
export function formatRangeLabel(range: { from: string; to: string } | null): string {
  if (range === null) return "All time";
  if (range.from === range.to) return isoToDdmmyyyy(range.from);
  return `${isoToDdmmyyyy(range.from)} – ${isoToDdmmyyyy(range.to)}`;
}
