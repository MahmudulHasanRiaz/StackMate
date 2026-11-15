# Key Rotation, Cryptography & Security Runbook

> Source of truth for the implemented lifecycle is the code:
> `apps/api/src/platform/db/drizzle-store.ts` (durable key load, rotation,
> revocation), `apps/api/src/platform/crypto/index.ts` (AES-256-GCM envelope
> encryption, Ed25519 JWS), `db/migrations/0004_signing_keys.sql`, and
> `apps/api/test/signing-keys.test.ts` (the executable proof of every claim
> below). If this document and the code disagree, the code wins and this
> document must be fixed.

## 1. What the keys are

| Secret / credential | Storage | Algorithm |
| :--- | :--- | :--- |
| License signing private key (Ed25519) | `signing_keys.encrypted_private_jwk` (one row per key version) | Ed25519 (`EdDSA` compact JWS); private JWK encrypted with AES-256-GCM under `ENCRYPTION_KEY_V1` |
| License signing public key | `signing_keys.public_jwk` (clear) + `signing_key_metadata.public_key_jwk` (mirror) | Published by `GET /api/v1/licenses/signing-keys` |
| Envelope master secret | Worker secret / env `ENCRYPTION_KEY_V1` (never in the DB, never in git) | AES-256-GCM, key = `sha256(masterSecret)`; format `v1:<iv>:<tag>:<ct>` (base64url) |
| License key verifier | `licenses.license_key_hash` | Keyed HMAC-SHA256 (`LICENSE_VERIFIER_SECRET`) |
| Staff passwords | Better Auth `accounts` | scrypt (see identity module) |

## 2. The `signing_keys` table (migration 0004) — source of truth

```sql
signing_keys (
  id uuid PK,                       -- app-supplied (randomUUID)
  key_id text UNIQUE NOT NULL,      -- e.g. sm-ed25519-2026-11
  public_jwk jsonb NOT NULL,        -- published; includes kid/alg/use
  encrypted_private_jwk text NOT NULL,
  status text NOT NULL,             -- active | retired | revoked
  created_at timestamptz NOT NULL,
  activated_at timestamptz NULL,
  retired_at timestamptz NULL,
  supersedes_key_id text NULL,      -- rotation chain (FK to signing_keys.key_id)
  rotation_reason text NULL
)
-- Partial unique index: exactly ONE row may be status='active'.
```

**AAD choice (important).** The private JWK is encrypted with
`encryptSecretAtRest(plaintext, ENCRYPTION_KEY_V1, "v1", aadContext)` where
`aadContext = "signing_key:<key_id>"` (see `signingKeyAadContext()` in
`drizzle-store.ts`). The GCM AAD is therefore `v1:signing_key:<key_id>`.
The AAD is a *fixed string per key id* on purpose: a ciphertext copied
to a different key row — or to a different purpose, e.g. a site
credential — cannot decrypt, and re-keying a row under a new id requires
re-encryption rather than a silent copy. The AAD is not secret; the
secrecy comes from `ENCRYPTION_KEY_V1`.

**`signing_key_metadata` (migration 0000) stays.** It is the *public
metadata mirror* (key id, public JWK, status, activated/retired
timestamps) that older code reads. DrizzleStore keeps it in sync with
`signing_keys` in the *same transaction* on bootstrap, rotation, and
revocation, so the two tables cannot diverge. Private material is NEVER
written to `signing_key_metadata`. Do not delete the table; do not read
private keys from it — there are none there.

**Lifecycle states.**

- `active` — exactly one. Signs new entitlement tokens; published in JWKS.
- `retired` — a former active key. Still loaded at boot, still published
  in JWKS, still verifies tokens it signed. Retired keys are how rotation
  stays backwards compatible through the offline grace window.
- `revoked` — never loaded at boot, never published in JWKS. Tokens
  signed by a revoked key stop verifying immediately. Revocation is the
  compromise response, not a routine step.

## 3. Bootstrap — first boot on a database

On `DrizzleStore.create()`, in one advisory-locked transaction:

1. If an `active` row exists, load it **plus every `retired` row**
   (decrypting each private JWK with `ENCRYPTION_KEY_V1`). Revoked rows
   are never loaded.
