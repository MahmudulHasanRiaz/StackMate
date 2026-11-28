/**
 * Media-library file validation (PLAN §31 / ADR-0011, Security §4.9).
 *
 * The library accepts an ALLOWLIST of types only — every accepted type
 * is validated by magic bytes (never by extension or declared MIME
 * alone). This extends, not replaces, the evidence validation in
 * r2.ts (which stays PNG/JPEG/WEBP/PDF, 5 MB).
 *
 * SVG is XML text: it must parse as SVG markup and is SANITIZED on
 * upload (no <script>, no on* handlers, no javascript:/data:text hrefs,
 * no <foreignObject>, no DOCTYPE) — the STORED bytes are the sanitized
 * bytes, so a stored SVG can never carry an active payload even if it
 * is later served top-level (the content endpoint additionally serves
 * SVG with a sandbox CSP header; previews use <img> only).
 *
 * Image dimensions are parsed from the file headers (PNG/JPEG/WEBP/GIF
 * + SVG viewBox/attributes) — best-effort, null when unparseable; a
 * valid magic match with unparseable dimensions still stores.
 */
import { AppError } from "../../shared/errors.ts";
import { sanitizeFilename } from "./r2.ts";

/** Library per-file cap (ADR-0011): 100 MB. The 5 MB evidence cap is a different flow and is untouched. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * Per-thumbnail cap (audit L-11): a 320px / 64px WebP is tens of KB
 * at most — 1 MB is generous. A "thumbnail" bigger than this is not
 * a thumbnail; it is dropped on upload (logged by the service) and
 * rejected on regenerate, where the thumbnail IS the request.
 */
export const MAX_THUMBNAIL_BYTES = 1 * 1024 * 1024;

export type MediaKind = "image" | "video" | "audio" | "document" | "archive" | "other";

/** mime → kind. Anything not in this map is rejected with 415. */
export const MEDIA_ALLOWED_MIME: Readonly<Record<string, MediaKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/svg+xml": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/ogg": "audio",
  "application/pdf": "document",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "text/plain": "other",
  "text/csv": "other",
};

export function mediaKindOfMime(mime: string): MediaKind | null {
  return MEDIA_ALLOWED_MIME[mime.trim().toLowerCase()] ?? null;
}

const MEDIA_TYPE_LABELS: Readonly<Record<string, string>> = {
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/webp": "WebP image",
  "image/gif": "GIF image",
  "image/svg+xml": "SVG image",
  "video/mp4": "MP4 video",
  "video/webm": "WebM video",
  "audio/mpeg": "MP3 audio",
  "audio/wav": "WAV audio",
  "audio/x-wav": "WAV audio",
  "audio/ogg": "OGG audio",
  "application/pdf": "PDF document",
  "application/zip": "ZIP archive",
  "application/x-zip-compressed": "ZIP archive",
  "text/plain": "Text file",
  "text/csv": "CSV file",
};

export function mediaTypeLabel(mime: string): string {
  return MEDIA_TYPE_LABELS[mime.trim().toLowerCase()] ?? mime;
}

function unsupported(mime: string): AppError {
  return new AppError(
    "UNSUPPORTED_MEDIA_TYPE",
    `Unsupported content type '${mime}'. Allowed: PNG, JPEG, WEBP, GIF, SVG, MP4, WebM, MP3, WAV, OGG, PDF, ZIP, plain text, CSV.`,
    415,
  );
}

function badSignature(mime: string, expected: string): AppError {
  return new AppError(
    "UNSUPPORTED_MEDIA_TYPE",
    `File signature does not match ${expected} (${mediaTypeLabel(mime)}).`,
    415,
  );
}

