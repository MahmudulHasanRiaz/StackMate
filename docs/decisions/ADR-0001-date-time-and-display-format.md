# ADR-0001: Date, Time, and Display Format

- **Status:** Accepted
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering

## Context

StackMate serves users who expect day-first dates. Persisting or transporting locale-formatted strings would make sorting, filtering, integrations, and timezone handling ambiguous.

## Decision

1. User-facing calendar dates use **DD/MM/YYYY** (for example, `05/11/2026`).
2. Date-time values shown to users use an explicitly selected application timezone and a documented day-first format. The default business timezone is configurable; do not silently assume that every customer is in Bangladesh.
3. API date-only values use ISO 8601 `YYYY-MM-DD`.
4. API timestamps use ISO 8601 with an explicit timezone/UTC offset; persisted instants use PostgreSQL `timestamptz` and UTC semantics.
5. Never store `DD/MM/YYYY` display strings as database date values.
6. Date parsing at input boundaries must be explicit and strict. Do not rely on JavaScript's implementation-dependent parsing of strings such as `05/11/2026`.
7. Locale formatting belongs at the UI boundary and must be covered by tests for day/month ambiguity, leap days, invalid dates, timezone boundaries, and daylight-saving transitions where applicable.
8. Currency, timezone, and locale are separate settings. Date display preference does not determine currency or timezone.

## Consequences

- UI date pickers, tables, filters, exports, and receipts must display day-first dates.
- Database ordering and API contracts remain machine-safe and interoperable.
- Date-only business concepts (for example, an expiry date) must be distinguished from instants (for example, a payment verification timestamp).

## Validation

Add shared date-formatting/parsing utilities and tests before implementing date-heavy screens. Reject ambiguous free-form date input unless it is parsed using the explicitly selected `DD/MM/YYYY` format.