2. If no active row exists **and** `LICENSE_SIGNING_PRIVATE_JWK` is
   supplied (create() option `signingPrivateJwk`, or the env var), import
   that JWK **once** and persist it encrypted as the active key.
   The env JWK is **bootstrap-only**: after the first import the DB is
   the source of truth, and later boots ignore the env var entirely
   (changing it does not change the active key).
3. If no active row exists and no JWK is supplied, generate **one**
   Ed25519 key, encrypt it, and persist it immediately.
4. The constructor's per-process key is discarded; `getActiveSigningKey()`
   refuses to serve until the durable load succeeds — a store can never
   sign with a key that is not in the DB.

Concurrent boots converge on a single active row (advisory lock +
unique `key_id` + `ON CONFLICT DO NOTHING`, then re-read).

**Key id.** The bootstrap id is, in priority order: the
`signingKeyId` create() option (`LICENSE_SIGNING_KEY_ID`, default
`sm-ed25519-2026-11`) → the active `signing_key_metadata` row (legacy
hint) → the current month, `sm-ed25519-YYYY-MM`.

**Fail-closed boot.** Boot throws a clear error — and the API never
serves — when: migration 0004 has not been applied (`signing_keys`
missing); `ENCRYPTION_KEY_V1` is missing in staging/production (see §6);
or a stored key cannot be decrypted (see §7).

## 4. Rotation (routine, recommended every 180 days)

Rotate from application code (there is no admin UI for this yet):

```ts
await store.rotateSigningKey(); // derives sm-ed25519-YYYY-MM[-n]
await store.rotateSigningKey("sm-ed25519-2027-01", { reason: "scheduled" });
```

What happens, in **one** advisory-locked transaction:

1. The current active row is marked `retired` (`retired_at = now()`).
   This happens *before* the insert — the single-active partial unique
   index forbids two active rows even for an instant.
2. The new key is inserted as `active`, encrypted, with
   `supersedes_key_id` pointing at the old key and `rotation_reason`
   recorded.
3. `signing_key_metadata` is synced for both keys in the same transaction.
4. Only after the commit does the in-memory map switch the active key.
   The retired key stays loaded, so tokens it signed keep verifying.

**New key ids** are derived as `sm-ed25519-YYYY-MM`, with a `-2`, `-3`, …
suffix when that id is already taken (e.g. rotating twice in one month
yields `sm-ed25519-2026-11-2`). Key ids are never reused: a retired
key's `kid` can never be hijacked by new material. Passing an explicit
id that already exists is a `409 CONFLICT`.

**After rotation.** New activations/validations sign with the new `kid`;
old tokens keep verifying through the JWKS endpoint, which publishes
active + retired public JWKs. Keep the retired key until its tokens can
no longer be in circulation (at minimum 2× the offline grace window,
14 days), then revoke it if it must stop verifying — or leave it retired.

**Verification:** `apps/api/test/signing-keys.test.ts` test (c) proves
old-token-still-verifies after rotation, including from a fresh store
instance; test (b) is the restart-persistence check (issue a token,
construct a brand-new `DrizzleStore`, verify).

## 5. Revocation (compromise response)

```ts
await store.revokeSigningKey("sm-ed25519-2026-11"); // retired keys only
```

- The row becomes `revoked` (metadata synced in the same transaction)
  and the key is dropped from the in-memory verification set.
- Its tokens stop verifying immediately, and its public JWK leaves
  `GET /api/v1/licenses/signing-keys`.
- **The active key can never be revoked** (`409 CONFLICT`): rotate
  first, then revoke the retired key, so there is always exactly one
  active key. Revoking an already-revoked key is a no-op.
- Revocation is not undo-able through the API: the private material
  stays in the row (encrypted), but the store will never load a
  `revoked` row. Re-activating a revoked key requires a deliberate,
  reviewed manual DB change — treat it as an incident action, not a
  routine one.

## 6. `ENCRYPTION_KEY_V1` — handling and loss

- The secret is supplied to `DrizzleStore.create()` as `encryptionSecret`
  (preferred: the wiring layer passes `env.ENCRYPTION_KEY_V1`) or via
  `process.env.ENCRYPTION_KEY_V1` in local dev. **Wiring (done 2026-11-15):**
  `apps/api/src/index.ts` forwards `encryptionSecret: env.ENCRYPTION_KEY_V1`
  and `appEnv: env.APP_ENV` from the resolved Worker env, so a deployed
  Worker decrypts with the real secret. A Worker without the secret still
  fails closed with a clear error — this is intentional: silently falling
  back to a public dev default in a Worker would encrypt production keys
  with a known secret.