function u16le(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function u16be(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

function u32be(b: Uint8Array, off: number): number {
  return (b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!;
}

/** PNG: IHDR width/height are big-endian uint32 at offsets 16 / 20. */
function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF: width/height are little-endian uint16 at offsets 6 / 8. */
function parseGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 10) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** JPEG: scan segments for a Start-Of-Frame marker (0xC0–0xCF except 0xC4/0xC8/0xCC); height/width follow the length + precision bytes. */
function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let off = 2;
  while (off + 9 < bytes.byteLength) {
    if (bytes[off] !== 0xff) return null;
    const marker = bytes[off + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) return null; // start of scan — no SOF before it
    const segLen = u16be(bytes, off + 2);
    if (segLen < 2 || off + 2 + segLen > bytes.byteLength) return null;
    if (
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
    ) {
      return { width: u16be(bytes, off + 7), height: u16be(bytes, off + 5) };
    }
    off += 2 + segLen;
  }
  return null;
}

/** WebP: VP8X (width-1/height-1, 24-bit LE at 24/27), VP8L (14-bit at 21/23), lossy VP8 (14-bit at 26/28 after the 0x9D012A keyframe tag). */
function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 30) return null;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === "VP8X") {
    const w = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const h = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { width: w, height: h };
  }
  if (chunk === "VP8L") {
    const b = bytes;
    const w = ((b[21]! | ((b[22]! & 0x3f) << 8)) + 1);
    const h = (((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)) + 1);
    return { width: w, height: h };
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const w = (bytes[26]! | ((bytes[27]! & 0x3f) << 8));
    const h = (((bytes[27]! >> 6) | (bytes[28]! << 2) | ((bytes[29]! & 0x0f) << 10)));
    return { width: w, height: h };
  }
  return null;
}

/** SVG: width/height attributes (px numbers) or the viewBox's 3rd/4th values. Best-effort. */
function parseSvgDimensions(text: string): { width: number; height: number } | null {
  const svgTag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  if (!svgTag) return null;
  const attr = (name: string): number | null => {
    const m = svgTag.match(new RegExp(`${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)(?:px)?["']`, "i"));
    if (!m) return null;
    const n = Math.round(Number(m[1]));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = attr("width");
  const h = attr("height");
  if (w !== null && h !== null) return { width: w, height: h };
  const vb = svgTag.match(/viewBox\s*=\s*["']([0-9.\s-]+)["']/i)?.[1];
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const vw = Math.round(parts[2]!);
      const vh = Math.round(parts[3]!);
      if (vw > 0 && vh > 0) return { width: vw, height: vh };
    }
  }
  return null;
}

export function parseImageDimensions(
  bytes: Uint8Array,
  mime: string,
  svgText?: string,
): { width: number; height: number } | null {
  switch (mime) {
    case "image/png":
      return parsePngDimensions(bytes);
    case "image/jpeg":
      return parseJpegDimensions(bytes);
    case "image/webp":
      return parseWebpDimensions(bytes);
    case "image/gif":
      return parseGifDimensions(bytes);
    case "image/svg+xml":
      return svgText ? parseSvgDimensions(svgText) : null;
    default:
      return null;
  }
}

/**
 * Parser-based SVG sanitizer (audit L-8). The old implementation was a
 * set of regexes over raw markup — regexes cannot parse XML, so a
 * crafted payload could slip past them in principle (nested tags,
 * entity-encoded schemes, `<style>`/`<animate>` event attributes,
 * nested `data:image/svg+xml`).
 *
 * This is a strict XML tokenizer + tree builder:
 * - The document must be WELL-FORMED XML (matching tags, quoted
 *   attribute values, no stray `<` in text, no DOCTYPE with an
 *   internal subset — ENTITY declarations / XXE live there; a bare
 *   DOCTYPE is stripped). Anything malformed is REJECTED (415),
 *   exactly as a browser parsing the file as `image/svg+xml` would
 *   reject it. What this accepts, a browser parses the same way —
 *   there is no gap between the sanitizer's view and the renderer's
 *   view.
 * - Only allowlisted ELEMENTS survive (presentation + structure);
 *   everything else — <script>, <style>, <foreignObject>, <iframe>,
 *   <animate>/<set> (SMIL can carry event attributes), <link>,
 *   <object>, <embed>, … — is dropped WITH its children.
 * - Only allowlisted ATTRIBUTES survive; `style` and every `on*`
 *   handler are gone by construction (they are not in the list).
 * - `href`/`xlink:href` values are checked AFTER entity-decoding:
 *   only `#fragment` references, `data:image/png|jpeg|gif|webp`
 *   (raster only — never `data:image/svg+xml`, which could nest a
 *   second SVG with its own script), and `http(s):` on `<a>` only.
 * - The output is RE-SERIALIZED from the tree (attributes and text
 *   re-escaped), so the stored bytes are exactly the parsed tree —
 *   nothing from the raw upload survives unexamined.
 */
const SVG_MAX_DEPTH = 100;
const SVG_MAX_NODES = 200_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

const SVG_ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "title", "desc", "metadata",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath",
  "use", "symbol", "clippath", "mask",
  "lineargradient", "radialgradient", "stop", "pattern", "marker",
  "switch", "a", "image",
]);

