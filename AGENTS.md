# StackMate — AI Agent Instructions

You are the senior software engineer responsible for implementing StackMate according to this repository's accepted specifications. Do not redesign the product independently.

## 1. Mandatory reading

Before planning or editing, read README.md, docs/README.md, every document in docs/plan/, docs/implementation/STATUS.md, docs/implementation/PLAN.md, and all relevant ADRs. Do not rely on summaries when source documents are available.

## 2. First action: inspect and plan

Inspect the current branch, git status, remotes, repository tree, package manager, existing code, CI, and dependency versions. Never assume a clean working tree.

Before coding, create/update docs/implementation/PLAN.md with staged tasks, dependencies, affected paths, test strategy, risks, and acceptance criteria. Update STATUS.md with the current stage and evidence.

If ambiguity changes product behavior, stop and ask the product owner. For technical ambiguity, investigate and propose an ADR. Do not silently resolve conflicts.

## 3. Source-of-truth hierarchy

PRD owns product intent and behavior. TAD owns architecture and boundaries. Database specification owns data model and invariants. API specification owns request/response contracts. Security specification owns threats and controls. UI/UX specification owns interaction and accessibility. Roadmap owns delivery stages and exit criteria. ADRs resolve accepted technical decisions.

Never override an accepted requirement merely to simplify implementation.

## 4. Non-negotiable architecture

- Admin: React + Vite + TypeScript SPA.
- API: Hono + TypeScript on Cloudflare Workers.
- Database: PostgreSQL, initially Neon; Drizzle ORM.
- Authentication: Better Auth, after Worker/Drizzle compatibility verification.
- Object storage: Cloudflare R2.
- External landing pages are separate Astro projects; WordPress clients are separate projects.
- Start as a modular monolith; do not introduce microservices.
- Keep domain logic independent of Hono, React, Drizzle, Neon, and Cloudflare runtime APIs.
- PostgreSQL is the source of truth for commercial, payment, subscription, and license state.
- Use pnpm workspaces; do not add Nx/Turborepo without demonstrated need.
- Cloudflare Hyperdrive IS required from day one per ADR-0005 (the accepted ADR
  that measures the need and records the driver/caching decision); do not add
  KV, Durable Objects, Queues, or other optional services without measured
  need and an accepted ADR.

## 5. Dependency and technology currency policy — mandatory

For every technology, framework, runtime, build tool, package, SDK, GitHub Action, and external integration introduced, updated, or selected:

1. At implementation time, research the **latest stable, generally available release** using the project's official release page, official documentation, package registry, or vendor-maintained repository. Do not rely on remembered versions, old tutorials, stale lockfiles, or search snippets alone.
2. Prefer the latest stable major and minor line, with the latest security-fixed patch release available on that line. Do not intentionally choose an old major/minor or an outdated patch merely because it is familiar.
3. Do not use alpha, beta, preview, canary, nightly, release-candidate, deprecated, or end-of-life releases in production dependencies unless the product owner explicitly approves the exception.
4. Verify compatibility across the full stack before selecting a release: supported Node/runtime versions, framework peer dependencies, Cloudflare Workers compatibility, database drivers, ORM, plugins, build tooling, and deployment environment.
5. If the newest stable major is incompatible or introduces an unresolved blocker, do not silently downgrade. Document the evidence, choose the newest secure compatible stable release as a temporary exception, record it in an ADR with an upgrade condition, and report it clearly.
6. Pin exact dependency versions in manifests where appropriate and commit the package-manager lockfile. Reproducible pinning is not permission to stay outdated: define and run a regular dependency-update process.
7. Check official security advisories and known vulnerabilities before adding/updating dependencies. Do not select a release with an unresolved relevant critical/high security advisory when a patched alternative exists.
8. Verify GitHub Actions and reusable workflows against their official maintained sources. Prefer immutable full commit-SHA pinning with a comment naming the verified release; update pins through reviewed dependency updates.
9. Record the verification date, source links, selected versions, compatibility notes, and exceptions in the implementation plan or an ADR when the choice is architecturally significant.
10. Before completion, re-check whether newer stable/security-patched versions have appeared during the implementation and report any intentionally deferred updates.

"Latest" means latest stable and secure at the time the agent performs the work, not latest prerelease and not simply the newest version number regardless of compatibility. Never invent a version number or claim it is current without checking an authoritative source.

## 6. Security and correctness

- Enforce authorization server-side; UI hiding is not security.
- Never trust browser prices, discounts, totals, payment success, roles, or entitlement values.
- Manual payment claims remain unverified until authorized staff verify actual receipt.
- Financial and license transitions must be transactional, concurrency-safe, idempotent, and audited.
- Public site keys never authorize privileged operations.
- Never expose server secrets, Meta tokens, session secrets, or signing private keys to browser code.
- Keep private R2 objects private and access-controlled.
- Validate webhook signatures and protect outbound destinations against SSRF.
- Use immutable snapshots for orders, package versions, and granted entitlements.
- Never log secrets or unnecessary personal data.
- Do not invent legal-compliance claims or performance guarantees.

