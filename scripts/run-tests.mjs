#!/usr/bin/env node
/**
 * StackMate REAL test runner.
 *
 * Runs the genuine test suite with vitest (`vitest run` from the repo
 * root, covering apps/api/test/**). Exits non-zero on any failure.
 * Tests that need a live Postgres (Drizzle-store integration tests)
 * skip cleanly when DATABASE_URL is unset — a skip is reported by
 * vitest, never presented as a pass.
 * This REPLACES the former run-tests.mjs, which only Babel-transpiled
 * files and ran `node --test` on a single transpiled file.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
  stdio: "inherit",
  shell: true,
});
if (result.status !== 0) {
  console.error("\nTests FAILED (vitest run exited non-zero).");
  process.exit(result.status ?? 1);
}
console.log("\nTests passed (vitest run).");