const SVG_ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "id", "class", "role", "aria-label", "aria-hidden", "lang", "xml:space",
  "xmlns", "xmlns:xlink", "version", "baseprofile",
  "viewbox", "preserveaspectratio", "width", "height", "x", "y",
  "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity", "color", "stop-color", "stop-opacity",
  "transform", "clip-path", "clip-rule", "mask",
  "gradientunits", "gradienttransform", "spreadmethod",
  "patternunits", "patterncontentunits", "patterntransform",
  "markerwidth", "markerheight", "refx", "refy", "orient", "markerunits",
  "offset",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "alignment-baseline",
  "letter-spacing", "word-spacing", "textlength", "lengthadjust",
  "startoffset",
  "display", "visibility", "overflow",
  "href", "xlink:href",
]);

/** Elements whose href/xlink:href is meaningful (and therefore allowed, value-checked). */
const SVG_HREF_ELEMENTS: ReadonlySet<string> = new Set(["a", "use", "image", "textpath"]);

type SvgNode =
  | { kind: "text"; value: string }
  | {
      kind: "element";
      name: string;
      attrs: Array<{ name: string; value: string }>;
      children: SvgNode[];
    };

function svgError(message: string): AppError {
  return new AppError("UNSUPPORTED_MEDIA_TYPE", message, 415);
}

/** Strict XML entity decoding — an unknown or malformed reference is rejected, never passed through. */
function decodeXmlEntities(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi === -1 || semi - amp > 12) {
      throw svgError("Invalid SVG: malformed entity reference.");
    }
    const body = raw.slice(amp + 1, semi);
    if (body === "amp") out += "&";
    else if (body === "lt") out += "<";
    else if (body === "gt") out += ">";
    else if (body === "quot") out += '"';
    else if (body === "apos") out += "'";
    else if (/^#\d+$/.test(body) || /^#x[0-9a-fA-F]+$/.test(body)) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        throw svgError("Invalid SVG: invalid numeric character reference.");
      }
      out += String.fromCodePoint(code);
    } else {
      throw svgError(`Invalid SVG: unknown entity '&${body};'.`);
    }
    i = semi + 1;
  }
  return out;
}

function escapeSvgText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeSvgAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Reference-value gate, applied AFTER entity decoding (catches `java&#115;cript:` etc.). */
function isSafeSvgReference(elementLower: string, rawValue: string): boolean {
  // Browsers strip ASCII control characters from a URL before
  // reading its scheme — do the same before judging it.
  const value = rawValue.replace(/[\x00-\x20]/g, "");
  if (value.startsWith("#")) return true;
  const lower = value.toLowerCase();
  if (elementLower === "a" && (lower.startsWith("http://") || lower.startsWith("https://"))) {
    return true;
  }
  if (
    elementLower === "image" &&
    /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)
  ) {
    return true;
  }
  return false;
}