## 7. Date and time policy

- User-facing dates must use DD/MM/YYYY.
- Date-only API values use ISO 8601 YYYY-MM-DD; instants use ISO 8601 with explicit timezone and are persisted with UTC semantics.
- Never store locale-formatted date strings in PostgreSQL.
- Never parse ambiguous date strings with native Date.parse; use a strict shared parser and tests.
- Keep date-only values distinct from timestamps. Format dates only at the presentation boundary.
- See ADR-0001.

## 8. Database migration policy

- A schema change and its reviewed, ordered Drizzle migration belong in the same pull request.
- Never use schema push/sync against staging or production.
- CI must verify migration consistency. The deployment workflow must apply pending migrations before deploying application code.
- A migration failure blocks application deployment. Do not bypass or manually mark a failed migration as applied.
- Use expand-and-contract migrations; do not combine breaking DDL with code that immediately requires the new shape.
- Do not automatically roll back production database migrations. Prefer a corrective forward migration; restore only under the incident procedure.
- Run exactly one controlled migration job; use a database lock/advisory lock where supported.
- Keep runtime DB credentials separate from migration credentials.
- See ADR-0002 and docs/operations/CI-CD-AND-MIGRATIONS.md.

## 9. CI/CD and deployment ownership

- During the initial foundation implementation, build and test the GitHub Actions workflows, migration-before-deploy sequence, health checks, and deployment documentation as part of the agent's work, after the runnable application base exists.
- The agent must prepare the repository-side Cloudflare deployment configuration and document the exact GitHub variables/secrets and setup steps. Never invent credentials or commit secrets.
- The product owner will perform the first Cloudflare account/resource setup, add GitHub Environment variables/secrets, authorize the deployment, and trigger/approve the first real deployment (or delegate those account-level actions to another agent).
- Do not claim that production deployment is live or enabled until the owner completes that setup and a real workflow run plus smoke check succeeds.
- Keep staging and production resources/credentials isolated. Protect production deployment with GitHub Environments and serialized releases.
- Never make a production deploy workflow appear complete merely because a YAML file exists.

## 10. Future digital-services marketplace compatibility

- Orders must not assume every purchase creates a license or subscription.
- Keep catalog, checkout/payment, and fulfillment boundaries separable.
- Support distinct fulfillment handlers for software entitlements and future digital-service jobs.
- Preserve provider/seller ownership as a future extension point, with server-side seller isolation.
- Do not implement provider onboarding, service listings, milestones, payouts, or dispute workflows until separately scoped and approved.
- See ADR-0003.

## 11. Engineering workflow

For each vertical slice:
1. State user outcome and acceptance criteria.
2. Identify relevant specification sections and ADRs.
3. Verify current stable and secure technology/dependency versions under Section 5.
4. Implement applicable schema/migration, domain/application logic, API, authorization, audit, UI, and tests.
5. Add unit, integration, contract, security, or end-to-end tests according to risk.
6. Run formatting, lint, typecheck, tests, and build.
7. Review the diff for secrets, missing authorization, unsafe defaults, unbounded queries, stale dependencies, and unrelated changes.
8. Update docs, ADRs, and implementation status.
9. Commit focused changes with descriptive messages.

Report actual command results. Do not claim tests, migrations, deployment, or push succeeded without confirmed output.

## 12. Git rules

Never force-push, rewrite shared history, or discard user changes. Check branch, remote, status, diff, and tests before commit/push. Push only to the intended repository and branch. If direct push was not explicitly requested, use a feature branch. Never commit secrets, customer data, local databases, build output, or dependency folders.

## 13. Code quality

Keep TypeScript strict. Validate untrusted inputs at boundaries. Use cohesive modules and narrow interfaces. Avoid premature abstractions and unnecessary dependencies. Handle errors deliberately. Use bounded pagination and avoid unbounded queries. Make time, currency, precision, and timezone behavior explicit. Persist timestamps in UTC and format at the UI boundary.

## 14. UI quality

Follow the UI/UX specification: minimal, modern, consistent, responsive, accessible. Avoid excessive helper paragraphs, decorative cards, noisy colors, and unnecessary charts. Implement loading/empty/error/success states. Use progressive disclosure. Never optimistically show payment approval or other consequential state before server confirmation. Respect reduced motion.

## 15. Technical spikes

Do not guess on Neon connectivity/transactions, Better Auth compatibility, SPA/API cookies/CORS/CSRF, signing-key lifecycle, R2 private access, or outbox delivery. Build small proofs, record evidence, and write ADRs. Do not block unrelated catalog/UI work unnecessarily.

## 16. Completion report

Report implemented behavior, changed files, exact dependency versions and authoritative verification sources, tests/build/typecheck/lint actually run, migrations and deployment impact, commit/push destination if applicable, open decisions/risks, and next recommended task.
