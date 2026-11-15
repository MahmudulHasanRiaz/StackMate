# Implementation Roadmap & Delivery Plan

**Version:** 1.0 | **Status:** Initial execution baseline | **Project:** StackMate

## 1. Delivery strategy

Build a modular monolith, not microservices. Establish the repository and runtime proofs first, then deliver vertical slices containing UI, API, persistence, authorization, audit, and tests. Do not build every screen first and connect them later.

The coding agent must create a detailed task plan from this roadmap and the repository documents before coding. It may refine task ordering but must preserve gates and dependencies.

## 2. Stage 0 — Repository foundation

Deliver: root README and agent instructions; pnpm workspace; TypeScript base config; admin/API/contracts skeleton; database schema/migration structure; environment template and gitignore; CI; documentation index and ADR template.

Exit criteria: clean install from lockfile; root workspace commands; typecheck/lint/test/build scripts pass; no secrets committed; app/package ownership is clear.

## 3. Stage 1 — Runtime and persistence proof

Verify:
1. Neon driver vs Cloudflare Hyperdrive, including transactions, performance, and cost/usage.
2. Better Auth + Drizzle + Worker runtime, sessions, cookies, trusted origins.
3. SPA/API topology, CORS, CSRF, and cookie behavior.
4. Drizzle migrations and rollback/recovery.
5. R2 private upload and authorized read.
6. Hono error handling, request IDs, and environment validation.

Exit criteria: ADRs with evidence; working Worker-to-PostgreSQL read/write/transaction proof; auth/session proof; private R2 proof; migrations reproducible on a clean database.

Do not add KV, Durable Objects, Queues, or Hyperdrive merely by default. Evaluate Hyperdrive as a Neon option; adopt only if evidence and cost justify it.

## 4. Stage 2 — Identity and admin shell

Deliver Better Auth, staff profiles/RBAC, secure Super Admin bootstrap, server-side authorization, admin shell/navigation, responsive design tokens/primitives, audit foundation, session revocation.

Exit: permission matrix including negative tests; direct API access denied without permission; accessible responsive navigation; staff/role changes audited.

## 5. Stage 3 — Product catalogue and entitlements

Deliver products/integration profiles, product-specific feature catalogue, typed boolean/limit/quota/metered definitions, dependency/conflict validation, package draft/publish/version lifecycle, price/billing intervals, custom entitlement grants.

Exit: published versions immutable; typed values validated; existing order/license snapshots unchanged by catalogue edits; product-specific integration behavior enforced.

## 6. Stage 4 — Customers and commerce

Deliver customer directory, server-side quote/price resolution, order creation and immutable snapshots, invoices, admin-created orders, idempotent checkout.

Exit: browser cannot override price/total; order totals reconcile; retries do not create duplicate orders; currency precision/rounding documented.

## 7. Stage 5 — Manual payments

Deliver payment providers/methods, MFS and bank configuration, checkout panel, payment submissions, private proof uploads, review queue, atomic approval/rejection, duplicate-risk signals, audit and outbox.

Exit: submission never marks paid; only authorized staff can approve/reject; concurrent approval cannot double-settle; duplicate detection is review-oriented; evidence access is private.

## 8. Stage 6 — Subscriptions and licensing

Deliver subscription periods, manual renewal invoices, license issue/suspend/revoke/renew/transfer, activation/deactivation/validation, product-specific policy, signed entitlement documents, signing-key lifecycle.

Exit: manual payments do not imply automatic debit; activation limits are race-safe; snapshots are immutable/versioned; private signing key never reaches clients; grace/offline policy explicit.

## 9. Stage 7 — External website integration

Deliver site/domain registration, public key/server credential lifecycle, domain verification if required, signed request middleware, public catalogue/checkout APIs, integration docs/examples/test harness, webhook setup/signing.

Exit: public key cannot perform privileged actions; invalid/stale/replayed signatures rejected; server-authoritative checkout; webhook URL validation and outbound signatures tested.

## 10. Stage 8 — Tracking, notifications, and delivery

Deliver per-site tracking config, event validation and consent policy, browser/server dedup, Meta CAPI delivery/diagnostics, transactional outbox dispatcher, email adapter/templates, webhook retries/history/manual replay.

Exit: Purchase derives from verified paid order; Meta tokens never reach browser; side-effect failure does not roll back business transaction; retry/dedup tested; PII retention/log redaction verified.

## 11. Stage 9 — Production hardening

Deliver threat review/security tests, representative load tests, query/index and connection review, backup/restore drill, signing-key recovery/rotation exercise, monitoring/alerts/runbooks, dependency scanning, deployment/rollback procedure.

Exit: security gates pass; performance claims cite repeatable tests; recovery procedures exercised; no unresolved critical/high release blocker.

## 12. Cross-cutting requirements

Each vertical slice includes applicable schema/migration, domain/application logic, API contract/validation, authorization, audit, UI states/accessibility, tests, documentation, observability, and safe error handling.

## 13. Definition of Ready

User outcome and acceptance criteria are clear; relevant specification sections identified; dependencies/open decisions recorded; data ownership and permissions understood; test strategy stated.

## 14. Definition of Done

Acceptance criteria pass; formatting/lint/typecheck/tests/build pass; migrations reproducible; server-side authorization enforced; sensitive actions audited; loading/empty/error/success states implemented; no secrets/PII leak in logs; docs/ADRs updated; known limitations reported.

## 15. AI agent execution protocol

1. Read AGENTS.md and all foundation docs.
2. Inspect repository tree, git status, branch, remotes, and existing conventions.
3. Write docs/implementation/PLAN.md with tasks, dependencies, paths, tests, risks, and acceptance criteria.
4. Identify conflicts; do not silently choose. Product ambiguity requires clarification; technical ambiguity requires investigation and ADR.
5. Complete required technical spikes with evidence.
6. Implement one vertical slice at a time.
7. Run tests after each slice and full checks before completion.
8. Review diff for secrets, missing authorization, unsafe defaults, unbounded queries, and scope creep.
9. Commit focused changes. Push only to the intended branch after verifying remote and branch.
10. Report implementation, test evidence, migrations, deployment notes, open decisions, and next tasks.

Never rewrite accepted product behavior to simplify implementation. Material changes require a proposal and approval.

## 16. Status tracking

Maintain docs/implementation/STATUS.md with current stage/slice, completed items and commit refs, blockers/decisions, test/build evidence, and next three priorities. A stage is not complete merely because files exist; its exit criteria must pass.

---

**End of Implementation Roadmap — Version 1.0**
