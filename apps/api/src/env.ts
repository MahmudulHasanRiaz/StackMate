export interface HyperdriveBinding {
  readonly connectionString: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
}

export interface R2ObjectBodyLike {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
  /**
   * Present on ranged reads: the byte range actually returned
   * (Cloudflare R2 Workers API — `get(key, { range })`).
   */
  readonly range?: { offset: number; length: number };
  /**
   * The object body as a stream. Absent only when a precondition
   * (`onlyIf`) fails — not used by this codebase, so callers may
   * treat a missing body on a found object as an internal error.
   */
  readonly body?: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Metadata-only view of an object (what `head()` returns). */
export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}

export interface R2BucketBinding {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<{ key: string; size: number }>;
  /**
   * Whole object, or — with `range` — only the requested bytes
   * (Cloudflare R2 Workers API, "Ranged reads": `{ offset, length }`,
   * `{ offset }`, `{ length }` or `{ suffix }`). The returned body's
   * `.body` stream carries only the range; `.range` reports it.
   */
  get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number; suffix?: number };
    }
  ): Promise<R2ObjectBodyLike | null>;
  /** Metadata only, no body — for totals without downloading. */
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface StackMateBindings {
  APP_ENV: "local" | "test" | "staging" | "production";
  APP_URL: string;
  API_URL: string;
  DEFAULT_TIMEZONE: string;
  DEFAULT_CURRENCY: string;
  TRUSTED_ORIGINS: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  ENCRYPTION_KEY_V1: string;
  ACTIVE_ENCRYPTION_KEY_VERSION: string;
  LICENSE_VERIFIER_SECRET: string;
  CHECKOUT_TOKEN_SECRET: string;
  /**
   * First-admin setup token (Security, 2026-11-15): the operator-set
   * secret that gates POST /api/auth/bootstrap-super-admin. OPTIONAL by
   * design — when unset/empty the bootstrap endpoint is DISABLED entirely
   * (it answers 404, as if it did not exist). It is NEVER given a
   * fallback/default value: a default would let anyone who reads the
   * source claim a fresh instance. Set it as a Worker secret in the
   * Cloudflare dashboard (staging/production) or in local env.
   * When set in staging/production it must be at least 32 characters;
   * resolveRuntimeConfig throws otherwise (fail-closed at boot).
   */
  SETUP_TOKEN?: string | undefined;
  LICENSE_SIGNING_PRIVATE_JWK?: string | undefined;
  LICENSE_SIGNING_PUBLIC_JWK?: string | undefined;
  LICENSE_SIGNING_KEY_ID: string;
  R2_BUCKET_NAME: string;
  META_GRAPH_API_VERSION: string;
  HYPERDRIVE_NO_CACHE: HyperdriveBinding;
  HYPERDRIVE_CACHED?: HyperdriveBinding;
  R2_BUCKET?: R2BucketBinding | undefined;
}

