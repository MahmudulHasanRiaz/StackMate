# StackMate Documentation

Documentation is the product and engineering source of truth.

## Foundation specifications

1. [Product Requirements Document (PRD)](./plan/Product%20Requirements%20Document%20(PRD).md)
2. [Technical Architecture Document (TAD)](./plan/Technical%20Architecture%20Document%20(TAD).md)
3. [Database Design & Data Model Specification](./plan/Database%20Design%20%26%20Data%20Model%20Specification.md)
4. [API & Integration Specification](./plan/API%20%26%20Integration%20Specification.md)
5. [Security & Threat Model](./plan/Security%20%26%20Threat%20Model.md)
6. [UI/UX & Design System Specification](./plan/UI%20UX%20%26%20Design%20System%20Specification.md)
7. [Implementation Roadmap & Delivery Plan](./plan/Implementation%20Roadmap%20%26%20Delivery%20Plan.md)
8. [Repository Structure & Engineering Conventions](./plan/Repository%20Structure%20%26%20Engineering%20Conventions.md)

## Execution

- [Implementation plan](./implementation/PLAN.md)
- [AI agent handoff prompt](./implementation/AI-AGENT-START-PROMPT.md)
- [Implementation status](./implementation/STATUS.md)
- [Architecture Decision Records](./decisions/)
- [CI/CD and database migration runbook](./operations/CI-CD-AND-MIGRATIONS.md)
- [External integration guides](./integration/)
- [Operations runbooks](./operations/)

## Authority

- PRD owns product intent, scope, roles, and expected behavior.
- TAD owns runtime and architectural boundaries.
- Database specification owns the logical data model and invariants.
- API specification owns HTTP and integration contracts.
- Security specification owns threats and security release gates.
- UI/UX specification owns interaction and design standards.
- Roadmap owns delivery stages and exit criteria.
- ADRs resolve explicitly open technical choices.

If documents conflict, identify the exact statements and propose a resolution. Do not silently choose a behavior. Product behavior changes require product-owner approval.
