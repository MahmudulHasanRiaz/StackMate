#!/usr/bin/env node
/**
 * StackMate REAL build.
 *
 * 1. Runs the real typecheck (scripts/typecheck.mjs — genuine tsc).
 * 2. Builds the admin SPA with its real script (`tsc --noEmit && vite build`).
 * 3. Validates the API Worker bundle with `wrangler deploy --dry-run`
 *    (bundles only; never deploys). If wrangler cannot run offline
 *    (e.g. it requires Cloudflare auth or real Hyperdrive binding IDs
 *    — wrangler.jsonc still carries REPLACE_WITH_* placeholders), the
 *    script falls back to a local esbuild bundle of the Worker entry
 *    and says so explicitly. It NEVER claims a deploy happened and
 *    NEVER exits 0 unless at least one real bundle validation passed.
 *    This REPLACES the former build-all.mjs, which only copied
 *    index.html/css into dist/ and called that a build.
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function run(command, options = {}) {
  console.log(`\n$ ${command}`);
  return spawnSync(command, { stdio: "inherit", shell: true, ...options });
}

let result = run("node scripts/typecheck.mjs");
if (result.status !== 0) {
  console.error("\nBuild FAILED at typecheck.");
  process.exit(result.status ?? 1);
}

result = run("pnpm --filter @stackmate/admin run build");
if (result.status !== 0) {
  console.error("\nBuild FAILED at admin (vite) build.");
  process.exit(result.status ?? 1);
}

const adminDist = path.join(ROOT, "apps/admin/dist/index.html");
if (!fs.existsSync(adminDist)) {
  console.error("\nBuild FAILED: apps/admin/dist/index.html was not produced by vite build.");
  process.exit(1);
}
console.log(`\nAdmin build output verified: ${adminDist} exists.`);

// API Worker bundle validation. `wrangler deploy --dry-run` bundles the
// Worker and validates wrangler.jsonc without uploading anything.
result = run("pnpm --filter @stackmate/api exec wrangler deploy --dry-run");
if (result.status === 0) {
  console.log("\nBuild completed: admin (vite) + API Worker bundle (wrangler --dry-run) verified.");
  process.exit(0);
}

console.error(
  "\nNOTE: `wrangler deploy --dry-run` did not succeed in this environment " +
    "(common causes: missing Cloudflare auth, or the REPLACE_WITH_* Hyperdrive " +
    "binding IDs in apps/api/wrangler.jsonc). Falling back to a local esbuild " +
    "bundle validation of the Worker entry point. This validates bundling only — " +
    "it is NOT a deploy and NOT a wrangler config validation."
);
const esbuildBin = path.join(ROOT, "node_modules/.pnpm");
let esbuildPath = null;
if (fs.existsSync(esbuildBin)) {
  for (const entry of fs.readdirSync(esbuildBin)) {
    const candidate = path.join(esbuildBin, entry, "node_modules/esbuild/bin/esbuild");
    if (entry.startsWith("esbuild@") && fs.existsSync(candidate)) {
      esbuildPath = candidate;
      break;
    }
  }
}
if (!esbuildPath) {
  const fallback = path.join(ROOT, "node_modules/.bin/esbuild");
  if (fs.existsSync(fallback)) esbuildPath = fallback;
}
if (!esbuildPath) {
  console.error(
    "\nBuild FAILED: wrangler --dry-run failed AND no local esbuild binary was found " +
      "to validate the Worker bundle. Fix wrangler auth/config or install esbuild."
  );
  process.exit(1);
}
result = run(
  `node "${esbuildPath}" apps/api/src/index.ts --bundle --format=esm --platform=browser --conditions=workerd --external:node:crypto --outfile=/dev/null --log-level=warning`,
  { cwd: ROOT }
);
if (result.status !== 0) {
  console.error("\nBuild FAILED: esbuild bundle validation of the API Worker entry failed.");
  process.exit(result.status ?? 1);
}
console.log(
  "\nBuild completed with a CAVEAT: admin (vite) verified; API Worker bundle validated " +
    "with local esbuild only (wrangler --dry-run did not succeed here — see above). " +
    "Run `pnpm --filter @stackmate/api exec wrangler deploy --dry-run` with Cloudflare " +
    "credentials and real Hyperdrive IDs for full wrangler validation. No deploy was performed."
);
