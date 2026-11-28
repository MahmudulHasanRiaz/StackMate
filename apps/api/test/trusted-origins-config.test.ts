/**
 * Trusted-origins normalization unit tests (2FA origin fix batch #2).
 *
 * Pure config test — no database, no HTTP, no sleeps. Proves
 * `buildBetterAuthWorkerConfig` collapses every dashboard-value
 * variation to the bare origins Better Auth actually compares
 * against (see `normalizeTrustedOrigin` in better-auth.ts), and that
 * wildcard patterns survive normalization intact.
 *
 * The live bug it guards: a dashboard TRUSTED_ORIGINS entry copied
 * with a trailing slash or a path never matched the browser's bare
 * Origin header, because Better Auth 1.7.23 compares non-wildcard
 * patterns with exact string equality (verified in the installed
 * dist/auth/trusted-origins.mjs) and pushes options.trustedOrigins
 * RAW (dist/context/helpers.mjs).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildBetterAuthWorkerConfig } from "../src/modules/identity/better-auth.ts";
import { resolveRuntimeConfig } from "../src/env.ts";

const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";

function configFor(overrides: Record<string, unknown>) {
  // Overrides are applied AFTER resolveRuntimeConfig on purpose:
  // resolveRuntimeConfig's `??` chain would fill its localhost
  // defaults for an undefined value, so the "undefined API_URL"
  // shape can only be expressed by overriding the resolved object.
  const base = resolveRuntimeConfig({
    APP_ENV: "test",
    BETTER_AUTH_URL: "https://auth.example.com",
    TRUSTED_ORIGINS: "https://trusted.example.com",
    API_URL: "http://localhost:8787",
    APP_URL: "http://localhost:8787",
  });
  const env = { ...base, ...overrides } as Parameters<
    typeof buildBetterAuthWorkerConfig
  >[0];
  return buildBetterAuthWorkerConfig(env).trustedOrigins;
}

describe("buildBetterAuthWorkerConfig trustedOrigins normalization", () => {
  it("keeps a clean config as-is (TRUSTED_ORIGINS + BETTER_AUTH_URL + API/APP deduped)", () => {
    assert.deepEqual(configFor({}), [
      "https://trusted.example.com",
      "https://auth.example.com",
      "http://localhost:8787",
    ]);
  });

  it("strips a trailing slash from a TRUSTED_ORIGINS entry (the live failure)", () => {
    const origins = configFor({ TRUSTED_ORIGINS: `${STAGING_ORIGIN}/` });
    assert.ok(origins.includes(STAGING_ORIGIN), JSON.stringify(origins));
    assert.ok(!origins.includes(`${STAGING_ORIGIN}/`), JSON.stringify(origins));
  });

  it("strips a path, lower-cases the host, and drops a default port", () => {
    const origins = configFor({
      TRUSTED_ORIGINS: "HTTPS://StackMate-API-Staging.AD-DAWAH.workers.dev:443/some/path",
    });
    assert.ok(origins.includes(STAGING_ORIGIN), JSON.stringify(origins));
  });

  it("survives API_URL/APP_URL undefined (dashboard vars unset)", () => {
    const origins = configFor({
      TRUSTED_ORIGINS: `${STAGING_ORIGIN}/`,
      API_URL: undefined,
      APP_URL: undefined,
    });
    assert.deepEqual(origins, [STAGING_ORIGIN, "https://auth.example.com"]);
  });

  it("includes BETTER_AUTH_URL explicitly even when stale", () => {
    const origins = configFor({
      BETTER_AUTH_URL: "https://auth.example.com",
      TRUSTED_ORIGINS: "https://trusted.example.com",
    });
    assert.ok(origins.includes("https://auth.example.com"), JSON.stringify(origins));
  });

  it("normalizes BETTER_AUTH_URL itself (trailing slash) — the sole-covering-source shape", () => {
    const origins = configFor({
      BETTER_AUTH_URL: `${STAGING_ORIGIN}/`,
      TRUSTED_ORIGINS: "https://trusted.example.com",
      API_URL: "http://localhost:8787",
      APP_URL: "http://localhost:8787",
    });
    assert.ok(origins.includes(STAGING_ORIGIN), JSON.stringify(origins));
    assert.ok(!origins.includes(`${STAGING_ORIGIN}/`), JSON.stringify(origins));
  });

  it("preserves a wildcard TRUSTED_ORIGINS entry verbatim", () => {
    const origins = configFor({ TRUSTED_ORIGINS: "https://*.example.com" });
    assert.ok(origins.includes("https://*.example.com"), JSON.stringify(origins));
  });

  it("preserves a bare-host wildcard (new URL() would reject it)", () => {
    const origins = configFor({ TRUSTED_ORIGINS: "*.example.com" });
    assert.ok(origins.includes("*.example.com"), JSON.stringify(origins));
  });

  it("handles an empty TRUSTED_ORIGINS (deployment origins still trusted)", () => {
    const origins = configFor({ TRUSTED_ORIGINS: "" });
    assert.deepEqual(origins, ["https://auth.example.com", "http://localhost:8787"]);
  });

  it("trims spaces, drops empty entries, and dedupes after normalization", () => {
    const origins = configFor({
      TRUSTED_ORIGINS: " https://a.example.com , , https://b.example.com/ ",
      BETTER_AUTH_URL: "https://a.example.com/",
      API_URL: "https://b.example.com",
      APP_URL: "https://b.example.com",
    });
    assert.deepEqual(origins, ["https://a.example.com", "https://b.example.com"]);
  });
});
