/**
 * Staff session lifetime (E-22).
 *
 * The API's principal DTO carries no session-expiry field, so the SPA
 * records its own sign-in time (sessionStorage — gone when the tab
 * closes) and derives expiry as started + 12h. Sessions started
 * before this shipped (or via OAuth, which completes through a
 * redirect rather than the sign-in form) have no recorded start and
 * show the generic "Session lasts 12 hours" text instead of a time.
 */

export const SESSION_STARTED_KEY = "sm-session-started-at";

/** Staff sessions last 12 hours (Better Auth session config). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Record the start of a session (call on a successful sign-in). */
export function recordSessionStart(now = Date.now()): void {
  try {
    sessionStorage.setItem(SESSION_STARTED_KEY, String(now));
  } catch {
    // Private mode / blocked storage: the expiry label falls back to
    // the generic text instead of a time.
  }
}

/** Human expiry label for the account menu / profile, in Dhaka time. */
export function sessionExpiryLabel(now = Date.now()): string {
  let started = NaN;
  try {
    started = Number(sessionStorage.getItem(SESSION_STARTED_KEY) ?? "");
  } catch {
    started = NaN;
  }
  if (!Number.isFinite(started) || started <= 0) return "Session lasts 12 hours";
  const expiry = new Date(started + SESSION_TTL_MS);
  const text = expiry.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Dhaka",
  });
  return `Session expires ${text} (Dhaka)`;
}