/** Strict XML tokenizer + tree builder. Throws 415 on anything malformed. */
function parseSvgDocument(text: string): SvgNode {
  const len = text.length;
  let pos = 0;
  let nodeCount = 0;

  function fail(msg: string): never {
    throw svgError(`Invalid SVG: ${msg}`);
  }

  function skipWhitespace(): void {
    while (pos < len && /\s/.test(text[pos]!)) pos += 1;
  }

  /**
   * A bare DOCTYPE (`<!DOCTYPE svg PUBLIC "…" "…">`) is legal XML and
   * carries no entities — it is STRIPPED (the existing contract:
   * the media-validation suite expects it gone, not rejected).
   * A DOCTYPE WITH an internal subset (`<!DOCTYPE … [ <!ENTITY …> ]>`)
   * is where ENTITY declarations / XXE live — that is REJECTED.
   */
  function skipDoctype(): void {
    const end = text.indexOf(">", pos + 9);
    if (end === -1) fail("unterminated DOCTYPE");
    if (text.slice(pos, end).includes("[")) {
      fail("DOCTYPE with an internal subset (ENTITY declarations) is not allowed");
    }
    pos = end + 1;
  }

  function readName(): string {
    const start = pos;
    if (pos < len && /[A-Za-z_:]/.test(text[pos]!)) pos += 1;
    while (pos < len && /[A-Za-z0-9_.:-]/.test(text[pos]!)) pos += 1;
    if (pos === start) fail("expected a name");
    return text.slice(start, pos);
  }

  function parseText(): SvgNode {
    const start = pos;
    while (pos < len && text[pos] !== "<") pos += 1;
    const raw = text.slice(start, pos);
    nodeCount += 1;
    if (nodeCount > SVG_MAX_NODES) fail("too many nodes");
    return { kind: "text", value: decodeXmlEntities(raw) };
  }

  function parseElement(depth: number): SvgNode {
    if (depth > SVG_MAX_DEPTH) fail("nesting too deep");
    // text[pos] === "<", next char starts a name.
    pos += 1;
    const name = readName();
    const attrs: Array<{ name: string; value: string }> = [];
    const seenAttrs = new Set<string>();
    for (;;) {
      skipWhitespace();
      if (pos >= len) fail(`unclosed tag <${name}>`);
      if (text.startsWith("/>", pos)) {
        pos += 2;
        nodeCount += 1;
        if (nodeCount > SVG_MAX_NODES) fail("too many nodes");
        return { kind: "element", name, attrs, children: [] };
      }
      if (text[pos] === ">") {
        pos += 1;
        break;
      }
      if (text[pos] === "/" || text[pos] === "<" || text[pos] === "=") {
        fail(`malformed tag <${name}>`);
      }
      const attrName = readName();
      const attrLower = attrName.toLowerCase();
      if (seenAttrs.has(attrLower)) fail(`duplicate attribute '${attrName}'`);
      seenAttrs.add(attrLower);
      skipWhitespace();
      if (text[pos] !== "=") fail(`attribute '${attrName}' has no value`);
      pos += 1;
      skipWhitespace();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") {
        fail(`attribute '${attrName}' value must be quoted`);
      }
      pos += 1;
      const valueStart = pos;
      while (pos < len && text[pos] !== quote) pos += 1;
      if (pos >= len) fail(`unterminated attribute '${attrName}'`);
      const rawValue = text.slice(valueStart, pos);
      pos += 1;
      attrs.push({ name: attrName, value: decodeXmlEntities(rawValue) });
    }
    const children: SvgNode[] = [];
    for (;;) {
      if (pos >= len) fail(`unclosed element <${name}>`);
      if (text.startsWith(`</`, pos)) {
        pos += 2;
        const closeName = readName();
        skipWhitespace();
        if (text[pos] !== ">") fail(`malformed closing tag </${closeName}>`);
        pos += 1;
        if (closeName.toLowerCase() !== name.toLowerCase()) {
          fail(`mismatched closing tag </${closeName}> for <${name}>`);
        }
        nodeCount += 1;
        if (nodeCount > SVG_MAX_NODES) fail("too many nodes");
        return { kind: "element", name, attrs, children };
      }
      if (text.startsWith("<!--", pos)) {
        const end = text.indexOf("-->", pos + 4);
        if (end === -1) fail("unterminated comment");
        pos = end + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", pos)) {
        const end = text.indexOf("]]>", pos + 9);
        if (end === -1) fail("unterminated CDATA section");
        // CDATA content is literal text (no entity decoding) — correct
        // XML semantics; it is escaped on serialization.
        nodeCount += 1;
        if (nodeCount > SVG_MAX_NODES) fail("too many nodes");
        children.push({ kind: "text", value: text.slice(pos + 9, end) });
        pos = end + 3;
        continue;
      }
      if (text.startsWith("<!", pos)) fail("DOCTYPE and other declarations are not allowed");
      if (text.startsWith("<?", pos)) fail("processing instructions are not allowed");
      if (text[pos] === "<") {
        children.push(parseElement(depth + 1));
        continue;
      }
      children.push(parseText());
    }
  }

  // Document prologue: optional BOM, XML declaration, comments,
  // and a bare DOCTYPE (stripped — see skipDoctype).
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  for (;;) {
    skipWhitespace();
    if (text.startsWith("<?xml", pos)) {
      // The declaration is `<?xml` + whitespace (`<?xml version=…?>`).
      // `<?xml-stylesheet …?>` is a PROCESSING INSTRUCTION, not the
      // declaration — it must be rejected, not skipped.
      const after = text[pos + 5];
      if (after !== undefined && after !== "?" && !/\s/.test(after)) break;
      const end = text.indexOf("?>", pos + 5);
      if (end === -1) fail("unterminated XML declaration");
      // The declaration must be well-formed-ish: no '<' inside it.
      if (text.slice(pos + 5, end).includes("<")) fail("malformed XML declaration");
      pos = end + 2;
      continue;
    }
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) fail("unterminated comment");
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", pos)) {
      skipDoctype();
      continue;
    }
    break;
  }
  if (text.startsWith("<!", pos)) fail("DOCTYPE is not allowed in SVG uploads");
  if (text.startsWith("<?", pos)) fail("processing instructions are not allowed");
  if (pos >= len || text[pos] !== "<") fail("document has no root element");
  const root = parseElement(0);
  skipWhitespace();
  // Nothing but whitespace/comments may follow the root element.
  while (pos < len) {
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) fail("unterminated comment");
      pos = end + 3;
      skipWhitespace();
      continue;
    }
    fail("content after the root element");
  }
  return root;
}

