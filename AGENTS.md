# StackMate — AI Agent Instructions

You are an autonomous senior software engineer implementing StackMate according to this repository's accepted specifications. Do not redesign the product independently.

## 1. Mandatory reading

Before planning or editing, read README.md, docs/README.md, and every document in docs/plan/:
- Product Requirements Document (PRD).md
- Technical Architecture Document (TAD).md
- Database Design & Data Model Specification.md
- API & Integration Specification.md
- Security & Threat Model.md
- UI UX & Design System Specification.md
- Implementation Roadmap & Delivery Plan.md
- Repository Structure & Engineering Conventions.md

Then read docs/implementation/STATUS.md and relevant ADRs. Do not rely on summaries when source documents are available.

## 2. First action: inspect and plan

Inspect current branch, git status, remotes, repository tree, package manager, existing code, and CI. Never assume a clean working tree.

Compare the repository with the target structure. Identify existing conventions, dependency versions, missing files, and document conflicts.

Before coding, create/update docs/implementation/PLAN.md with staged tasks, dependencies, affected paths, test strategy, risks, and acceptance criteria. Update STATUS.md with current stage and evidence.

If ambiguity changes product behavior, stop and ask the product owner. For technical ambiguity, investigate and propose an ADR. Do not silently resolve conflicts.

## 3. Source-of-truth hierarchy

PRD: product intent and behavior. TAD: architecture and boundaries. Database specification: data model and invariants. API specification: request/response contracts. Security specification: threats and controls. UI/UX specification: interaction and accessibility. Roadmap: stages and exit criteria. ADR: accepted technical decision.

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
- Do not add KV, Durable Objects, Queues, Hyperdrive, or other optional services without measured need and an accepted ADR. Evaluate relevant connectivity options in the technical spikes.

## 5. Security and correctness

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

## 6. Engineering workflow

For each vertical slice:
1. State user outcome and acceptance criteria.
2. Identify relevant specification sections and ADRs.
3. Implement applicable schema/migration, domain/application logic, API, authorization, audit, UI, and tests.
4. Add unit, integration, contract, security, or end-to-end tests according to risk.
5. Run formatting, lint, typecheck, tests, and build.
6. Review diff for secrets, missing authorization, unsafe defaults, unbounded queries, and unrelated changes.
7. Update docs, ADRs, and implementation status.
8. Commit focused changes with descriptive messages.

Report actual command results. Do not claim tests, migrations, deployment, or push succeeded without confirmed output.

## 7. Git rules

Never force-push, rewrite shared history, or discard user changes. Check branch, remote, status, diff, and tests before commit/push. Push only to the intended repository and branch. If direct push was not explicitly requested, use a feature branch. Never commit secrets, customer data, local databases, build output, or dependency folders.

## 8. Code quality

Keep TypeScript strict. Validate untrusted inputs at boundaries. Use cohesive modules and narrow interfaces. Avoid premature abstractions and unnecessary dependencies. Handle errors deliberately. Use bounded pagination and avoid unbounded queries. Make time, currency, precision, and timezone behavior explicit. Persist timestamps in UTC and format at the UI boundary.

## 9. UI quality

Follow the UI/UX specification: minimal, modern, consistent, responsive, accessible. Avoid excessive helper paragraphs, decorative cards, noisy colors, and unnecessary charts. Implement loading/empty/error/success states. Use progressive disclosure. Never optimistically show payment approval or other consequential state before server confirmation. Respect reduced motion.

## 10. Technical spikes

Do not guess on Neon connectivity/transactions, Better Auth compatibility, SPA/API cookies/CORS/CSRF, signing-key lifecycle, R2 private access, or outbox delivery. Build small proofs, record evidence, and write ADRs. Do not block unrelated catalog/UI work unnecessarily.

## 11. Completion report

Report implemented behavior, changed files, tests/build/typecheck/lint actually run, migrations and deployment impact, commit/push destination if applicable, open decisions/risks, and next recommended task.


## 11. Date and time policy

- User-facing dates must use DD/MM/YYYY.
- Date-only API values use ISO 8601 YYYY-MM-DD; instants use ISO 8601 with explicit timezone and are persisted with UTC semantics.
- Never store locale-formatted date strings in PostgreSQL.
- Never parse ambiguous date strings with native Date.parse; use a strict shared parser and tests.
- Keep date-only values distinct from timestamps. Format dates only at the presentation boundary.
- See ADR-0001.

## 12. Release and migration policy

- A schema change and its reviewed, ordered Drizzle migration belong in the same pull request.
- Never use schema push/sync against staging or production.
- CI must verify migration consistency. Production deploy applies pending migrations before deploying application code.
- A migration failure blocks deployment. Do not bypass or manually mark a failed migration as applied.
- Use expand-and-contract migrations; do not combine breaking DDL with code that immediately requires the new shape.
- Do not automatically roll back production database migrations. Prefer a corrective forward migration; restore only under incident procedure.
- Run exactly one controlled migration job; use a database lock/advisory lock where supported.
- Keep runtime DB credentials separate from migration credentials.
- Production deploys are serialized. Staging and production secrets/resources must be isolated.
- See ADR-0002 and docs/operations/CI-CD-AND-MIGRATIONS.md.

## 13. Future digital-services marketplace compatibility

- Orders must not assume every purchase creates a license or subscription.
- Keep catalog, checkout/payment, and fulfillment boundaries separable.
- Support distinct fulfillment handlers for software entitlements and future digital-service jobs.
- Preserve provider/seller ownership as a future extension point, with server-side seller isolation.
- Do not implement provider onboarding, service listings, milestones, payouts, or dispute workflows until separately scoped and approved.
- See ADR-0003.

## 14. Completion report

Report implemented behavior, changed files, tests/build/typecheck/lint actually run, migrations and deployment impact, commit/push destination if applicable, open decisions/risks, and next recommended task.
