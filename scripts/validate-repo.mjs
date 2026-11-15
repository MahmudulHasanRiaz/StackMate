import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "docs/README.md",
  "docs/implementation/STATUS.md",
  "docs/implementation/PLAN.md",
  "docs/decisions/ADR-0001-date-time-and-display-format.md",
  "docs/decisions/ADR-0002-ci-cd-and-database-migrations.md",
  "docs/decisions/ADR-0003-digital-services-marketplace-extensibility.md",
  "docs/decisions/ADR-0004-current-stable-dependency-policy.md",
  "docs/decisions/ADR-0005-cloudflare-hyperdrive-and-postgresql-driver.md",
  "docs/decisions/ADR-0006-authentication-rbac-and-cryptography.md",
  "docs/operations/CI-CD-AND-MIGRATIONS.md",
  "apps/api/wrangler.jsonc",
  "apps/api/src/index.ts",
  "apps/admin/index.html",
  "apps/admin/src/main.tsx",
  "packages/contracts/src/index.ts",
  "db/drizzle.config.ts",
  "db/schema/index.ts",
  "db/migrations/0000_stackmate_initial_schema.sql",
];

for (const file of requiredFiles) {
  const fullPath = join(root, file);
  const info = await stat(fullPath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Required file is missing or empty: ${file}`);
  }
}

const manifests = [
  "package.json",
  "apps/admin/package.json",
  "apps/api/package.json",
  "packages/contracts/package.json",
  "db/package.json",
];

for (const file of manifests) {
  const parsed = JSON.parse(await readFile(join(root, file), "utf8"));
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error(`Missing package name in ${file}`);
  }
}

const workflowDir = join(root, ".github", "workflows");
const workflowFiles = (await readdir(workflowDir)).filter(
  (file) => file.endsWith(".yml") || file.endsWith(".yaml")
);
if (workflowFiles.length === 0) {
  throw new Error("No GitHub Actions workflow files found.");
}

console.log("Repository structure, required specifications, ADRs, migrations, and package manifests are valid.");