/** Serialize the parsed tree, dropping disallowed elements/attributes. Returns "" for a dropped subtree. */
function serializeSvgNode(node: SvgNode, isRoot: boolean): string {
  if (node.kind === "text") return escapeSvgText(node.value);
  const lower = node.name.toLowerCase();
  if (!SVG_ALLOWED_ELEMENTS.has(lower)) return "";
  const attrs: string[] = [];
  for (const attr of node.attrs) {
    const attrLower = attr.name.toLowerCase();
    if (!SVG_ALLOWED_ATTRIBUTES.has(attrLower)) continue;
    if (attrLower === "href" || attrLower === "xlink:href") {
      if (!SVG_HREF_ELEMENTS.has(lower)) continue;
      if (!isSafeSvgReference(lower, attr.value)) continue;
    }
    if (attrLower === "xmlns" || attrLower === "xmlns:xlink") {
      // Namespace declarations live on the root only, and must name
      // the SVG / XLink namespaces — anything else makes the document
      // non-SVG (or a namespace-confusion vector).
      if (!isRoot) continue;
      const expected = attrLower === "xmlns" ? SVG_NAMESPACE : XLINK_NAMESPACE;
      if (attr.value !== expected) {
        throw svgError(`Invalid SVG: unexpected namespace '${attr.value}'.`);
      }
    }
    attrs.push(`${attr.name}="${escapeSvgAttr(attr.value)}"`);
  }
  const children = node.children.map((c) => serializeSvgNode(c, false)).join("");
  const open = attrs.length > 0 ? `<${node.name} ${attrs.join(" ")}` : `<${node.name}`;
  return children === "" ? `${open}/>` : `${open}>${children}</${node.name}>`;
}

export function sanitizeSvgText(text: string): string {
  const root = parseSvgDocument(text);
  if (root.kind !== "element" || root.name.toLowerCase() !== "svg") {
    throw svgError("File does not look like SVG markup.");
  }
  return serializeSvgNode(root, true);
}

function verifySvg(bytes: Uint8Array): { sanitizedBytes: Uint8Array; dimensions: { width: number; height: number } | null } {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Sanitize FIRST (strips the DOCTYPE, which may legally precede the
  // <svg> root), then require the root element to be <svg> — a
  // DOCTYPE-first document is legitimate SVG, a non-SVG document is
  // not. The stored bytes are always the sanitized text.
  const clean = sanitizeSvgText(raw);
  const root = clean
    .trimStart()
    .replace(/^(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*)*/, "");
  if (!root.startsWith("<svg")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File does not look like SVG markup.", 415);
  }
  return {
    sanitizedBytes: new TextEncoder().encode(clean),
    dimensions: parseSvgDimensions(clean),
  };
}

function verifyText(bytes: Uint8Array, mime: string): void {
  // Text/CSV must decode as UTF-8 with no NUL bytes (binary masquerading as text).
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", `File contains NUL bytes; not valid ${mediaTypeLabel(mime)}.`, 415);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", `File is not valid UTF-8 text (${mediaTypeLabel(mime)}).`, 415);
  }
}

