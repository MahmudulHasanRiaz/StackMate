/**
 * Media library (PLAN §31 / ADR-0011).
 *
 * HTTP-level tests against real Postgres; own fresh database
 * `stackmate_test_media`, dropped afterwards. Full dispatcher + real
 * Better Auth sign-in (same pattern as server-search.test.ts).
 *
 * Proves: multipart upload validation (magic bytes, 415), SVG
 * sanitization on read-back, server-side `q` over the FULL dataset
 * (the 55th file, beyond any first page), kind/folder/mime filters,
 * rename/move/tags, content serving (private objects, SVG sandbox
 * CSP), delete removes the row AND the object, migration permission
 * grants, and the Local driver round-trip (upload → file on disk →
 * content → delete removes the file).
 *
 * APP_ENV is "test" (not staging): the fail-closed rule blocks R2
 * uploads in staging/production when only the in-memory bucket is
 * bound, and this suite has no real R2 binding — the in-memory
 * bucket is the R2 stand-in here, exactly like the e2e suite.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { DATABASE_URL } from "./customer-order-helpers.ts";

const DB_NAME = "stackmate_test_media";
const API_BASE = "http://localhost:8787";
const ORIGIN = "http://localhost:8787";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const enc = new TextEncoder();

function pngBytes(): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0; b[9] = 0; b[10] = 0; b[11] = 13;
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b[16] = 0; b[17] = 0; b[18] = 0x03; b[19] = 0x20; // 800
  b[20] = 0; b[21] = 0; b[22] = 0x02; b[23] = 0x58; // 600
  return b;
}

/**
 * Minimal valid WebP (PLAN §34): RIFF header + WEBP tag, the rest
 * filled with "A" so range bodies are printable. Dimensions are
 * optional — verifyMediaBytes accepts a WebP without a VP8 chunk
 * (width/height null). The body is pure ASCII + NULs, so the test
 * helper's res.text() round-trips it byte-for-byte.
 */
function webpBytes(size = 20): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  const riffSize = size - 8;
  b[4] = riffSize & 0xff;
  b[5] = (riffSize >> 8) & 0xff;
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  for (let i = 12; i < size; i++) b[i] = 0x41; // "A"
  return b;
}

const NASTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><script>alert('xss')</script><circle cx="50" cy="50" r="40"/></svg>`;

describe.skipIf(!DATABASE_URL)("media library — upload, search, drivers", () => {
  let envTest: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let store: import("../src/platform/db/drizzle-store.ts").DrizzleStore;
  let adminClient: Client;
  let sessionCookie = "";
  let localRoot = "";
  let localRel = "";

  let pngId = "";
  let svgId = "";
  let pngObjectKey = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; rawBody?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; body: any; text: string }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    headers.set("Origin", ORIGIN);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.rawBody !== undefined) init.body = options.rawBody;
    const res = await app.fetch(new Request(`${API_BASE}${path}`, init), envTest);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  function cookiePairs(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    return setCookies.map((c) => c.split(";")[0]!).join("; ");
  }

  async function authed(
    path: string,
    options: { method?: string; body?: unknown; rawBody?: BodyInit; headers?: Record<string, string> } = {},
  ) {
    return apiRequest(path, { ...options, cookie: sessionCookie });
  }

  const dataOf = (res: { body: any }) => res.body.data;
  const itemsOf = (res: { body: any }) => res.body.data.items as any[];

  /** Multipart upload through the real dispatcher. */
  async function uploadFile(
    filename: string,
    bytes: Uint8Array,
    mime: string,
    extra?: {
      folder?: string;
      tags?: string[];
      /** Browser-generated WebP thumbnails (PLAN §34). */
      thumbnails?: { thumb?: Uint8Array; small?: Uint8Array };
    },
  ) {
    const form = new FormData();
    form.append("file", new File([bytes as unknown as BlobPart], filename, { type: mime }));
    if (extra?.folder !== undefined) form.append("folder", extra.folder);
    for (const tag of extra?.tags ?? []) form.append("tags", tag);
    if (extra?.thumbnails?.thumb) {
      form.append(
        "thumbnail",
        new File([extra.thumbnails.thumb as unknown as BlobPart], "thumbnail.webp", {
          type: "image/webp",
        }),
      );
    }
    if (extra?.thumbnails?.small) {
      form.append(
        "thumbnail_small",
        new File([extra.thumbnails.small as unknown as BlobPart], "thumbnail-small.webp", {
          type: "image/webp",
        }),
      );
    }
    return authed("/api/v1/admin/media", { method: "POST", rawBody: form });
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'.",
    );

    const { createStackMateApp } = await import("../src/app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${DB_NAME}"`);
    await maintenanceClient.end();

    const dbUrl = new URL(DATABASE_URL);
    dbUrl.pathname = `/${DB_NAME}`;

    const hex64 = "0123456789abcdef".repeat(4);
    envTest = resolveRuntimeConfig({
      APP_ENV: "test",
      BETTER_AUTH_SECRET: hex64,
      ENCRYPTION_KEY_V1: hex64,
      LICENSE_VERIFIER_SECRET: hex64,
      CHECKOUT_TOKEN_SECRET: hex64,
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl.toString() },
      BETTER_AUTH_URL: ORIGIN,
      TRUSTED_ORIGINS: ORIGIN,
      API_URL: ORIGIN,
      APP_URL: ORIGIN,
    });

    adminClient = new Client({ connectionString: dbUrl.toString() });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    store = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    app = createStackMateApp(store);

    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Media Test Admin",
        email: "media-test@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "media-test@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    sessionCookie = cookiePairs(signedIn.headers);
    assert.ok(sessionCookie.length > 0, "sign-in must set a session cookie");

    // M-5: the Local driver's root must be a RELATIVE path (an
    // absolute path is an arbitrary-directory write primitive from
    // the admin panel). The temp dir lives under the process working
    // directory and is passed to the API as a cwd-relative path; the
    // absolute form is kept for the on-disk assertions + cleanup.
    localRoot = await mkdtemp(path.join(process.cwd(), ".tmp-stackmate-media-"));
    localRel = path.relative(process.cwd(), localRoot);

    // Baseline files: one PNG (dimensions prove the header parser) + one
    // nasty SVG (sanitization is proved on read-back below).
    const png = await uploadFile("probe-image.png", pngBytes(), "image/png", {
      folder: "probes",
      tags: ["probe"],
    });
    assert.equal(png.status, 201, JSON.stringify(png.body));
    pngId = dataOf(png).id as string;
    assert.equal(dataOf(png).kind, "image");
    assert.equal(dataOf(png).width, 800);
    assert.equal(dataOf(png).height, 600);
    assert.equal(dataOf(png).driver, "r2");
    assert.ok((dataOf(png).content_url as string).includes(`/api/v1/admin/media/${pngId}/content`));
    const keyRow = await adminClient.query(
      "SELECT object_key FROM media_assets WHERE id = $1",
      [pngId],
    );
    pngObjectKey = keyRow.rows[0].object_key as string;
    assert.ok(pngObjectKey.startsWith("media/"), pngObjectKey);

    const svg = await uploadFile("probe-vector.svg", enc.encode(NASTY_SVG), "image/svg+xml", {
      folder: "probes",
    });
    assert.equal(svg.status, 201, JSON.stringify(svg.body));
    svgId = dataOf(svg).id as string;
  }, 180_000);

  afterAll(async () => {
    try {
      await store?.close();
    } catch {}
    try {
      await adminClient?.end();
    } catch {}
    try {
      if (localRoot) await rm(localRoot, { recursive: true, force: true });
    } catch {}
    try {
      const maintenanceUrl = new URL(DATABASE_URL!);
      maintenanceUrl.pathname = "/postgres";
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      await mc.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("storage settings default to the R2 driver", async () => {
    const res = await authed("/api/v1/admin/storage-settings");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(dataOf(res).driver, "r2");
    assert.equal(dataOf(res).local_path, null);
    assert.equal(dataOf(res).r2_bucket, "stackmate-private-assets");
  });

  it("upload with a disallowed type is rejected with 415", async () => {
    const res = await uploadFile("evil.exe", enc.encode("MZ fake exe"), "application/octet-stream");
    assert.equal(res.status, 415, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("upload with a mismatched magic signature is rejected with 415", async () => {
    const res = await uploadFile("fake.png", enc.encode("this is not a png"), "image/png");
    assert.equal(res.status, 415, JSON.stringify(res.body));
  });

  it("upload without a file is rejected with 422", async () => {
    const res = await authed("/api/v1/admin/media", {
      method: "POST",
      rawBody: new FormData(),
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  it("55 probe files upload; q finds the 55th by name (beyond any first page)", async () => {
    for (let i = 1; i <= 55; i++) {
      const n = String(i).padStart(2, "0");
      const res = await uploadFile(
        `MediaProbe ${n}.txt`,
        enc.encode(`probe file ${n}\n`),
        "text/plain",
        { folder: "probes", tags: ["probe", `p${n}`] },
      );
      assert.equal(res.status, 201, `probe ${n}: ${JSON.stringify(res.body)}`);
    }
    const res = await authed("/api/v1/admin/media?q=" + encodeURIComponent("mediaprobe 55"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = itemsOf(res);
    assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
    assert.equal(items[0].original_filename, "MediaProbe 55.txt");
  });

  it("q finds the 55th file by tag; q + limit caps AFTER filtering", async () => {
    const byTag = await authed("/api/v1/admin/media?q=p55");
    assert.equal(byTag.status, 200, JSON.stringify(byTag.body));
    assert.equal(itemsOf(byTag).length, 1);
    assert.equal(itemsOf(byTag)[0].original_filename, "MediaProbe 55.txt");

    const capped = await authed("/api/v1/admin/media?q=mediaprobe&limit=2");
    assert.equal(capped.status, 200, JSON.stringify(capped.body));
    assert.equal(itemsOf(capped).length, 2);
    assert.equal(dataOf(capped).total, 55);
  });

  it("kind + folder + mime filters run server-side", async () => {
    const images = await authed("/api/v1/admin/media?kind=image&limit=100");
    assert.equal(images.status, 200, JSON.stringify(images.body));
    assert.equal(dataOf(images).total, 2);
    assert.ok(itemsOf(images).every((i: any) => i.kind === "image"));

    const others = await authed("/api/v1/admin/media?kind=other&limit=100");
    assert.equal(dataOf(others).total, 55);

    const folder = await authed("/api/v1/admin/media?folder=probes&limit=100");
    assert.equal(dataOf(folder).total, 57);

    const mime = await authed("/api/v1/admin/media?mime=image%2Fsvg%2Bxml");
    assert.equal(dataOf(mime).total, 1);
    assert.equal(itemsOf(mime)[0].id, svgId);

    const badMime = await authed("/api/v1/admin/media?mime=application%2Foctet-stream");
    assert.equal(badMime.status, 422, JSON.stringify(badMime.body));
  });

  it("folders list contains the probe folder; unfiltered list totals 57", async () => {
    const folders = await authed("/api/v1/admin/media/folders");
    assert.equal(folders.status, 200, JSON.stringify(folders.body));
    assert.ok((dataOf(folders).folders as string[]).includes("probes"));
    const all = await authed("/api/v1/admin/media?limit=100");
    assert.equal(dataOf(all).total, 57);
  });

  it("detail, rename, move and tags round-trip", async () => {
    const detail = await authed(`/api/v1/admin/media/${svgId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).original_filename, "probe-vector.svg");

    const renamed = await authed(`/api/v1/admin/media/${svgId}`, {
      method: "PATCH",
      body: { original_filename: "renamed-vector.svg" },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(dataOf(renamed).original_filename, "renamed-vector.svg");

    const moved = await authed(`/api/v1/admin/media/${svgId}`, {
      method: "PATCH",
      body: { folder: "brand/logos" },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(dataOf(moved).folder, "brand/logos");

    const tagged = await authed(`/api/v1/admin/media/${svgId}`, {
      method: "PATCH",
      body: { tags: ["logo", "brand"] },
    });
    assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
    assert.deepEqual(dataOf(tagged).tags, ["logo", "brand"]);

    const folders = await authed("/api/v1/admin/media/folders");
    assert.ok((dataOf(folders).folders as string[]).includes("brand/logos"));

    const empty = await authed(`/api/v1/admin/media/${svgId}`, {
      method: "PATCH",
      body: {},
    });
    assert.equal(empty.status, 422, JSON.stringify(empty.body));

    const badFolder = await authed(`/api/v1/admin/media/${svgId}`, {
      method: "PATCH",
      body: { folder: "../escape" },
    });
    assert.equal(badFolder.status, 422, JSON.stringify(badFolder.body));
  });

  it("content serves the stored bytes; SVG is sanitized + sandboxed", async () => {
    const png = await authed(`/api/v1/admin/media/${pngId}/content`);
    assert.equal(png.status, 200, JSON.stringify(png.body));
    assert.equal(png.headers.get("Content-Type"), "image/png");
    assert.ok(png.text.length > 0, "content must not be empty");

    const svg = await authed(`/api/v1/admin/media/${svgId}/content`);
    assert.equal(svg.status, 200, JSON.stringify(svg.body));
    assert.equal(svg.headers.get("Content-Type"), "image/svg+xml");
    assert.equal(svg.headers.get("Content-Security-Policy"), "sandbox");
    assert.ok(!svg.text.includes("<script"), "stored SVG must not contain <script>");
    assert.ok(!svg.text.toLowerCase().includes("onload"), "stored SVG must not contain onload");
    assert.ok(svg.text.includes("<svg"), "stored SVG keeps its root");
    assert.ok(svg.text.includes("<circle"), "stored SVG keeps presentation markup");
  });

  // PLAN §34 fixtures (shared across the thumbnail tests below, in
  // declaration order — the suite already depends on order).
  let thumbAssetId = "";
  let thumbEtag = "";
  let noThumbAssetId = "";

  it("upload with thumbnails stores them; variant content returns the WebP bytes", async () => {
    const res = await uploadFile("thumb-probe.png", pngBytes(), "image/png", {
      folder: "probes",
      thumbnails: { thumb: webpBytes(20), small: webpBytes(16) },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const view = dataOf(res);
    thumbAssetId = view.id as string;
    assert.ok((view.thumb_url as string).endsWith("?variant=thumb"), view.thumb_url);
    assert.ok((view.thumb_small_url as string).endsWith("?variant=small"), view.thumb_small_url);

    const thumbRes = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=thumb`);
    assert.equal(thumbRes.status, 200, JSON.stringify(thumbRes.body));
    assert.equal(thumbRes.headers.get("Content-Type"), "image/webp");
    assert.equal(thumbRes.text.length, 20, "thumb must serve exactly the 20 thumbnail bytes");
    assert.ok(thumbRes.text.startsWith("RIFF"), "thumb bytes must be the WebP fixture");
    assert.ok(
      (thumbRes.headers.get("ETag") ?? "").endsWith("-thumb-320\""),
      `thumb ETag must end -thumb-320", got ${thumbRes.headers.get("ETag")}`,
    );
    assert.equal(thumbRes.headers.get("Accept-Ranges"), "bytes");

    const smallRes = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=small`);
    assert.equal(smallRes.status, 200, JSON.stringify(smallRes.body));
    assert.equal(smallRes.headers.get("Content-Type"), "image/webp");
    assert.equal(smallRes.text.length, 16);
    assert.ok(
      (smallRes.headers.get("ETag") ?? "").endsWith("-thumb-64\""),
      `small ETag must end -thumb-64", got ${smallRes.headers.get("ETag")}`,
    );

    const orig = await authed(`/api/v1/admin/media/${thumbAssetId}/content`);
    assert.equal(orig.status, 200, JSON.stringify(orig.body));
    assert.equal(orig.headers.get("Content-Type"), "image/png");
    thumbEtag = orig.headers.get("ETag") ?? "";
    assert.ok(
      /^"[0-9a-f]{64}"$/.test(thumbEtag),
      `original ETag must be the quoted checksum, got ${thumbEtag}`,
    );

    const bogus = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=bogus`);
    assert.equal(bogus.status, 422, JSON.stringify(bogus.body));
  });

  it("Range requests return 206 + Content-Range; unsatisfiable ranges get 416", async () => {
    const first = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=thumb`, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(first.status, 206, JSON.stringify(first.body));
    assert.equal(first.headers.get("Content-Range"), "bytes 0-3/20");
    assert.equal(first.headers.get("Content-Length"), "4");
    assert.equal(first.text, "RIFF");

    const tail = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=thumb`, {
      headers: { Range: "bytes=-4" },
    });
    assert.equal(tail.status, 206, JSON.stringify(tail.body));
    assert.equal(tail.headers.get("Content-Range"), "bytes 16-19/20");
    assert.equal(tail.text, "AAAA");

    // Open-ended range on the 24-byte original: 20..23.
    const openEnded = await authed(`/api/v1/admin/media/${thumbAssetId}/content`, {
      headers: { Range: "bytes=20-" },
    });
    assert.equal(openEnded.status, 206, JSON.stringify(openEnded.body));
    assert.equal(openEnded.headers.get("Content-Range"), "bytes 20-23/24");
    assert.equal(openEnded.headers.get("Content-Length"), "4");

    // Start at exactly the size of the 20-byte thumbnail: unsatisfiable.
    const beyond = await authed(`/api/v1/admin/media/${thumbAssetId}/content?variant=thumb`, {
      headers: { Range: "bytes=20-" },
    });
    assert.equal(beyond.status, 416, JSON.stringify(beyond.body));
    assert.equal(beyond.headers.get("Content-Range"), "bytes */20");
  });

  it("If-None-Match returns 304 without a body", async () => {
    assert.ok(thumbEtag.length > 0, "previous test must have captured the original ETag");
    const res = await authed(`/api/v1/admin/media/${thumbAssetId}/content`, {
      headers: { "If-None-Match": thumbEtag },
    });
    assert.equal(res.status, 304, JSON.stringify(res.body));
    assert.equal(res.text, "");
    const star = await authed(`/api/v1/admin/media/${thumbAssetId}/content`, {
      headers: { "If-None-Match": "*" },
    });
    assert.equal(star.status, 304, JSON.stringify(star.body));
    const miss = await authed(`/api/v1/admin/media/${thumbAssetId}/content`, {
      headers: { "If-None-Match": "\"deadbeef\"" },
    });
    assert.equal(miss.status, 200, JSON.stringify(miss.body));
  });

  it("upload without thumbnails has null thumb URLs; variant content is 404; a bad thumbnail is dropped", async () => {
    const plain = await uploadFile("no-thumb.png", pngBytes(), "image/png", { folder: "probes" });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    noThumbAssetId = dataOf(plain).id as string;
    assert.equal(dataOf(plain).thumb_url, null);
    assert.equal(dataOf(plain).thumb_small_url, null);
    const variant = await authed(`/api/v1/admin/media/${noThumbAssetId}/content?variant=thumb`);
    assert.equal(variant.status, 404, JSON.stringify(variant.body));

    const bad = await uploadFile("bad-thumb.png", pngBytes(), "image/png", {
      folder: "probes",
      thumbnails: { thumb: pngBytes() }, // PNG bytes declared as WebP — wrong magic
    });
    assert.equal(bad.status, 201, JSON.stringify(bad.body));
    assert.equal(dataOf(bad).thumb_url, null, "a bad thumbnail must not fail the upload");
  });

  it("regenerate endpoint adds thumbnails to a thumb-less asset; rejects SVG and bad bytes", async () => {
    const form = new FormData();
    form.append(
      "thumbnail",
      new File([webpBytes(20) as unknown as BlobPart], "thumbnail.webp", { type: "image/webp" }),
    );
    form.append(
      "thumbnail_small",
      new File([webpBytes(16) as unknown as BlobPart], "thumbnail-small.webp", {
        type: "image/webp",
      }),
    );
    const res = await authed(`/api/v1/admin/media/${noThumbAssetId}/thumbnail`, {
      method: "POST",
      rawBody: form,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok((dataOf(res).thumb_url as string).endsWith("?variant=thumb"));
    assert.ok((dataOf(res).thumb_small_url as string).endsWith("?variant=small"));
    const after = await authed(`/api/v1/admin/media/${noThumbAssetId}/content?variant=thumb`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.text.length, 20);

    const svgForm = new FormData();
    svgForm.append(
      "thumbnail",
      new File([webpBytes(20) as unknown as BlobPart], "thumbnail.webp", { type: "image/webp" }),
    );
    const svgRes = await authed(`/api/v1/admin/media/${svgId}/thumbnail`, {
      method: "POST",
      rawBody: svgForm,
    });
    assert.equal(svgRes.status, 422, JSON.stringify(svgRes.body));

    const badForm = new FormData();
    badForm.append(
      "thumbnail",
      new File([pngBytes() as unknown as BlobPart], "thumbnail.webp", { type: "image/webp" }),
    );
    const badRes = await authed(`/api/v1/admin/media/${noThumbAssetId}/thumbnail`, {
      method: "POST",
      rawBody: badForm,
    });
    assert.equal(badRes.status, 415, JSON.stringify(badRes.body));
  });

  it("delete removes the thumbnail objects too", async () => {
    const keyRow = await adminClient.query(
      "SELECT thumb_object_key, thumb_small_object_key FROM media_assets WHERE id = $1",
      [thumbAssetId],
    );
    const thumbKey = keyRow.rows[0].thumb_object_key as string;
    const smallKey = keyRow.rows[0].thumb_small_object_key as string;
    assert.ok(thumbKey.endsWith("-thumb-320.webp"), thumbKey);
    assert.ok(smallKey.endsWith("-thumb-64.webp"), smallKey);
    assert.ok((await store.r2Bucket.get(thumbKey)) !== null, "thumb object must exist before delete");
    assert.ok(
      (await store.r2Bucket.get(smallKey)) !== null,
      "small thumb object must exist before delete",
    );
    const res = await authed(`/api/v1/admin/media/${thumbAssetId}`, { method: "DELETE" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await store.r2Bucket.get(thumbKey), null, "thumb object must be gone after delete");
    assert.equal(
      await store.r2Bucket.get(smallKey),
      null,
      "small thumb object must be gone after delete",
    );
  });

  it("delete removes the row AND the object", async () => {
    const before = await store.r2Bucket.get(pngObjectKey);
    assert.ok(before !== null, "object must exist before delete");
    const res = await authed(`/api/v1/admin/media/${pngId}`, { method: "DELETE" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const detail = await authed(`/api/v1/admin/media/${pngId}`);
    assert.equal(detail.status, 404, JSON.stringify(detail.body));
    const content = await authed(`/api/v1/admin/media/${pngId}/content`);
    assert.equal(content.status, 404, JSON.stringify(content.body));
    const after = await store.r2Bucket.get(pngObjectKey);
    assert.equal(after, null, "object must be gone from storage after delete");
    const row = await adminClient.query("SELECT id FROM media_assets WHERE id = $1", [pngId]);
    assert.equal(row.rowCount, 0, "row must be gone from the database");
  });

  it("migration grants: super_admin/admin/support_staff get both, read_only gets view only", async () => {
    const res = await adminClient.query(
      `SELECT r.key AS role, p.key AS permission
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.key IN ('media.view', 'media.manage')
        ORDER BY r.key, p.key`,
    );
    const grants = new Set(res.rows.map((row) => `${row.role}:${row.permission}`));
    for (const role of ["super_admin", "admin", "support_staff"]) {
      assert.ok(grants.has(`${role}:media.view`), `${role} needs media.view`);
      assert.ok(grants.has(`${role}:media.manage`), `${role} needs media.manage`);
    }
    assert.ok(grants.has("read_only:media.view"), "read_only needs media.view");
    assert.ok(!grants.has("read_only:media.manage"), "read_only must NOT have media.manage");
    for (const role of ["finance_manager", "license_manager", "product_manager", "marketing_manager"]) {
      assert.ok(!grants.has(`${role}:media.view`), `${role} must NOT have media.view`);
    }
  });

  it("Local driver round-trip: upload lands on disk, reads back, delete removes the file", async () => {
    const switched = await authed("/api/v1/admin/storage-settings", {
      method: "PUT",
      body: { driver: "local", local_path: localRel },
    });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(dataOf(switched).driver, "local");

    const up = await uploadFile("local-note.txt", enc.encode("local driver file\n"), "text/plain", {
      folder: "local-tests",
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const localId = dataOf(up).id as string;
    assert.equal(dataOf(up).driver, "local");
    const keyRow = await adminClient.query(
      "SELECT object_key FROM media_assets WHERE id = $1",
      [localId],
    );
    const objectKey = keyRow.rows[0].object_key as string;
    const onDisk = await stat(path.join(localRoot, objectKey));
    assert.ok(onDisk.isFile(), "uploaded file must exist under the local root");
    assert.equal(
      await readFile(path.join(localRoot, objectKey), "utf8"),
      "local driver file\n",
    );

    const content = await authed(`/api/v1/admin/media/${localId}/content`);
    assert.equal(content.status, 200, JSON.stringify(content.body));
    assert.equal(content.text, "local driver file\n");

    const del = await authed(`/api/v1/admin/media/${localId}`, { method: "DELETE" });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await assert.rejects(stat(path.join(localRoot, objectKey)), "file must be gone after delete");

    const back = await authed("/api/v1/admin/storage-settings", {
      method: "PUT",
      body: { driver: "r2", local_path: null },
    });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(dataOf(back).driver, "r2");
  });

  it("unauthenticated list is rejected with 401", async () => {
    const res = await apiRequest("/api/v1/admin/media");
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it("M-23(b): PATCH avatar_url accepts a media-library content URL", async () => {
    // Moved from api-core-batch.test.ts (2026-11-20): the media library
    // requires a database, so this test cannot run in that in-memory
    // suite. Same 1x1 transparent PNG as the api-core-batch M-23 test.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
      0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
      0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
      0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
      0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
      0x60, 0x82,
    ]);
    const uploaded = await uploadFile("library-avatar.png", png, "image/png");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const contentUrl = uploaded.body.data.content_url as string;
    assert.ok(contentUrl.startsWith("/api/v1/admin/media/"), contentUrl);

    // The content URL resolves to the stored object key (never a URL).
    const set = await authed("/api/v1/admin/me", {
      method: "PATCH",
      body: { avatar_url: contentUrl },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const key = set.body.data.avatar_url as string;
    assert.equal(typeof key, "string");
    assert.ok(!key.startsWith("/api/") && !key.startsWith("http"), key);
    assert.notEqual(key, contentUrl);

    // The resolved key serves through GET /me/avatar.
    const served = await authed("/api/v1/admin/me/avatar");
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.headers.get("Content-Type"), "image/png");

    // A non-image library asset is rejected, and an unknown media id 404s.
    const txtUploaded = await uploadFile(
      "notes.txt",
      new TextEncoder().encode("hello"),
      "text/plain",
    );
    assert.equal(txtUploaded.status, 201, JSON.stringify(txtUploaded.body));
    const badKind = await authed("/api/v1/admin/me", {
      method: "PATCH",
      body: { avatar_url: txtUploaded.body.data.content_url },
    });
    assert.equal(badKind.status, 422, JSON.stringify(badKind.body));
    const missing = await authed("/api/v1/admin/me", {
      method: "PATCH",
      body: { avatar_url: "/api/v1/admin/media/00000000-0000-0000-0000-000000000000/content" },
    });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));

    // Leave the account clean for later tests.
    const cleared = await authed("/api/v1/admin/me", {
      method: "PATCH",
      body: { avatar_url: null },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  });
});
