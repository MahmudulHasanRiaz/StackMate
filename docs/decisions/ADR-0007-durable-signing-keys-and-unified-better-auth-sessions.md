# ADR-0007: Durable License Signing Keys and Unified Better Auth Sessions

- **Status:** Accepted
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering
- **Related specifications:** ADR-0006 §2–§3; PRD §4, §13–§16; TAD §6, §8; Database Design §5, §15–§18; API Specification §2–§7; Security & Threat Model §4
- **Supersedes (in part):** the phase-1 gaps recorded in `docs/implementation/STATUS.md` ("signing-key private material is per-process", "staff sessions vs Better Auth sessions are NOT unified") and `docs/implementation/RECONCILIATION.md` §7. ADR-0006's decisions stand; this ADR records how they are now implemented and the Better Auth behaviours verified against the installed version (better-auth 1.7.23).

## Context

Phase 1 corrected three ZIP defects but left two seams open by design: license signing keys lived only in process memory (a Worker restart invalidated every issued token), and staff sessions ran on a parallel custom mechanism while Better Auth sessions lived in the Drizzle `sessions` table. Phase 2 closed both. The implementation surfaced four Better Auth behaviours that contradict the naive reading of its docs and must be recorded, because code written against the naive reading silently breaks sign-in, lazy migration, or password change.

## Decisions

### 1. Durable signing keys — PostgreSQL is the source of truth

- Table `signing_keys` (migration `0004_signing_keys.sql`): `id`, `key_id` (unique, `sm-ed25519-YYYY-MM`), `public_jwk` (jsonb, clear), `encrypted_private_jwk` (text, never plaintext), `status` (`active`/`retired`/`revoked`, CHECK), `created_at`, `activated_at`, `retired_at`, `supersedes_key_id` (self-FK), `rotation_reason`. Exactly one active row (partial unique index `uq_signing_keys_single_active`).
- Private JWKs are encrypted with the existing AES-256-GCM mechanism under `ENCRYPTION_KEY_V1`, AAD `v1:signing_key:<key_id>` (per-key, so a ciphertext copied to another row or purpose cannot decrypt). `signing_key_metadata` remains a public-only mirror, synced in the same transaction.
- Boot (`DrizzleStore.resolveSigningKey`, one advisory-locked transaction so concurrent boots converge on a single active row): load the active row plus every retired row; if no active row exists, import `LICENSE_SIGNING_PRIVATE_JWK` once (bootstrap-only, legacy path) or generate ONE key and persist it encrypted immediately. A per-process-only key is never used again.
- Verification is by the JWS header `kid` against all loaded non-revoked keys, so retired keys keep verifying and revoked keys stop verifying. Rotation retires the old key and inserts a new active key with `supersedes_key_id` + reason in one transaction; the active key can never be revoked (rotate first).
- Fail-closed: a missing `signing_keys` table, a missing/undecryptable `ENCRYPTION_KEY_V1`, or a corrupted ciphertext all throw at boot. Losing `ENCRYPTION_KEY_V1` is unrecoverable — rotation to a fresh key is the only recovery and old tokens become permanently unverifiable (see `docs/operations/KEY-ROTATION-AND-SECURITY-RUNBOOK.md`).
- Wiring: `apps/api/src/index.ts` forwards `encryptionSecret: env.ENCRYPTION_KEY_V1` and `appEnv: env.APP_ENV` to `DrizzleStore.create()`. All processes sharing one database must use the same `ENCRYPTION_KEY_V1`.

### 2. Better Auth is the single authentication authority for staff

- Staff login/logout/session validation go through Better Auth sessions (Drizzle `sessions` table). The store's `sessions` state mirrors that table in `DrizzleStore` (load + diff-persist), so it is the same record, not a second session system. The custom in-memory session mechanism survives only as a test-only fallback when a store has no `drizzleDb` (in-memory adapter); it is unreachable in production/staging wiring, which always builds a `DrizzleStore` and fails closed without Hyperdrive.
- Roles/permissions are unchanged (existing RBAC model, `db/schema/access-control.ts` + seed grants). The Better Auth user identity maps to the StackMate staff record by shared `users.id` (the same `users` table, `email` UNIQUE) — never a duplicate identity for one email.
- Suspended users fail session validation even with a live Better Auth session: every authenticated request re-reads the staff record and requires `status === "active"`.
- Logout revokes the session (Better Auth `signOut` + row delete). Password change revokes other sessions (see §3.3). Role changes revoke the staff member's sessions via the `state.sessions` filter, which also revokes Better Auth sessions because the state mirrors the table.
- Public self-registration is blocked: `/api/auth/sign-up/*` returns 403 before the Better Auth fallback. Staff are created only via bootstrap (`POST /api/auth/bootstrap-super-admin`, one-time) or by an admin (`POST /api/v1/admin/users`).

