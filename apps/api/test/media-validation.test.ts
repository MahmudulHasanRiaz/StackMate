/**
 * Media-library validation (PLAN §31 / ADR-0011, Security §4.9).
 *
 * Pure unit tests — no database. Every accepted type is proved by
 * magic bytes (never by extension or declared MIME alone); SVG is
 * proved sanitized (the STORED bytes carry no active content).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_MEDIA_BYTES,
  mediaKindOfMime,
  mediaObjectKey,
  normalizeFilename,
  normalizeFolder,
  normalizeTags,
  sanitizeSvgText,
  verifyMediaBytes,
} from "../src/platform/storage/media-validation.ts";

const enc = new TextEncoder();

function pngBytes(width = 800, height = 600): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // PNG: signature (0..7), IHDR length 13 (8..11), "IHDR" (12..15),
  // width BE (16..19), height BE (20..23).
  b[8] = 0; b[9] = 0; b[10] = 0; b[11] = 13;
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b[16] = (width >> 24) & 0xff; b[17] = (width >> 16) & 0xff; b[18] = (width >> 8) & 0xff; b[19] = width & 0xff;
  b[20] = (height >> 24) & 0xff; b[21] = (height >> 16) & 0xff; b[22] = (height >> 8) & 0xff; b[23] = height & 0xff;
  return b;
}

function jpegBytes(width = 800, height = 600): Uint8Array {
  // SOI + APP0 (JFIF, 16) + SOF0 (17) with 800x600.
  const b = [
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  return new Uint8Array(b);
}

function webpBytes(width = 800, height = 600): Uint8Array {
  // RIFF + WEBP + VP8X (10-byte chunk) with 800x600.
  const b = new Uint8Array(30);
  b.set(enc.encode("RIFF"), 0);
  b[4] = 22; // chunk size (30 - 8)
  b.set(enc.encode("WEBP"), 8);
  b.set(enc.encode("VP8X"), 12);
  b[16] = 10; // VP8X chunk size
  // flags (20) + reserved (21..23) stay 0
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

function gifBytes(width = 800, height = 600): Uint8Array {
  const b = new Uint8Array(10);
  b.set(enc.encode("GIF89a"), 0);
  b[6] = width & 0xff; b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff; b[9] = (height >> 8) & 0xff;
  return b;
}

function assertAppError(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; statusCode?: number; message?: string };
    assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
    assert.equal(e.statusCode, status, `expected status ${status}, got ${e.statusCode}`);
    return;
  }
  assert.fail(`expected ${code} (${status}) but nothing was thrown`);
}

describe("media validation — magic bytes + dimensions", () => {
  it("PNG passes with IHDR dimensions", () => {
    const v = verifyMediaBytes(pngBytes(), "image/png");
    assert.equal(v.kind, "image");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
  });

  it("JPEG passes with SOF0 dimensions", () => {
    const v = verifyMediaBytes(jpegBytes(), "image/jpeg");
    assert.equal(v.kind, "image");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
  });

  it("WEBP (VP8X) passes with dimensions", () => {
    const v = verifyMediaBytes(webpBytes(), "image/webp");
    assert.equal(v.kind, "image");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
  });

  it("GIF passes with dimensions", () => {
    const v = verifyMediaBytes(gifBytes(), "image/gif");
    assert.equal(v.kind, "image");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
  });

  it("MP4 (ftyp), WebM (EBML), MP3 (ID3 + frame sync), WAV, OGG, PDF, ZIP pass", () => {
    const cases: Array<[Uint8Array, string]> = [
      [new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), "video/mp4"],
      [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]), "video/webm"],
      [enc.encode("ID3\x04\x00\x00\x00\x00\x00\x00"), "audio/mpeg"],
      [new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]), "audio/mpeg"],
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]), "audio/wav"],
      [enc.encode("OggS\x00\x02\x00\x00"), "audio/ogg"],
      [enc.encode("%PDF-1.7\n%test"), "application/pdf"],
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "application/zip"],
      [enc.encode("hello, world\n"), "text/plain"],
      [enc.encode("a,b\n1,2\n"), "text/csv"],
    ];
    for (const [bytes, mime] of cases) {
      const v = verifyMediaBytes(bytes, mime);
      assert.ok(v.kind, mime);
      assert.equal(v.width, null, mime);
      assert.equal(v.height, null, mime);
    }
  });

  it("wrong magic bytes are rejected with 415", () => {
    assertAppError(() => verifyMediaBytes(pngBytes(), "image/jpeg"), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => verifyMediaBytes(enc.encode("not a pdf at all"), "application/pdf"), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => verifyMediaBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), "video/mp4"), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => verifyMediaBytes(enc.encode("MZ fake exe"), "application/octet-stream"), "UNSUPPORTED_MEDIA_TYPE", 415);
  });

  it("unknown MIME is rejected with 415; empty file with 415", () => {
    assertAppError(() => verifyMediaBytes(enc.encode("hello"), "application/octet-stream"), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => verifyMediaBytes(new Uint8Array(0), "image/png"), "UNSUPPORTED_MEDIA_TYPE", 415);
  });

  it("text with NUL bytes or invalid UTF-8 is rejected", () => {
    assertAppError(() => verifyMediaBytes(new Uint8Array([0x68, 0x69, 0x00, 0x21]), "text/plain"), "UNSUPPORTED_MEDIA_TYPE", 415);
    assertAppError(() => verifyMediaBytes(new Uint8Array([0xff, 0xfe, 0xfd]), "text/plain"), "UNSUPPORTED_MEDIA_TYPE", 415);
  });

  it("files over the 100 MB library cap are rejected with 413", () => {
    assert.equal(MAX_MEDIA_BYTES, 100 * 1024 * 1024);
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
    assertAppError(() => verifyMediaBytes(big, "image/png"), "PAYLOAD_TOO_LARGE", 413);
  });
});

describe("media validation — SVG sanitize", () => {
  it("a clean SVG passes with viewBox dimensions", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><circle cx="10" cy="10" r="5"/></svg>`;
    const v = verifyMediaBytes(enc.encode(svg), "image/svg+xml");
    assert.equal(v.kind, "image");
    assert.equal(v.width, 800);
    assert.equal(v.height, 600);
    assert.equal(new TextDecoder().decode(v.bytes), svg);
  });

  it("script, event handlers, javascript: hrefs, foreignObject and DOCTYPE are stripped", () => {
    const nasty = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
<script>alert('xss')</script>
<a xlink:href="javascript:alert(1)"><text>click</text></a>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>
<circle cx="10" cy="10" r="5" onclick="evil()"/>
</svg>`;
    const clean = sanitizeSvgText(nasty);
    assert.ok(!clean.includes("<script"), "script removed");
    assert.ok(!clean.toLowerCase().includes("onload"), "onload removed");
    assert.ok(!clean.toLowerCase().includes("onclick"), "onclick removed");
    assert.ok(!clean.toLowerCase().includes("javascript:"), "javascript: href removed");
    assert.ok(!clean.includes("foreignObject"), "foreignObject removed");
    assert.ok(!clean.includes("DOCTYPE"), "DOCTYPE removed");
    assert.ok(clean.includes("<svg"), "svg root kept");
    assert.ok(clean.includes("<circle"), "presentation markup kept");
    const v = verifyMediaBytes(enc.encode(nasty), "image/svg+xml");
    assert.ok(!new TextDecoder().decode(v.bytes).includes("<script"), "stored bytes are sanitized");
  });

  it("non-SVG text declared as SVG is rejected", () => {
    assertAppError(() => verifyMediaBytes(enc.encode("<html><body>hi</body></html>"), "image/svg+xml"), "UNSUPPORTED_MEDIA_TYPE", 415);
  });
});

describe("media validation — folders, tags, filenames, keys", () => {
  it("normalizeFolder accepts root + nested lowercase paths, rejects traversal", () => {
    assert.equal(normalizeFolder(undefined), "");
    assert.equal(normalizeFolder(""), "");
    assert.equal(normalizeFolder("Brand/Logos"), "brand/logos");
    assertAppError(() => normalizeFolder("/leading"), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeFolder("trailing/"), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeFolder("a//b"), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeFolder("../escape"), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeFolder("has space"), "VALIDATION_ERROR", 422);
  });

  it("normalizeTags lowercases, dedupes, caps at 10", () => {
    assert.deepEqual(normalizeTags(["Logo", "logo", "BRAND"]), ["logo", "brand"]);
    assert.deepEqual(normalizeTags("a, b ,c"), ["a", "b", "c"]);
    assertAppError(() => normalizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`)), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeTags(["bad tag!"]), "VALIDATION_ERROR", 422);
  });

  it("normalizeFilename requires a real name", () => {
    // Display names keep spaces (they are what the user searches for);
    // only path separators / control chars are replaced.
    assert.equal(normalizeFilename("  My Photo.PNG "), "My Photo.PNG");
    assert.equal(normalizeFilename("a/b\\c.txt"), "a_b_c.txt");
    assertAppError(() => normalizeFilename("   "), "VALIDATION_ERROR", 422);
    assertAppError(() => normalizeFilename("..."), "VALIDATION_ERROR", 422);
  });

  it("mediaObjectKey is server-generated, namespaced by month, unique", () => {
    const a = mediaObjectKey("My Photo.PNG", new Date("2026-11-18T00:00:00Z"));
    const b = mediaObjectKey("My Photo.PNG", new Date("2026-11-18T00:00:00Z"));
    assert.ok(a.startsWith("media/2026/11/"), a);
    assert.ok(!a.includes("..") && !a.startsWith("/"), a);
    assert.notEqual(a, b);
  });

  it("mediaKindOfMime maps the allowlist and nothing else", () => {
    assert.equal(mediaKindOfMime("image/svg+xml"), "image");
    assert.equal(mediaKindOfMime("video/mp4"), "video");
    assert.equal(mediaKindOfMime("audio/mpeg"), "audio");
    assert.equal(mediaKindOfMime("application/pdf"), "document");
    assert.equal(mediaKindOfMime("application/zip"), "archive");
    assert.equal(mediaKindOfMime("text/csv"), "other");
    assert.equal(mediaKindOfMime("application/octet-stream"), null);
    assert.equal(mediaKindOfMime("image/x-icon"), null);
  });
});