export interface VerifiedMedia {
  kind: MediaKind;
  /** For SVG: the SANITIZED bytes (store these, not the upload). Otherwise the input bytes. */
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/**
 * Validate a browser-generated thumbnail (L-11): it must be a WebP
 * within the thumbnail cap. Throws on oversize (the caller decides
 * whether that fails the request or drops the thumbnail).
 */
export function verifyThumbnailBytes(bytes: Uint8Array): VerifiedMedia {
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Thumbnail exceeds the maximum of ${MAX_THUMBNAIL_BYTES} bytes.`,
      413
    );
  }
  return verifyMediaBytes(bytes, "image/webp");
}

/**
 * Validate a media-library upload: size cap, allowlisted MIME, magic
 * bytes. Returns the bytes to store (sanitized for SVG) + dimensions.
 */
export function verifyMediaBytes(bytes: Uint8Array, declaredMimeType: string): VerifiedMedia {
  const mime = declaredMimeType.trim().toLowerCase();
  const kind = mediaKindOfMime(mime);
  if (!kind) throw unsupported(declaredMimeType);
  if (bytes.byteLength === 0) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Uploaded file is empty.", 415);
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Uploaded file exceeds the media library maximum of ${MAX_MEDIA_BYTES} bytes.`,
      413,
    );
  }

  switch (mime) {
    case "image/png": {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!sig.every((b, i) => bytes[i] === b)) throw badSignature(mime, "PNG");
      const d = parsePngDimensions(bytes);
      return { kind, bytes, width: d?.width ?? null, height: d?.height ?? null };
    }
    case "image/jpeg": {
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
        throw badSignature(mime, "JPEG");
      }
      const d = parseJpegDimensions(bytes);
      return { kind, bytes, width: d?.width ?? null, height: d?.height ?? null };
    }
    case "image/webp": {
      const isRiff =
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const isWebp =
        bytes.byteLength >= 12 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isRiff || !isWebp) throw badSignature(mime, "WEBP");
      const d = parseWebpDimensions(bytes);
      return { kind, bytes, width: d?.width ?? null, height: d?.height ?? null };
    }
    case "image/gif": {
      const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
      if (head !== "GIF87a" && head !== "GIF89a") throw badSignature(mime, "GIF");
      const d = parseGifDimensions(bytes);
      return { kind, bytes, width: d?.width ?? null, height: d?.height ?? null };
    }
    case "image/svg+xml": {
      const { sanitizedBytes, dimensions } = verifySvg(bytes);
      return { kind, bytes: sanitizedBytes, width: dimensions?.width ?? null, height: dimensions?.height ?? null };
    }
    case "video/mp4": {
      // ftyp box at offset 4 (after the 4-byte box size).
      const isFtyp =
        bytes.byteLength >= 8 &&
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
      if (!isFtyp) throw badSignature(mime, "MP4 (ftyp box)");
      return { kind, bytes, width: null, height: null };
    }
    case "video/webm": {
      if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
        throw badSignature(mime, "WebM (EBML header)");
      }
      return { kind, bytes, width: null, height: null };
    }
    case "audio/mpeg": {
      const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
      const isFrameSync = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
      if (!isId3 && !isFrameSync) throw badSignature(mime, "MP3 (ID3 or frame sync)");
      return { kind, bytes, width: null, height: null };
    }
    case "audio/wav":
    case "audio/x-wav": {
      const isRiff =
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const isWave =
        bytes.byteLength >= 12 &&
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
      if (!isRiff || !isWave) throw badSignature(mime, "WAV (RIFF/WAVE)");
      return { kind, bytes, width: null, height: null };
    }
    case "audio/ogg": {
      const isOgg =
        bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
      if (!isOgg) throw badSignature(mime, "OGG (OggS)");
      return { kind, bytes, width: null, height: null };
    }
    case "application/pdf": {
      if (
        !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)
      ) {
        throw badSignature(mime, "PDF (%PDF-)");
      }
      return { kind, bytes, width: null, height: null };
    }
    case "application/zip":
    case "application/x-zip-compressed": {
      // PK\x03\x04 (file), PK\x05\x06 (empty archive), PK\x07\x08 (spanned).
      if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]!))) {
        throw badSignature(mime, "ZIP (PK header)");
      }
      return { kind, bytes, width: null, height: null };
    }
    case "text/plain":
    case "text/csv": {
      verifyText(bytes, mime);
      return { kind, bytes, width: null, height: null };
    }
    default:
      throw unsupported(declaredMimeType);
  }
}

