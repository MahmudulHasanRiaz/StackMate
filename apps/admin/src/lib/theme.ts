/**
 * Theme resolution (design spec §2.4 + Neon owner decision 2026-11-15).
 *
 * Stored key: `sm-theme` ("dark" | "light"). No stored value → dark
 * (Neon is dark-first; the screenshot is dark). The value is applied to
 * <html data-theme="..."> before React mounts (see index.html inline
 * script + main.tsx) so there is no flash of the wrong theme.
 */
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "sm-theme";

export function resolveTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the attribute still applies for this load */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = resolveTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
