# UI/UX & Design System Specification

**Version:** 1.0 | **Status:** Foundation baseline | **Project:** StackMate

## 1. Design intent

StackMate is an operational admin product. The interface must make frequent, high-consequence tasks fast, predictable, and easy to verify. It should feel modern and polished without being decorative or crowded.

Priority order: correctness and clarity; task completion speed; information hierarchy; consistency and accessibility; visual refinement and purposeful motion.

## 2. Core principles

- Minimal, not empty: show what is needed for the current task; progressively reveal advanced options.
- Concise language: short labels, useful placeholders, contextual help. Avoid paragraphs below every field.
- Predictable patterns: consistent headers, filters, tables, forms, drawers, modals, and status semantics.
- Explicit consequences: destructive and financial actions show exactly what will change.
- Safe defaults: pending/unverified states are unmistakable.
- Fast navigation: keyboard support, search, useful URL-backed filters, and route-level code splitting.
- Accessible: semantic HTML, focus management, contrast, reduced motion, screen-reader labels.
- Responsive: desktop-first operational density, usable on tablet and mobile.

## 3. Information architecture

Group primary navigation:

**Overview:** Dashboard.

**Product:** Products; Features; Packages & Pricing; Releases/Integration Profiles when enabled.

**Commerce:** Customers; Orders; Invoices; Payment Methods; Payment Review.

**Recurring & Access:** Subscriptions; Licenses; Activations.

**Integrations:** Websites & Domains; Credentials; Webhooks; Tracking / Meta.

**Administration:** Staff & Roles; Audit Log; Settings.

Keep the sidebar compact and collapsible. Do not create a top-level item for every sub-feature. Frontend visibility is not authorization; API permissions remain authoritative.

## 4. Standard page patterns

### List pages
- Clear title and one primary action.
- Search, filters, and view controls in a consistent toolbar.
- Server-paginated table with count and predictable row actions.
- Loading skeleton, first-use empty, no-results, error/retry, and populated states.
- Bulk actions only where safe and useful.

### Detail pages
- Title, status, and context-specific actions.
- Key facts first; avoid a wall of statistic cards.
- Tabs/sections for complex records.
- Related records and activity timeline where useful.
- Mask sensitive credentials by default.

### Forms
- Group fields by user task, not database table.
- Progressive disclosure for conditional fields.
- Concise help; use tooltips/popovers for uncommon concepts.
- Preserve input after recoverable errors.
- Distinguish Save, Publish, Approve, Reject, Suspend, Revoke, and Delete.

## 5. Visual system and tokens

Define semantic tokens for background, surfaces, borders, text, muted text, primary, accent, success, warning, danger, info, focus; typography roles; a consistent 4px-based spacing rhythm; restrained radii and elevation; and short purposeful transitions.

Do not hardcode brand colors in this specification. Establish actual values in a token file after visual direction is approved. Semantic colors must remain accessible in shipped themes.

## 6. Component foundation

Choose one accessible component foundation and extend consistently; do not mix UI libraries without a concrete reason.

Shared primitives should include buttons, inputs, selects, comboboxes, checkboxes, radios, switches, form fields, validation messages, tooltips, popovers, dialogs, drawers, menus, command/search dialog, tables, pagination, filter chips, empty states, skeletons, status badges, alerts, toasts, confirmation dialogs, tabs, breadcrumbs, copy controls, and date/currency formatting helpers.

Avoid building a large bespoke component library before repeated patterns exist.

## 7. Tables and data density

- Server-side pagination, filtering, and sorting for large datasets.
- Stable row identity and URL-backed filters where useful.
- Right-align monetary/numeric values; use tabular numerals.
- Keep primary identifiers and statuses visible.
- Row actions must not depend on hover alone.
- Show selection count and confirmation for bulk actions.
- On mobile, prioritize columns or deliberately adapt to cards; do not squeeze every column into unreadable width.

## 8. High-risk workflow UX

### Product/features
Product type controls relevant fields. Feature keys remain stable once referenced by published entitlements. Clearly distinguish boolean, limit, quota, and metered values. Validate dependencies/conflicts before publish.

### Package builder
Separate feature composition from price/billing intervals. Use type-aware controls. Show a concise entitlement summary. Published versions are immutable; edits create a new version. Explain whether a change affects future sales or existing grants.

### Custom entitlement grant
Searchable feature catalogue, typed values, validity/expiry, clear summary, confirmation, and audit reason.

### Payment review
Show order amount, submitted amount, receiving account, sender details, reference, timestamp, evidence, and duplicate/mismatch signals together. Do not automatically label customer-provided details as verified. Approve/Reject are permission-gated. Approval confirms exact order and amount; rejection requires a reason.

### Customer checkout
Use a compact step-based panel: select method; view exact amount/reference and instructions; submit sender details/evidence; show pending verification. Show enabled methods only. Progressive disclosure for MFS vs bank. Copy controls for account, phone, amount, reference. Transaction ID and proof requirements follow configuration. Never call a submitted claim paid.

### Credentials and licenses
Mask secrets by default. Reveal only at controlled creation when necessary. Rotation/revocation are deliberate, audited actions. Never put server secrets in local storage or ordinary API list responses.

## 9. Feedback and async states

Every async screen/action defines loading, empty, no-results, error/retry, success, disabled, and in-progress states. Optimistic updates are limited to reversible low-risk actions. Never optimistically show payment approval, license issue, or subscription renewal before server confirmation.

## 10. Motion

Prefer CSS transitions or a lightweight approach. Motion communicates state or continuity, not decoration. Respect reduced-motion preferences. Avoid looping animations, large page transitions, and animation that delays interaction.

## 11. Accessibility and responsive behavior

Target WCAG 2.2 AA as the design/testing objective. Provide keyboard access, visible focus, semantic labels/errors, dialog focus trap/restoration, non-color status cues, adequate contrast, reduced motion, and accessible table semantics.

Desktop supports dense operational tables; tablet collapses navigation and reflows forms; mobile prioritizes essential information/actions and avoids accidental horizontal overflow. Test zoom and common viewport widths.

## 12. Frontend performance

- Lazy-load noncritical routes and heavy modules.
- Use TanStack Query for server state; avoid duplicating it in global stores.
- Use server pagination/filtering and fetch only fields required by list views.
- Use stable query keys and cancel stale requests when appropriate.
- Monitor bundle size; avoid expensive animations and unnecessary rerenders.

## 13. Terminology

Use Product, Feature, Package, Price, Entitlement; Customer, Order, Invoice; Payment Method, Payment Submission, Verified Payment; Subscription, Renewal; License, Activation; Integrated Site, Domain, Credential; Tracking Event, Delivery, Webhook.

A customer-submitted manual claim must not be labeled “Payment Successful”. Use Submitted, Pending Review, Verified, Rejected, or the defined state equivalent.

## 14. Design QA checklist

- One clear primary action and obvious hierarchy.
- Concise helper text.
- Loading, empty, error, success, and disabled states.
- Server-side permission enforcement.
- Confirmation and audit for dangerous actions.
- Keyboard completion and visible focus.
- Narrow-width and zoom support.
- Consistent number, date, currency, and status formatting.
- Reduced-motion support.
- Understandable errors without exposing internals.

---

**End of UI/UX & Design System Specification — Version 1.0**
