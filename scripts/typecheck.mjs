#!/usr/bin/env node
/**
 * StackMate REAL TypeScript typecheck.
 *
 * Runs genuine `tsc --noEmit` in every workspace package that has a
 * "typecheck" script (packages/contracts, db, apps/api, apps/admin)
 * via `pnpm -r run typecheck`, and FAILS (non-zero exit) on any type
 * error. This REPLACES the former scripts/typecheck-and-transpile.mjs,
 * which only Babel-transpiled files and never typechecked anything.
 * Do not reintroduce a transpile-only check and call it a typecheck.
 */
import { execSync } from "node:child_process";

try {
  execSync("pnpm -r run typecheck", { stdio: "inherit" });
} catch {
  console.error("\nTypecheck FAILED: fix the tsc errors above. See apps/*/tsconfig.json.");
  process.exit(1);
}

console.log("Typecheck passed: real tsc --noEmit succeeded in all workspace packages.");
