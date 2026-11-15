# StackMate

StackMate is a centralized product, licensing, subscription, and commerce management platform for multiple software products, including premium WordPress plugins, hosted SaaS products, and dedicated customer deployments.

This repository contains the central admin application and API. External Astro landing pages and WordPress clients integrate through documented APIs and remain separate projects in the initial architecture.

## Project status

**Phase:** Foundation and repository preparation.  
**Application status:** Product specifications are established. Workspace scaffold and runtime compatibility proofs are the next work items.

Do not treat the project as production-ready until the implementation roadmap release gates pass.

## Architecture baseline

| Area | Technology |
|---|---|
| Admin | React + Vite + TypeScript |
| API | Hono + TypeScript on Cloudflare Workers |
| Database | PostgreSQL, initially Neon |
| ORM/migrations | Drizzle ORM |
| Authentication | Better Auth, after runtime verification |
| Object storage | Cloudflare R2 |
| External landing pages | Separate Astro projects |
| Architecture | Modular monolith |

PostgreSQL is the source of truth. Optional Cloudflare services are added only when a demonstrated requirement and accepted ADR justify them.

## Start here

1. Read docs/README.md.
2. Read AGENTS.md before using an AI coding agent.
3. Review docs/implementation/STATUS.md.
4. Follow docs/plan/Implementation Roadmap & Delivery Plan.md.

## Critical invariants

- Browser clients never determine authoritative prices or payment success.
- Manual payment submissions require staff verification.
- Payment, subscription, and license transitions are transactional, idempotent, and auditable.
- Public site keys are not privileged credentials.
- Server secrets and signing private keys never reach browser code.
- Published commercial and entitlement snapshots are immutable.
- API authorization is enforced server-side.

## Development

The runnable workspace is being established in Stage 0. Exact install, development, test, migration, and deployment commands will be documented after package scripts and runtime proofs exist. Do not infer commands before they are verified.

## Documentation policy

Accepted specifications live in docs/plan/. Technical decisions belong in docs/decisions/. Execution progress belongs in docs/implementation/. If documents conflict, identify the exact statements and resolve explicitly; do not silently change product behavior.
