/**
 * API-domain audit fixes — media + storage (L-8, L-11, F-13, M-5).
 *
 *  - L-8: the SVG sanitizer is a strict XML parser, not regexes.
 *    Active content is dropped with its subtree (script/style/
 *    foreignObject/animate), event handlers and `style` are gone by
 *    allowlist, hrefs are checked AFTER entity-decoding, and the
 *    output is re-serialized from the parsed tree. Malformed XML,
 *    DOCTYPE internal subsets (ENTITY/XXE) and processing
 *    instructions are rejected (415); a bare DOCTYPE is stripped.
 *  - L-11: thumbnails have a 1 MB cap — oversize/invalid thumbnails
 *    are rejected by verifyThumbnailBytes (413/415).
 *  - F-13: regenerate restores the previous thumbnail bytes when
 *    the row update fails, so the row's thumbByteSize still matches
 *    the stored object.
 *  - M-5: storage local_path must be relative — absolute paths,
 *    `..`, backslashes and drive letters 422.
 *
 * In-memory for the sanitizer/cap/settings tests; regenerate runs
 * against a fake drizzle db + an InMemoryR2Bucket (no Postgres).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MAX_THUMBNAIL_BYTES,
  mediaObjectKey,
  mediaThumbnailKey,
  sanitizeSvgText,
  verifyMediaBytes,
  verifyThumbnailBytes,
} from "../src/platform/storage/media-validation.ts";
import { validateStorageSettingsInput } from "../src/platform/storage/settings.ts";
import { regenerateMediaThumbnail, type MediaDb } from "../src/modules/media/service.ts";
import { InMemoryR2Bucket } from "../src/platform/storage/r2.ts";
import type { DriverDeps } from "../src/platform/storage/driver.ts";
import type { AppError } from "../src/shared/errors.ts";

const enc = new TextEncoder();

/** Minimal valid WebP: RIFF....WEBP (+ 2 payload bytes). */
function webpBytes(extra = 2): Uint8Array {
  const b = new Uint8Array(12 + extra);
  b.set([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  return b;
}

function assertAppError(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
  } catch (err) {
    const e = err as AppError;
    assert.equal(e.code, code);
    assert.equal(e.statusCode, status);
    return;
  }
  assert.fail(`expected ${code} (${status})`);
}

describe("media — parser-based SVG sanitizer (L-8)", () => {
  it("a clean SVG round-trips byte-identical", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><circle cx="10" cy="10" r="5"/></svg>`;
    assert.equal(sanitizeSvgText(svg), svg);
    const v = verifyMediaBytes(enc.encode(svg), "image/svg+xml");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
  });

  it("script/style/foreignObject/animate and event handlers are dropped with their subtrees", () => {
    const nasty =
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">` +
      `<script>alert('xss')</script>` +
      `<style>.x{fill:red}</style>` +
      `<foreignObject><div>html</div></foreignObject>` +
      `<animate onbegin="alert(2)" attributeName="x"/>` +
      `<circle cx="10" cy="10" r="5" onclick="evil()"/>` +
      `</svg>`;
    const clean = sanitizeSvgText(nasty);
    for (const banned of ["<script", "alert(", "<style", "foreignObject", "<animate", "onload", "onclick"]) {
      assert.ok(!clean.toLowerCase().includes(banned.toLowerCase()), `${banned} removed`);
    }
    assert.ok(clean.includes("<svg"), "svg root kept");
    assert.ok(clean.includes("<circle"), "presentation markup kept");
  });

  it("hrefs are checked after entity-decoding; nested svg+xml and javascript: are dropped", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<a href="javascript:alert(1)"><text>bad</text></a>` +
      `<a href="java&#115;cript:alert(1)"><text>encoded bad</text></a>` +
      `<a href="https://example.com"><text>good</text></a>` +
      `<image href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/>` +
      `<image href="data:image/png;base64,iVBORw0KGgo="/>` +
      `</svg>`;
    const clean = sanitizeSvgText(svg);
    assert.ok(!clean.toLowerCase().includes("javascript:"), "javascript: dropped incl. entity-encoded");
    assert.ok(!clean.includes("data:image/svg+xml"), "nested SVG data URI dropped");
    assert.ok(clean.includes("https://example.com"), "https link kept");
    assert.ok(clean.includes("data:image/png;base64"), "raster data URI kept");
  });

  it("a bare DOCTYPE is stripped; an internal subset (ENTITY/XXE) is rejected", () => {
    const bare =
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">` +
      `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>`;
    const clean = sanitizeSvgText(bare);
    assert.ok(!clean.includes("DOCTYPE"));
    assert.ok(clean.includes("<svg"));
    assertAppError(
      () =>
        sanitizeSvgText(
          `<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`,
        ),
      "UNSUPPORTED_MEDIA_TYPE",
      415,
    );
  });

  it("malformed XML, processing instructions and non-SVG roots are rejected (415)", () => {
    assertAppError(() => sanitizeSvgText(`<svg><rect></svg>`), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => sanitizeSvgText(`<svg><rect>`), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(
      () => sanitizeSvgText(`<?xml-stylesheet href="x.css"?><svg></svg>`),
      "UNSUPPORTED_MEDIA_TYPE",
      415,
    );
    assertAppError(() => sanitizeSvgText(`<html><body>hi</body></html>`), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(
      () => sanitizeSvgText(`<svg><text>&unknownentity;</text></svg>`),
      "UNSUPPORTED_MEDIA_TYPE",
      415,
    );
  });
});

describe("media — thumbnail cap (L-11)", () => {
  it("MAX_THUMBNAIL_BYTES is 1 MB; a valid small WebP passes", () => {
    assert.equal(MAX_THUMBNAIL_BYTES, 1 * 1024 * 1024);
    const v = verifyThumbnailBytes(webpBytes());
    assert.equal(v.kind, "image");
  });

  it("an oversized thumbnail 413s; a non-WebP thumbnail 415s", () => {
    const big = new Uint8Array(MAX_THUMBNAIL_BYTES + 1);
    big.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    assertAppError(() => verifyThumbnailBytes(big), "PAYLOAD_TOO_LARGE", 413);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assertAppError(() => verifyThumbnailBytes(png), "UNSUPPORTED_MEDIA_TYPE", 415);
  });
});

describe("media — regenerate restores on DB failure (F-13)", () => {
  type Row = {
    id: string;
    objectKey: string;
    originalFilename: string;
    mimeType: string;
    byteSize: number;
    checksumSha256: string;
    width: number | null;
    height: number | null;
    folder: string;
    tags: string[];
    driver: string;
    uploadedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
    thumbObjectKey: string | null;
    thumbSmallObjectKey: string | null;
    thumbByteSize: number | null;
    thumbSmallByteSize: number | null;
  };

  function seedRow(): { row: Row; bucket: InMemoryR2Bucket; deps: DriverDeps } {
    const objectKey = mediaObjectKey("photo.png", new Date("2026-11-19T00:00:00.000Z"));
    const thumbKey = mediaThumbnailKey(objectKey, "thumb");
    const oldThumb = webpBytes(4);
    const bucket = new InMemoryR2Bucket();
    const row: Row = {
      id: randomUUID(),
      objectKey,
      originalFilename: "photo.png",
      mimeType: "image/png",
      byteSize: 1234,
      checksumSha256: "abc",
      width: 800,
      height: 600,
      folder: "",
      tags: [],
      driver: "r2",
      uploadedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      thumbObjectKey: thumbKey,
      thumbSmallObjectKey: null,
      thumbByteSize: oldThumb.byteLength,
      thumbSmallByteSize: null,
    };
    return { row, bucket, deps: { db: null, appEnv: "test", r2Bucket: bucket } };
  }

  function fakeDb(row: Row, failUpdate: boolean): MediaDb {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [row],
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (failUpdate) throw new Error("boom: db update failed");
              Object.assign(row, patch);
              return [row];
            },
          }),
        }),
      }),
    } as unknown as MediaDb;
  }

  it("a failed row update restores the previous thumbnail bytes", async () => {
    const { row, bucket, deps } = seedRow();
    const oldThumb = webpBytes(4);
    await bucket.put(row.thumbObjectKey!, oldThumb, {
      httpMetadata: { contentType: "image/webp" },
    });
    const newThumb = webpBytes(10);
    await assert.rejects(
      () =>
        regenerateMediaThumbnail(fakeDb(row, true), deps, row.id, {
          thumb: { bytes: newThumb, declaredMimeType: "image/webp" },
        }),
      /boom: db update failed/,
    );
    // The row still points at the OLD size, and the stored object is
    // the OLD bytes — the invariant holds.
    assert.equal(row.thumbByteSize, oldThumb.byteLength);
    const stored = await bucket.get(row.thumbObjectKey!);
    assert.ok(stored);
    assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), oldThumb);
  });

  it("a successful regenerate stores the new bytes and updates the row", async () => {
    const { row, bucket, deps } = seedRow();
    const oldThumb = webpBytes(4);
    await bucket.put(row.thumbObjectKey!, oldThumb, {
      httpMetadata: { contentType: "image/webp" },
    });
    const newThumb = webpBytes(20);
    const view = await regenerateMediaThumbnail(fakeDb(row, false), deps, row.id, {
      thumb: { bytes: newThumb, declaredMimeType: "image/webp" },
    });
    assert.equal(row.thumbByteSize, newThumb.byteLength);
    assert.ok(view.thumb_url);
    const stored = await bucket.get(row.thumbObjectKey!);
    assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), newThumb);
  });

  it("an oversized thumbnail on regenerate 413s and leaves the old bytes alone", async () => {
    const { row, bucket, deps } = seedRow();
    const oldThumb = webpBytes(4);
    await bucket.put(row.thumbObjectKey!, oldThumb, {
      httpMetadata: { contentType: "image/webp" },
    });
    const big = new Uint8Array(MAX_THUMBNAIL_BYTES + 1);
    big.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    await assert.rejects(
      () =>
        regenerateMediaThumbnail(fakeDb(row, false), deps, row.id, {
          thumb: { bytes: big, declaredMimeType: "image/webp" },
        }),
      (err: AppError) => {
        assert.equal(err.code, "PAYLOAD_TOO_LARGE");
        assert.equal(err.statusCode, 413);
        return true;
      },
    );
    const stored = await bucket.get(row.thumbObjectKey!);
    assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), oldThumb);
  });
});

describe("storage — local_path must be relative (M-5)", () => {
  it("relative paths pass; absolute / traversal / backslash / drive-letter paths 422", () => {
    validateStorageSettingsInput({ local_path: "data/media" });
    validateStorageSettingsInput({ local_path: "media" });
    validateStorageSettingsInput({ local_path: "./data/media" });
    validateStorageSettingsInput({ local_path: "" });
    validateStorageSettingsInput({ local_path: null });
    for (const bad of [
      "/etc/media",
      "/var/lib/media",
      "../escape",
      "data/../escape",
      "data\\media",
      "C:\\data\\media",
      "C:/data/media",
      "\\\\server\\share",
    ]) {
      assertAppError(
        () => validateStorageSettingsInput({ local_path: bad }),
        "VALIDATION_ERROR",
        422,
      );
    }
  });
});
