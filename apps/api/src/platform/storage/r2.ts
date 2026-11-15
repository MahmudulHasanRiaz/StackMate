/**
 * Cloudflare R2 Private Object Storage Adapter (ADR-0006, TAD §17.4, Security §4.9).
 * - Validates file byte size, allowlisted MIME types, and magic-byte file headers.
 * - Generates server-side object keys; never trusts user-supplied file paths.
 * - Stores objects privately in R2 (or an in-memory R2 bucket binding in tests/local dev).
 */
import type { R2BucketBinding, R2ObjectBodyLike } from "../../env.ts";
import { AppError } from "../../shared/errors.ts";
import { sha256Hex } from "../crypto/index.ts";

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_EVIDENCE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

export function verifyFileMagicBytes(bytes: Uint8Array, declaredMimeType: string): void {
  if (bytes.byteLength < 8) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Uploaded file is empty or truncated.", 415);
  }
  const mime = declaredMimeType.trim().toLowerCase();
  if (!ALLOWED_EVIDENCE_MIME_TYPES.has(mime)) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      `Unsupported content type '${declaredMimeType}'. Allowed: PNG, JPEG, WEBP, PDF.`,
      415
    );
  }

  if (mime === "image/png") {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!pngSig.every((b, idx) => bytes[idx] === b)) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match PNG format.", 415);
    }
    return;
  }

  if (mime === "image/jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match JPEG format.", 415);
    }
    return;
  }

  if (mime === "application/pdf") {
    // %PDF-
    if (
      bytes[0] !== 0x25 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 0x2d
    ) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match PDF format.", 415);
    }
    return;
  }

  if (mime === "image/webp") {
    // RIFF....WEBP
    const isRiff =
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isWebp =
      bytes.byteLength >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
    if (!isRiff || !isWebp) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match WEBP format.", 415);
    }
  }
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "upload.bin";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "upload.bin";
}

export class InMemoryR2Bucket implements R2BucketBinding {
  private readonly objects = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  >();

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<{ key: string; size: number }> {
    const bytes =
      typeof value === "string"
        ? new Uint8Array(Buffer.from(value, "utf8"))
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
    this.objects.set(key, {
      bytes,
      ...(options?.httpMetadata !== undefined
        ? { httpMetadata: options.httpMetadata }
        : {}),
      ...(options?.customMetadata !== undefined
        ? { customMetadata: options.customMetadata }
        : {}),
    });
    return { key, size: bytes.byteLength };
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      key,
      size: entry.bytes.byteLength,
      ...(entry.httpMetadata !== undefined
        ? { httpMetadata: entry.httpMetadata }
        : {}),
      ...(entry.customMetadata !== undefined
        ? { customMetadata: entry.customMetadata }
        : {}),
      async arrayBuffer(): Promise<ArrayBuffer> {
        return entry.bytes.buffer.slice(
          entry.bytes.byteOffset,
          entry.bytes.byteOffset + entry.bytes.byteLength
        ) as ArrayBuffer;
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface StorePrivateObjectInput {
  bucket: R2BucketBinding;
  bucketName: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  bytes: Uint8Array;
  maxBytes?: number;
}

export interface StoredObjectMetadata {
  objectKey: string;
  bucketName: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
}

export async function storeValidatedPrivateR2Object(
  input: StorePrivateObjectInput
): Promise<StoredObjectMetadata> {
  const maxBytes = input.maxBytes ?? MAX_EVIDENCE_BYTES;
  if (input.bytes.byteLength > maxBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Uploaded file exceeds maximum allowed size of ${maxBytes} bytes.`,
      413
    );
  }
  verifyFileMagicBytes(input.bytes, input.contentType);
  const sanitizedName = sanitizeFilename(input.originalFilename);
  const checksum = sha256Hex(input.bytes);

  await input.bucket.put(input.objectKey, input.bytes, {
    httpMetadata: { contentType: input.contentType.toLowerCase() },
    customMetadata: {
      sha256: checksum,
      originalFilename: sanitizedName,
      visibility: "private",
    },
  });

  return {
    objectKey: input.objectKey,
    bucketName: input.bucketName,
    originalFilename: sanitizedName,
    contentType: input.contentType.toLowerCase(),
    byteSize: input.bytes.byteLength,
    checksumSha256: checksum,
  };
}