- The local/test dev fallback (the same literal as the `env.ts` dev
  default) applies **only** when the runtime is positively local/test
  (`APP_ENV` `local`/`test`, `NODE_ENV=test`, or under vitest). Any
  other runtime without a secret fails closed.
- **All processes sharing one database must use the same
  `ENCRYPTION_KEY_V1`.** Envelope encryption is per-database: a boot
  with a different secret than the one that encrypted the stored keys
  fails closed at startup ("could not decrypt signing key …") instead
  of silently minting a replacement key. This is by design — a silent
  replacement would invalidate every token ever signed with no audit
  trail. The test suites share the dev fallback for exactly this
  reason (see `apps/api/test/signing-keys.test.ts` test (f)).
- Rotate `ENCRYPTION_KEY_V1` itself only by re-encrypting every
  `signing_keys.encrypted_private_jwk` row under the new secret (there
  is no re-wrap job yet — do it as a reviewed one-off migration script,
  decrypting with the old secret and encrypting with the new one under
  the same per-key AAD). Never delete the old secret until zero rows
  remain encrypted under it.

### If `ENCRYPTION_KEY_V1` is lost — read this plainly

**Losing `ENCRYPTION_KEY_V1` means the stored private keys cannot be
decrypted, ever.** AES-256-GCM has no recovery path: without the exact
master secret, the ciphertexts in `signing_keys` are unrecoverable
random bytes. There is no backup copy of the private keys anywhere
(the env JWK, if one was ever supplied, was bootstrap-only and is not
stored after import — unless the operator kept it separately).

The **only recovery** is rotation to a fresh key:

1. Provision a new `ENCRYPTION_KEY_V1` and deploy it.
2. Boot will still fail while the old undecryptable rows are `active` —
   the store fails closed rather than silently minting a replacement
   (a silent replacement would invalidate tokens with no audit trail).
   As a deliberate, reviewed incident step, retire the undecryptable
   active row in the DB (`status = 'retired'`) so the next boot can
   bootstrap a fresh active key under the new secret. Record the
   incident: who, when, why.
3. The fresh key becomes active; new tokens verify.

**Consequence, stated plainly: every entitlement token signed by the
lost keys becomes permanently unverifiable.** Clients holding those
tokens must re-validate (activate/validate) to obtain a token signed
by the new key. There is no way to re-issue the old tokens, and no way
to make the old keys verify again. Back up `ENCRYPTION_KEY_V1` in the
secret store *before* the first production boot; treat its loss as a
key-compromise-grade incident.

## 7. Other secrets (summary — see their modules for detail)

- `LICENSE_VERIFIER_SECRET` — HMAC key for license-key verifiers. No
  rotation procedure yet; rotating it invalidates all stored verifiers
  unless a dual-secret transition is built first.
- `BETTER_AUTH_SECRET`, `CHECKOUT_TOKEN_SECRET` — Worker secrets
  (`env.ts`); rotation is a secret replacement + redeploy.
- Site credentials / tracking tokens are AES-256-GCM encrypted with
  `ENCRYPTION_KEY_V1` in their own tables (see the identity/integrations
  modules) — the §6 loss warning applies to them as well.

## 8. Operator checklist

- [ ] Before first production boot: `ENCRYPTION_KEY_V1` is set in the
      secret store **and backed up**; migration 0004 is applied
      (`node scripts/migrate.mjs`).
- [ ] After boot: `SELECT key_id, status FROM signing_keys;` shows
      exactly one `active` row; `GET /api/v1/licenses/signing-keys`
      returns its public JWK.
- [ ] Rotation (every 180 days): rotate → verify old tokens still
      verify → verify new tokens carry the new `kid` → after the grace
      window, revoke the retired key if required.
- [ ] Never commit a private JWK, `ENCRYPTION_KEY_V1`, or an
      `encrypted_private_jwk` value to git, chat, or logs. Never log a
      decrypted private JWK.
