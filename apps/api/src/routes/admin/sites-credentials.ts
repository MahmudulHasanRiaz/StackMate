/**
 * Admin site-credential routes (Hono) — Hono migration Phase 1.
 *
 * Split out of sites.ts (500-line cap). Credential list/create/
 * revoke/rotate (create + rotate are A-04 idempotent). Converted
 * verbatim from app.ts (baseline feat e382d65).
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { decryptSecretAtRest, sha256Hex } from "../../platform/crypto/index.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  createSiteCredentialByAdmin,
  revokeSiteCredentialByAdmin,
  rotateSiteServerCredentialByAdmin,
} from "../../modules/integrations/service.ts";

// --- HTTP plumbing copied from app.ts handleRequest (closures there) ---

function requirePrincipal(c: Context<AppEnv>): StaffPrincipal {
  const principal = c.var.principal;
  if (!principal) {
    throw new AppError(
      "UNAUTHORIZED",
      "Valid staff authentication session required.",
      401
    );
  }
  return principal;
}

function ok<T>(c: Context<AppEnv>, data: T, status = 200): Response {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status as ContentfulStatusCode);
}

function parseListQuery(query: Record<string, string | undefined>): {
  q: string;
  limit: number;
  page: number;
} {
  const q = query.q?.trim().toLowerCase() ?? "";
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), 100)
      : 25;
  const rawPage = Number(query.page);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { q, limit, page };
}

function applyListPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

function pagedCollection<T>(
  c: Context<AppEnv>,
  filtered: T[],
  limit: number,
  page = 1,
  nextCursor: string | null = null,
  status = 200
): Response {
  return c.json(
    createCollectionEnvelope(
      applyListPage(filtered, limit, page),
      nextCursor,
      c.var.requestId,
      filtered.length
    ),
    status as ContentfulStatusCode
  );
}

const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

async function readJsonBody(c: Context<AppEnv>): Promise<any> {
  const body = c.req.raw.body;
  if (!body) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Request payload exceeds limit.",
        413
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim() === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is not valid JSON.",
      400
    );
  }
}

// Lenient variant for handlers that treat a missing/malformed body
// as "no body". A 413 is never swallowed: an oversize body must fail
// loudly.

async function runIdempotentCommand<T>(
  store: StackMateDataStore,
  options: {
    scope: string;
    key: string | null | undefined;
    payload: unknown;
    statusCode: number;
    fn: () => Promise<T>;
    redactForStore?: (body: T) => unknown;
    reissueOnReplay?: (storedBody: unknown) => Promise<T> | T;
  }
): Promise<{ status: number; body: T; replayed: boolean }> {
  const rawKey = options.key?.trim() ?? "";
  if (rawKey === "") {
    return { status: options.statusCode, body: await options.fn(), replayed: false };
  }
  if (rawKey.length < 8 || rawKey.length > 128) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Idempotency-Key header must be between 8 and 128 characters.",
      400
    );
  }
  const requestHash = sha256Hex(JSON.stringify(options.payload ?? {}));
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const findRecord = (state: typeof store.state) =>
    state.idempotency_records.find(
      (r) => r.scope_key === options.scope && r.idempotency_key === rawKey
    );
  const reserved = await store.withTransaction((state) => {
    const existing = findRecord(state);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with a different request payload.",
          409
        );
      }
      if (existing.status === "processing") {
        throw new AppError(
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is currently processing.",
          409
        );
      }
      if (existing.status === "failed") {
        existing.status = "processing";
        existing.response_body = null;
        return { replay: false as const };
      }
      return {
        replay: true as const,
        body: existing.response_body,
        status: existing.response_status,
      };
    }
    state.idempotency_records.push({
      id: randomUUID(),
      scope_key: options.scope,
      idempotency_key: rawKey,
      request_hash: requestHash,
      status: "processing",
      response_status: options.statusCode,
      response_body: null,
      expires_at: expiresAt,
      created_at: nowIso,
    });
    return { replay: false as const };
  });
  if (reserved.replay) {
    const body = options.reissueOnReplay
      ? await options.reissueOnReplay(reserved.body)
      : (reserved.body as T);
    return { status: reserved.status, body, replayed: true };
  }
  let body: T;
  try {
    body = await options.fn();
  } catch (error) {
    await store
      .withTransaction((state) => {
        const rec = findRecord(state);
        if (rec && rec.status === "processing") rec.status = "failed";
      })
      .catch(() => {});
    throw error;
  }
  const storedBody = options.redactForStore ? options.redactForStore(body) : body;
  await store
    .withTransaction((state) => {
      const rec = findRecord(state);
      if (rec) {
        rec.status = "completed";
        rec.response_status = options.statusCode;
        rec.response_body = storedBody;
      }
    })
    .catch(() => {});
  return { status: options.statusCode, body, replayed: false };
}

export function registerAdminSiteCredentialsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/integrated-sites/:siteId/credentials", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const site = store.state.integrated_sites.find(
      (s) => s.id === c.req.param("siteId")
    );
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(
      c,
      store.state.site_credentials
        .filter((cr) => cr.integrated_site_id === site.id)
        .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
      limit,
      page
    );
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/credentials", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
    const body = await readJsonBody(c);
    // A-04: credential creation is idempotent per
    // Idempotency-Key. The raw secret is shown ONCE — it is
    // never stored in the idempotency row (A-03 class); on
    // replay it is re-derived by decrypting the stored
    // ciphertext of the created credential row.
    const siteId = c.req.param("siteId");
    const created = await runIdempotentCommand(store, {
      scope: `admin_credential_create:${siteId}`,
      key: c.req.header("Idempotency-Key"),
      payload: body,
      statusCode: 201,
      fn: () =>
        createSiteCredentialByAdmin(
          store,
          principal,
          siteId,
          body,
          {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            requestId,
          }
        ),
      redactForStore: (result) => ({ ...result, raw_secret_once: null }),
      reissueOnReplay: (stored) => {
        const storedResult = stored as {
          credential?: { id?: string };
          raw_secret_once?: string | null;
          [key: string]: unknown;
        };
        const credId = storedResult.credential?.id;
        const row = credId
          ? store.state.site_credentials.find((cr) => cr.id === credId)
          : undefined;
        return {
          ...storedResult,
          raw_secret_once:
            row?.secret_ciphertext && row.secret_ciphertext.length > 0
              ? decryptSecretAtRest(
                  row.secret_ciphertext,
                  env.ENCRYPTION_KEY_V1,
                  `site_credentials:${row.id}`
                )
              : null,
        } as Awaited<ReturnType<typeof createSiteCredentialByAdmin>>;
      },
    });
    return ok(c, created.body, created.replayed ? 200 : 201);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/credentials/:credentialId/revoke", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
    const revoked = await revokeSiteCredentialByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("credentialId"),
      requestId
    );
    return ok(c, revoked);
  });

  // Batch 1: site domains. Registration NEVER auto-verifies — new
  // domains start "pending" (Batch 2 adds real DNS/HTTP checks).


  app.post("/api/v1/admin/integrated-sites/:siteId/credentials/:credentialId/rotate", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.rotate_credentials", requestId);
    // A-04: rotation is idempotent per Idempotency-Key (a
    // retried rotation replays the first new credential instead
    // of minting a second one). The raw secret is re-derived
    // from the stored ciphertext on replay, never stored in the
    // idempotency row.
    const siteId = c.req.param("siteId");
    const credentialId = c.req.param("credentialId");
    const rotated = await runIdempotentCommand(store, {
      scope: `admin_credential_rotate:${credentialId}`,
      key: c.req.header("Idempotency-Key"),
      payload: {},
      statusCode: 200,
      fn: () =>
        rotateSiteServerCredentialByAdmin(
          store,
          principal,
          siteId,
          credentialId,
          {
            encryptionKey: env.ENCRYPTION_KEY_V1,
            keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            requestId,
          }
        ),
      redactForStore: (result) => ({ ...result, raw_secret_once: null }),
      reissueOnReplay: (stored) => {
        const storedResult = stored as {
          new_credential?: { id?: string };
          raw_secret_once?: string | null;
          [key: string]: unknown;
        };
        const credId = storedResult.new_credential?.id;
        const row = credId
          ? store.state.site_credentials.find((cr) => cr.id === credId)
          : undefined;
        return {
          ...storedResult,
          raw_secret_once:
            row?.secret_ciphertext && row.secret_ciphertext.length > 0
              ? decryptSecretAtRest(
                  row.secret_ciphertext,
                  env.ENCRYPTION_KEY_V1,
                  `site_credentials:${row.id}`
                )
              : null,
        } as Awaited<ReturnType<typeof rotateSiteServerCredentialByAdmin>>;
      },
    });
    return ok(c, rotated.body);
  });

}
