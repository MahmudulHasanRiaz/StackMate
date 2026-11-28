/**
 * Local filesystem storage driver (PLAN §31 / ADR-0011).
 *
 * For Docker/VPS deployments without Cloudflare: plain files under a
 * root directory (`<root>/<object-key>`, keys use `/` separators).
 *
 * The `node:fs/promises` module is loaded via DYNAMIC import only —
 * never a static import — so the Worker bundle never pulls node:fs in.
 * On Workers the import throws and the driver refuses with an honest
 * 503 ("Local storage is not available in this runtime") instead of
 * silently storing nowhere. In Node (vitest, Docker, VPS) it works.
 *
 * Keys are server-generated, but the path is still hardened: absolute
 * paths and `..` segments are rejected, so a compromised key can never
 * escape the root.
 */
import { AppError } from "../../shared/errors.ts";
import type {
  StorageDriver,
  StorageDriverName,
  StorageObject,
  StorageRange,
  StorageStream,
} from "./driver.ts";

type FsPromises = typeof import("node:fs/promises");

let cachedFs: FsPromises | null = null;

async function loadFs(): Promise<FsPromises> {
  if (cachedFs) return cachedFs;
  try {
    cachedFs = await import("node:fs/promises");
    return cachedFs;
  } catch {
    // No SERVICE_UNAVAILABLE code in the AppError union — INTERNAL_ERROR
    // with the 503 status is the established shape for this (driver.ts).
    throw new AppError(
      "INTERNAL_ERROR",
      "Local storage is not available in this runtime (Cloudflare Workers has no filesystem). Select the R2 driver in Settings → Storage.",
      503,
    );
  }
}

function assertSafeKey(key: string): void {
  if (
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").includes("..") ||
    key.trim() === ""
  ) {
    throw new AppError("VALIDATION_ERROR", `Unsafe object key '${key}'.`, 422);
  }
}

export class LocalStorageDriver implements StorageDriver {
  readonly name: StorageDriverName = "local";
  private readonly root: string;

  // No parameter property: see R2StorageDriver (driver.ts) — Node's
  // strip-only type stripping rejects them in scripts/smoke-check.mjs.
  constructor(root: string) {
    this.root = root;
  }

  private filePath(key: string): string {
    assertSafeKey(key);
    const root = this.root.replace(/\/+$/, "");
    return `${root}/${key}`;
  }

  private dirOf(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    return idx > 0 ? filePath.slice(0, idx) : ".";
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<{ size: number }> {
    const fs = await loadFs();
    const path = this.filePath(key);
    await fs.mkdir(this.dirOf(path), { recursive: true });
    await fs.writeFile(path, bytes);
    return { size: bytes.byteLength };
  }

  async get(key: string): Promise<StorageObject | null> {
    const fs = await loadFs();
    const path = this.filePath(key);
    let data: Buffer;
    try {
      data = await fs.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
    return {
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      contentType: "application/octet-stream",
      size: data.byteLength,
    };
  }

  async getStream(key: string, range?: StorageRange): Promise<StorageStream | null> {
    const fs = await loadFs();
    const path = this.filePath(key);
    let handle: Awaited<ReturnType<FsPromises["open"]>>;
    try {
      handle = await fs.open(path, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
    // FileHandle.createReadStream auto-closes the handle when the
    // stream ends/errors (autoClose default) — no handle leak on the
    // download path. The caller reads the stream to completion (the
    // HTTP response owns it); on an early abort the runtime closes it.
    const stream = handle.createReadStream(
      range !== undefined ? { start: range.start, end: range.end } : {},
    );
    return {
      // Node's createReadStream yields Buffer chunks; the HTTP layer
      // accepts any Uint8Array chunk type.
      body: stream as unknown as ReadableStream<Uint8Array>,
      contentType: "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const fs = await loadFs();
    const path = this.filePath(key);
    try {
      await fs.unlink(path);
    } catch (err) {
      // Delete is idempotent: a missing object is already gone.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const fs = await loadFs();
    try {
      await fs.stat(this.filePath(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
  }
}
