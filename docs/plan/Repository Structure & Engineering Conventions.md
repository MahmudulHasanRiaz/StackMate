# Repository Structure & Engineering Conventions

**Version:** 1.1 | **Status:** Initial repository baseline | **Project:** StackMate

## 1. Current state

The repository contains product/architecture specifications and initial workspace placeholders. The tree below is the target, not a claim that all files already exist. Preserve existing document paths; do not rename or move foundation documents during scaffold work.

## 2. Target repository tree

~~~text
StackMate/
├── apps/
│   ├── admin/                         # React + Vite + TypeScript SPA
│   │   ├── public/
│   │   └── src/
│   │       ├── app/                   # Providers, router, app shell
│   │       ├── routes/
│   │       ├── layouts/
│   │       ├── features/
│   │       ├── components/
│   │       ├── hooks/
│   │       ├── lib/
│   │       ├── styles/
│   │       └── main.tsx
│   └── api/                           # Hono API on Cloudflare Workers
│       ├── src/
│       │   ├── index.ts
│       │   ├── app.ts
│       │   ├── env.ts
│       │   ├── middleware/
│       │   ├── routes/
│       │   ├── modules/
│       │   ├── platform/
│       │   └── shared/
│       └── wrangler.jsonc
├── packages/
│   └── contracts/
├── db/
│   ├── schema/
│   ├── migrations/
│   ├── seeds/
│   └── drizzle.config.ts
├── docs/
│   ├── plan/
│   ├── decisions/
│   ├── implementation/
│   ├── integration/
│   └── operations/
├── scripts/
├── .github/workflows/
├── .env.example
├── .gitignore
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
~~~

External Astro landing pages and WordPress plugins are separate projects that consume StackMate APIs/SDKs. They are not part of the initial admin/API workspace.

## 3. Module boundaries

A module may evolve to:

~~~text
modules/<module>/
├── domain/          # Business rules, entities, value objects, policies
├── application/     # Use cases, ports, DTOs
├── infrastructure/  # Repository and provider implementations
└── http/            # Request schemas and route adapters
~~~

Do not create empty layers just to satisfy a diagram. Small modules may start with fewer files.

Dependency direction:
- HTTP adapters call application use cases.
- Application depends on domain rules and declared ports.
- Infrastructure implements ports.
- Domain imports no Hono, React, Drizzle, Neon, or Cloudflare runtime modules.
- Frontend consumes API contracts, never database/ORM types.
- Cross-module interaction uses explicit application interfaces or domain/outbox events, not another module's repository internals.

## 4. Naming conventions

- Directories: kebab-case.
- TypeScript variables/functions: camelCase.
- Types/interfaces/classes and React components: PascalCase.
- Database tables/columns: snake_case.
- API paths: plural nouns, lowercase, versioned under /api/v1.
- Environment variables: UPPER_SNAKE_CASE.
- Feature keys: stable lowercase dotted or underscore identifiers; do not rename published keys without migration.
- Use explicit names; avoid ambiguous abbreviations.

## 5. Workspace and dependency currency rules

- Use pnpm workspaces.
- Keep the first workspace small: admin, API, contracts, database schema/migrations.
- Do not add Nx/Turborepo until measured workflow complexity justifies it.
- At the time of implementation, select the latest stable, generally available major/minor and latest security-fixed patch compatible with the whole stack. Verify against official release notes/docs/package registry; never choose an old version from memory or a stale tutorial.
- Do not use deprecated, end-of-life, prerelease, nightly, canary, or release-candidate dependencies in production unless explicitly approved.
- If the newest major is incompatible, document evidence and select the newest secure compatible stable release temporarily, with an ADR and upgrade condition.
- Pin exact dependency versions as appropriate and commit the lockfile for reproducible installs. Pinning does not excuse remaining on stale versions; keep dependencies updated.
- Verify security advisories and peer/runtime compatibility. Record verification date, source links, versions, and exceptions.
- For GitHub Actions, verify maintained releases and prefer full commit-SHA pins with release comments.
- See ADR-0004 and AGENTS.md.

## 6. Database ownership

PostgreSQL is authoritative. Drizzle schema and committed SQL migrations are the schema change record. Keep provider-specific behavior behind infrastructure adapters. Never import database schema types into the browser. Use explicit transaction boundaries for financial, entitlement, and license transitions; enforce integrity with database constraints.

## 7. Configuration and secrets

- .env.example contains names, descriptions, and safe placeholders only.
- Never commit real credentials, tokens, private keys, session secrets, customer exports, or payment proof.
- Validate required environment at startup.
- Separate local, test, staging, and production configuration.
- Cloudflare bindings are accessed through typed environment adapters.
- Never put secrets in Vite-prefixed browser variables.
- Do not assume local environment files exist in CI or deployment.

## 8. Testing organization

Use unit tests near modules or in a clear test directory; integration tests for database/provider adapters; contract tests for API schemas; end-to-end tests for critical workflows; security tests for authorization, idempotency, replay, and secret non-exposure. Use synthetic data only.

## 9. Documentation organization

- docs/plan/: accepted product and architecture specifications.
- docs/decisions/: ADRs.
- docs/implementation/: execution plan, status, milestones.
- docs/integration/: external site/client integration guides.
- docs/operations/: deploy, rollback, backup, restore, monitoring, incident runbooks.

Update docs when behavior, architecture, API, schema, or operational steps change.

## 10. Git and deployment rules

- Never force-push or rewrite shared history.
- Never discard user changes.
- Check branch, remote, status, diff, and tests before commit/push.
- Keep commits focused and reviewable.
- Do not commit generated build output, dependencies, local DBs, secrets, or temporary logs.
- The coding agent owns repository-side workflow/configuration implementation and verification. The product owner owns first-time Cloudflare account/resource setup, GitHub secrets/variables, production authorization, and triggering/approving the first live deployment. Never claim live deployment before a successful run and smoke check.

## 11. Stage 0 scaffold boundary

Stage 0 may create workspace config, minimal app entry points, placeholder module docs, and CI. It must not implement unverified auth/database assumptions, add production secrets, create speculative tables, add Cloudflare services by default, move existing foundation docs, or create fake integrations that look production-ready.

---

**End of Repository Structure & Engineering Conventions — Version 1.1**