/** Folder rules: '' = root; otherwise lowercase slash-separated segments of [a-z0-9-_], max 120 chars, no leading/trailing slash, no '..'. */
export function normalizeFolder(raw: string | undefined | null): string {
  const folder = (raw ?? "").trim().toLowerCase();
  if (folder === "") return "";
  if (folder.length > 120) {
    throw new AppError("VALIDATION_ERROR", "Folder must be at most 120 characters.", 422);
  }
  if (folder.startsWith("/") || folder.endsWith("/") || folder.includes("//") || folder.includes("..")) {
    throw new AppError("VALIDATION_ERROR", "Folder must be slash-separated names without leading/trailing slashes or '..'.", 422);
  }
  const bad = folder.split("/").find((seg) => !/^[a-z0-9][a-z0-9_-]*$/.test(seg));
  if (bad !== undefined) {
    throw new AppError("VALIDATION_ERROR", `Folder segment '${bad}' is invalid — use letters, digits, '-' or '_'.`, 422);
  }
  return folder;
}

/** Tags: at most 10, each 1–30 chars of [a-z0-9-_], lowercased, deduplicated. */
export function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const tags: string[] = [];
  for (const t of list) {
    const tag = String(t).trim().toLowerCase();
    if (tag === "") continue;
    if (tag.length > 30 || !/^[a-z0-9][a-z0-9_-]*$/.test(tag)) {
      throw new AppError("VALIDATION_ERROR", `Tag '${tag}' is invalid — 1–30 chars of letters, digits, '-' or '_'.`, 422);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 10) {
    throw new AppError("VALIDATION_ERROR", "At most 10 tags per file.", 422);
  }
  return tags;
}

/**
 * Display-name validation for library files (upload + rename): the
 * ORIGINAL filename is kept as-is — spaces included, because it is
 * what the user searches for. Only path separators, control
 * characters and header-breaking quotes are replaced, and leading
 * dots are stripped (no hidden files). The STORAGE key is sanitized
 * separately by `mediaObjectKey` (via `sanitizeFilename`), so the
 * display name never has to be storage-safe.
 */
export function normalizeFilename(raw: string): string {
  const name = raw
    .trim()
    .replace(/[/\\<>:"|?*\x00-\x1F\x7F]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 255)
    .trim();
  if (name === "") {
    throw new AppError("VALIDATION_ERROR", "Filename is required.", 422);
  }
  return name;
}

/** Server-generated object key — never user-supplied paths. */
export function mediaObjectKey(filename: string, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const id = crypto.randomUUID();
  return `media/${yyyy}/${mm}/${id}-${sanitizeFilename(filename)}`;
}

export type MediaThumbnailVariant = "thumb" | "small";

/**
 * Sibling thumbnail key, derived deterministically from the original
 * object's key (PLAN §34 / ADR-0012): the thumbnail always lives next
 * to the original, so a regenerate overwrites the same object and a
 * delete removes both without a second lookup. The thumbnail is
 * always WebP, whatever the original format was.
 */
export function mediaThumbnailKey(objectKey: string, variant: MediaThumbnailVariant): string {
  const slash = objectKey.lastIndexOf("/");
  const dot = objectKey.lastIndexOf(".");
  const base = dot > slash ? objectKey.slice(0, dot) : objectKey;
  return `${base}-thumb-${variant === "thumb" ? "320" : "64"}.webp`;
}
