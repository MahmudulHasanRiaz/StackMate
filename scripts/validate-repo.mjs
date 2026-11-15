import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "docs/README.md",
  "docs/implementation/STATUS.md",
  "docs/decisions/ADR-0001-date-time-and-display-format.md",
  "docs/decisions/ADR-0002-ci-cd-and-database-migrations.md",
];

for (const file of requiredFiles) {
  await readFile(join(root, file), "utf8");
}

const manifests = [
  "package.json",
  "apps/admin/package.json",
  "apps/api/package.json",
  "packages/contracts/package.json",
];

for (const file of manifests) {
  const parsed = JSON.parse(await readFile(join(root, file), "utf8"));
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error(`Missing package name in ${file}`);
  }
}

const workflowDir = join(root, ".github", "workflows");
const workflowFiles = (await readdir(workflowDir)).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
if (workflowFiles.length === 0) {
  throw new Error("No GitHub Actions workflow files found.");
}

console.log("Repository structure and package manifests are valid.");
