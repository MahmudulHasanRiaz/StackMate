# StackMate Documentation

Documentation is the product and engineering source of truth.

## Foundation specifications

1. Product Requirements Document (PRD)
2. Technical Architecture Document (TAD)
3. Database Design & Data Model Specification
4. API & Integration Specification
5. Security & Threat Model
6. UI/UX & Design System Specification
7. Implementation Roadmap & Delivery Plan
8. Repository Structure & Engineering Conventions

All eight documents are maintained in docs/plan/.

## Execution

- docs/implementation/STATUS.md tracks current stage, blockers, evidence, and priorities.
- docs/implementation/PLAN.md will contain the active implementation plan.
- docs/decisions/ stores Architecture Decision Records.
- docs/integration/ stores external client/site integration guides.
- docs/operations/ stores deployment and operations runbooks.

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
