/**
 * Stale-chunk recovery (live bug 2026-11-22).
 *
 * After a deploy the Worker serves new content-hashed chunks, so a tab
 * loaded before the deploy that navigates to a lazy section requests
 * the old hash and the dynamic import fails ("Failed to fetch
 * dynamically imported module"). That rejection lands in TanStack
 * Router's default error screen — the owner saw it on Staff & Roles
 * (staff-C8Xt0tD9.js) and reports the error screen "quite often, for
 * various reasons". A reload fetches the fresh index.html and the
 * section loads, so on the first such failure we reload once instead
 * of showing the error. A timestamp guard keeps a genuinely broken
 * deploy from reload-looping: a second failure within 60s shows the
 * error screen instead. The window is time-based (not a permanent
 * flag) so a later deploy gets its own one-time reload.
 */

const CHUNK_RELOAD_KEY = "sm-chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 60_000;

/** True when the error is a failed dynamic import (Vite or webpack wording). */
export function isChunkLoadError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk \d+ failed|importing a module script failed|failed to fetch/i.test(
    message,
  );
}

/**
 * If `err` looks like a stale-chunk load failure and this tab has not
 * already reloaded once for one in the last minute, reload the page
 * and return true. Returns false when no reload was triggered (not a
 * chunk error, no window/sessionStorage, or a reload already happened
 * recently) — the caller must let the error propagate.
 */
export function maybeReloadForStaleChunk(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false;
  try {
    const g = globalThis as unknown as {
      window?: { location: { reload: () => void } };
      sessionStorage?: Storage;
    };
    if (!g.window || !g.sessionStorage) return false;
    const last = Number(g.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    g.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    g.window.location.reload();
    return true;
  } catch {
    return false;
  }
}
