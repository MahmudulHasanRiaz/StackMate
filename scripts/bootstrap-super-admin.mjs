#!/usr/bin/env node
/**
 * Bootstrap the initial StackMate super admin via the running API's
 * POST /api/auth/bootstrap-super-admin endpoint.
 *
 * Requires a running API (API_URL, default http://localhost:8787) and:
 *   ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD (environment variables only —
 *   never pass the password as a CLI argument).
 * The endpoint itself refuses to create a second super admin once one
 * exists; this script reports the API's response and exits non-zero on
 * failure. It never writes credentials to disk.
 */
const apiUrl = (process.env.API_URL || "http://localhost:8787").replace(/\/+$/, "");
const name = process.env.ADMIN_NAME;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!name || !email || !password) {
  console.error(
    "ERROR: ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD environment variables are all required."
  );
  process.exit(1);
}

const res = await fetch(`${apiUrl}/api/auth/bootstrap-super-admin`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name, email, password }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Bootstrap failed (HTTP ${res.status}):`, JSON.stringify(body));
  process.exit(1);
}
console.log("Super admin bootstrapped:", JSON.stringify(body?.data ?? body));