export function resolveRuntimeConfig(rawEnv: Partial<StackMateBindings> = {}): StackMateBindings {
  const appEnv = (rawEnv.APP_ENV ?? process.env.APP_ENV ?? "local") as StackMateBindings["APP_ENV"];
  const isProd = appEnv === "production" || appEnv === "staging";

  const betterAuthSecret =
    rawEnv.BETTER_AUTH_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    (isProd ? "" : "local-dev-better-auth-secret-minimum-32-chars-long");
  const encryptionKeyV1 =
    rawEnv.ENCRYPTION_KEY_V1 ??
    process.env.ENCRYPTION_KEY_V1 ??
    (isProd ? "" : "local-dev-aes-256-gcm-master-key-32-bytes-seed!!");
  const licenseVerifierSecret =
    rawEnv.LICENSE_VERIFIER_SECRET ??
    process.env.LICENSE_VERIFIER_SECRET ??
    (isProd ? "" : "local-dev-license-verifier-hmac-secret-key-2026");
  const checkoutTokenSecret =
    rawEnv.CHECKOUT_TOKEN_SECRET ??
    process.env.CHECKOUT_TOKEN_SECRET ??
    (isProd ? "" : "local-dev-checkout-access-token-hmac-secret-2026");
  const setupToken =
    rawEnv.SETUP_TOKEN ?? process.env.SETUP_TOKEN ?? "";

  if (isProd) {
    if (!betterAuthSecret || betterAuthSecret.length < 32) {
      throw new Error("BETTER_AUTH_SECRET must be set and at least 32 characters in staging/production.");
    }
    if (!encryptionKeyV1 || encryptionKeyV1.length < 32) {
      throw new Error("ENCRYPTION_KEY_V1 must be set in staging/production.");
    }
    if (!licenseVerifierSecret || !checkoutTokenSecret) {
      throw new Error("LICENSE_VERIFIER_SECRET and CHECKOUT_TOKEN_SECRET must be set in staging/production.");
    }
    // A short SETUP_TOKEN is barely better than none: reject it at boot
    // instead of serving a weakly-gated bootstrap endpoint. Unset is
    // fine — the endpoint is disabled then (see app.ts).
    if (setupToken && setupToken.length < 32) {
      throw new Error("SETUP_TOKEN must be at least 32 characters when set in staging/production.");
    }
    if (!rawEnv.HYPERDRIVE_NO_CACHE?.connectionString) {
      throw new Error("HYPERDRIVE_NO_CACHE binding is required in staging/production.");
    }
  }

  const fallbackDbUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/stackmate";

  return {
    APP_ENV: appEnv,
    APP_URL: rawEnv.APP_URL ?? process.env.APP_URL ?? "http://localhost:5173",
    API_URL: rawEnv.API_URL ?? process.env.API_URL ?? "http://localhost:8787",
    DEFAULT_TIMEZONE: rawEnv.DEFAULT_TIMEZONE ?? process.env.DEFAULT_TIMEZONE ?? "Asia/Dhaka",
    DEFAULT_CURRENCY: rawEnv.DEFAULT_CURRENCY ?? process.env.DEFAULT_CURRENCY ?? "BDT",
    TRUSTED_ORIGINS:
      rawEnv.TRUSTED_ORIGINS ??
      process.env.TRUSTED_ORIGINS ??
      "http://localhost:5173,http://localhost:8787",
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: rawEnv.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
    ENCRYPTION_KEY_V1: encryptionKeyV1,
    ACTIVE_ENCRYPTION_KEY_VERSION:
      rawEnv.ACTIVE_ENCRYPTION_KEY_VERSION ?? process.env.ACTIVE_ENCRYPTION_KEY_VERSION ?? "v1",
    LICENSE_VERIFIER_SECRET: licenseVerifierSecret,
    CHECKOUT_TOKEN_SECRET: checkoutTokenSecret,
    SETUP_TOKEN: setupToken || undefined,
    LICENSE_SIGNING_PRIVATE_JWK:
      rawEnv.LICENSE_SIGNING_PRIVATE_JWK ?? process.env.LICENSE_SIGNING_PRIVATE_JWK,
    LICENSE_SIGNING_PUBLIC_JWK:
      rawEnv.LICENSE_SIGNING_PUBLIC_JWK ?? process.env.LICENSE_SIGNING_PUBLIC_JWK,
    LICENSE_SIGNING_KEY_ID:
      rawEnv.LICENSE_SIGNING_KEY_ID ?? process.env.LICENSE_SIGNING_KEY_ID ?? "sm-ed25519-2026-11",
    R2_BUCKET_NAME:
      rawEnv.R2_BUCKET_NAME ?? process.env.R2_BUCKET_NAME ?? "stackmate-private-assets",
    META_GRAPH_API_VERSION:
      rawEnv.META_GRAPH_API_VERSION ?? process.env.META_GRAPH_API_VERSION ?? "v21.0",
    HYPERDRIVE_NO_CACHE: rawEnv.HYPERDRIVE_NO_CACHE ?? { connectionString: fallbackDbUrl },
    HYPERDRIVE_CACHED:
      rawEnv.HYPERDRIVE_CACHED ?? rawEnv.HYPERDRIVE_NO_CACHE ?? { connectionString: fallbackDbUrl },
    R2_BUCKET: rawEnv.R2_BUCKET,
  };
}