### 3. Verified Better Auth 1.7.23 behaviours (do not re-derive from docs)

These were established empirically against the installed `better-auth@1.7.23` source (`dist/api/routes/*.mjs`, `dist/api/dispatch.mjs`) and the `better-auth-unified` test suite. If better-auth is upgraded, re-verify each one.

1. **Credential account lookup requires `accountId === user.id`.** `signInEmail` finds the credential account with `providerId === "credential" && accountId === userRecord.user.id`. Provisioning an `accounts` row with `accountId` set to the email silently breaks every sign-in (401) even though the row exists. Provisioning must insert `accountId = userId`.
2. **`asResponse: true` returns error responses instead of throwing.** A failed `signInEmail` with `asResponse` arrives as a non-OK `Response`, not an exception. Any retry/fallback logic (e.g. lazy migration) must branch on `!response.ok`, not only on `catch`.
3. **`changePassword({ revokeOtherSessions: true })` revokes ALL sessions, including the current one.** The endpoint calls `deleteUserSessions(userId)` with no exclusion. To revoke only the other sessions, call `changePassword` with `revokeOtherSessions: false` and then the dedicated `auth.api.revokeOtherSessions` endpoint, which filters out the current session token.
4. **There is no Bearer-token session retrieval.** `getSession` reads only the signed session cookie (`ctx.getSignedCookie(..., secret)`). A raw token (from the `Authorization: Bearer` header or the legacy `stackmate_session` cookie) is validated by a direct lookup of the same `sessions` table row — same session, different transport — never a second session store.
5. **Two password hashes, one password.** The staff hash (`scrypt:<salt>:<derived>`, node `scryptSync` r=8, in `users.password_hash`) and the Better Auth hash (`<salt>:<derived>`, scrypt N=16384 r=16 p=1 dkLen=64, in the credential `accounts` row) cannot verify each other. Both are (re)created from the plaintext password whenever it is set or changed, so they stay in sync. A wrong password must never trigger provisioning.

### 4. Migration / compatibility strategy for existing users

- No schema change beyond migration 0004 (signing keys). No user data migration is needed: existing staff keep their `users` rows and scrypt hashes.
- **Lazy migration on first sign-in:** if Better Auth sign-in fails and no credential account exists for the user, and the legacy scrypt hash verifies the supplied password, provision the credential account once (idempotent `ON CONFLICT DO NOTHING`) and retry. A wrong password never provisions. After provisioning, the Better Auth hash is authoritative for sign-in; the legacy hash is kept in sync on password change and is never used to authorize a production request.
- **Eager provisioning:** bootstrap and admin user creation also provision the credential account best-effort, so the first sign-in usually needs no lazy step. Provisioning failure there is non-fatal — lazy migration covers it.
- Never duplicate identities for the same email (single `users` row, single credential account per user); never silently lock out existing accounts (a legacy user with a correct password always signs in, via lazy migration if needed).

### 5. Consequences

- Worker restarts no longer invalidate issued license tokens (verified: token issued by one `DrizzleStore` instance validates on a fresh instance — `apps/api/test/signing-keys.test.ts` test (b)).
- Staff auth has one session table, one revocation path, and one status check; the admin SPA logs in through the unified flow and has a working sign-out button. No password-change UI exists yet in the admin SPA (endpoint + tests only) — recorded as a gap in STATUS.md.
- The test-only in-memory session fallback remains a documented seam (see §2). It must not be presented as a production path.
- Business modules are now verified against live Postgres, not only the in-memory adapter (`apps/api/test/business-workflows.integration.test.ts`, 20 tests). Three real findings from that suite are recorded in STATUS.md: no automatic subscription-expiry job exists; an expired license's status flip is discarded by the validation transaction's rollback; public checkout never dedupes customers by email.
