/**
 * Storage driver abstraction (PLAN §31 / ADR-0011).
 *
 * One interface for where file bytes live; two implementations:
 *  - R2 (`R2StorageDriver`) — wraps the Cloudflare R2 binding (the
 *    existing `r2.ts` bucket). Default everywhere; the only driver that
 *    works on Workers.
 *  - Local (`LocalStorageDriver`, ./local.ts) — plain files under a
 *    root directory, for Docker/VPS deployments without Cloudflare.
 *    It is loaded via DYNAMIC import only (never a static `node:fs`
 *    import — the Worker bundle must not pull node:fs in); on Workers
 *    the import throws and the driver refuses with an honest 503.
 *
 * Driver selection is CONFIG (Settings → Storage, stored in the
 * `storage_settings` singleton row, runtime-applied). Media rows store
 * their OWN driver, so reads always use the row's driver; favicon +
 * payment evidence (legacy rows, no driver column) follow the CURRENT
 * setting — see ADR-0011 for the documented limitation.
 */
import { AppError } from "../../shared/errors.ts";
import type { R2BucketBinding } from "../../env.ts";
import { LocalStorageDriver } from "./local.ts";
import {
  validatePrivateObjectUpload,
  type StoredObjectMetadata,
} from "./r2.ts";
import { loadStorageSettings, type StorageDriverName, type StorageSettingsDb } from "./settings.ts";

export type { StorageDriverName } from "./settings.ts";

export interface StorageObject {
  bytes: Uint8Array;
  contentType: string;
  size: number;
}

/** Inclusive byte range, as parsed from an HTTP `Range` header. */
export interface StorageRange {
  start: number;
  end: number;
}

/** A streamed object read: the body is a `ReadableStream` — the caller
 * never holds the whole object in Worker memory. `size` is the TOTAL
 * object size (the caller knows it from the DB row); the stream
 * carries only the requested range when one was given. */
export interface StorageStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface StorageDriver {
  readonly name: StorageDriverName;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ size: number }>;
  get(key: string): Promise<StorageObject | null>;
  /**
   * Stream an object (whole, or the inclusive `range` when given).
   * The R2 implementation passes the range straight to the bucket
   * (`get(key, { range })`), so a video `preload="metadata"` request
   * downloads only the requested bytes instead of the whole file.
   */
  getStream(key: string, range?: StorageRange): Promise<StorageStream | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class R2StorageDriver implements StorageDriver {
  readonly name: StorageDriverName = "r2";
  private readonly bucket: R2BucketBinding;

  // No parameter property: `node scripts/smoke-check.mjs` runs the TS
  // source through Node's strip-only type stripping, which rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(bucket: R2BucketBinding) {
    this.bucket = bucket;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ size: number }> {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { visibility: "private" },
    });
    return { size: bytes.byteLength };
  }

  async get(key: string): Promise<StorageObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
    };
  }

  async getStream(key: string, range?: StorageRange): Promise<StorageStream | null> {
    const obj = await this.bucket.get(
      key,
      range !== undefined
        ? { range: { offset: range.start, length: range.end - range.start + 1 } }
        : undefined,
    );
    if (!obj) return null;
    // A found object always carries a body stream on the real binding
    // (and on the in-memory stand-in). If a future binding returns a
    // metadata-only object here, fall back to buffering via arrayBuffer
    // rather than crashing the download.
    if (!obj.body) {
      const buf = await obj.arrayBuffer();
      const bytes = new Uint8Array(buf);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      };
    }
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.get(key)) !== null;
  }
}

export interface DriverDeps {
  /** Drizzle DB (null when the store has none — e.g. the in-memory store). */
  db: StorageSettingsDb | null;
  appEnv: "local" | "test" | "staging" | "production";
  r2Bucket?: R2BucketBinding | undefined;
  usesInMemoryBucket?: boolean | undefined;
  /** Local root override for non-Workers runtimes (Docker/VPS env var). */
  localPathEnv?: string | undefined;
}

export const DEFAULT_LOCAL_ROOT = "./data/media";

export interface StorePrivateObjectViaDriverInput {
  driver: StorageDriver;
  /** Metadata only: the R2 bucket name, or "local" for the Local driver. */
  bucketName: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  bytes: Uint8Array;
  maxBytes?: number;
}

/**
 * Driver-aware private-object store (PLAN §31) — the same validation
 * gate as the R2-specific store (size cap + allowlisted MIME + magic
 * bytes via `validatePrivateObjectUpload`), but the bytes land on
 * whichever driver is passed (R2 or Local). Used by the favicon and
 * payment-evidence uploads so they keep working on either driver.
 */
export async function storeValidatedPrivateObject(
  input: StorePrivateObjectViaDriverInput,
): Promise<StoredObjectMetadata> {
  const validated = validatePrivateObjectUpload({
    bytes: input.bytes,
    contentType: input.contentType,
    originalFilename: input.originalFilename,
    maxBytes: input.maxBytes,
  });
  await input.driver.put(input.objectKey, input.bytes, validated.contentType);
  return {
    objectKey: input.objectKey,
    bucketName: input.bucketName,
    originalFilename: validated.sanitizedName,
    contentType: validated.contentType,
    byteSize: validated.byteSize,
    checksumSha256: validated.checksumSha256,
  };
}

/**
 * Resolve the driver to use. `driverName` overrides the setting (media
 * rows carry their own driver — reads always use the row's driver).
 * No override → the `storage_settings` row (default `r2` when the row
 * or the DB is absent).
 *
 * Fail-closed, same rule as payment evidence / favicon today: in
 * staging/production the R2 driver requires the REAL bucket binding —
 * an in-memory bucket there means the deployment is misconfigured and
 * uploads must refuse, not silently store bytes that vanish on restart.
 */
export async function resolveStorageDriver(
  deps: DriverDeps,
  driverName?: StorageDriverName,
): Promise<StorageDriver> {
  const settings = deps.db ? await loadStorageSettings(deps.db).catch(() => null) : null;
  const name: StorageDriverName = driverName ?? settings?.driver ?? "r2";

  if (name === "local") {
    // NOTE: StorageSettingsView is snake_case (local_path) — the
    // camelCase form does not exist on it and reads as undefined.
    const root =
      settings?.local_path?.trim() || deps.localPathEnv?.trim() || DEFAULT_LOCAL_ROOT;
    return new LocalStorageDriver(root);
  }

  if (!deps.r2Bucket) {
    throw new AppError(
      "INTERNAL_ERROR",
      "No R2 bucket is configured for this environment.",
      503,
    );
  }
  if (
    (deps.appEnv === "production" || deps.appEnv === "staging") &&
    deps.usesInMemoryBucket
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Upload is unavailable: no real R2 bucket is configured for this environment.",
      503,
    );
  }
  return new R2StorageDriver(deps.r2Bucket);
}
