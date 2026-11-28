/**
 * Browser-side thumbnail generation (PLAN §34 / ADR-0012).
 *
 * The Workers API cannot run Sharp (native libvips — no Workers
 * target), so thumbnails are generated here in the SPA at upload:
 * one decode of the original, two canvas resizes (320px for grid /
 * picker cells, 64px for the 32px list thumb), encoded as WebP q80.
 *
 * Everything here is best-effort and never throws: an old browser,
 * a decode failure, or a missing WebP encoder returns null and the
 * upload proceeds without thumbnails — the server stores the
 * original, the row has no thumbnail, and the UI falls back to the
 * full original URL.
 */

export interface GeneratedThumbnails {
  thumb?: Blob | undefined;
  small?: Blob | undefined;
}

export const THUMB_WIDTH = 320;
export const SMALL_WIDTH = 64;

/** Raster MIMEs the browser resizes — never SVG (vector, served as-is). */
export function canGenerateThumbnail(file: File): boolean {
  return (
    file.type === "image/png" ||
    file.type === "image/jpeg" ||
    file.type === "image/webp" ||
    file.type === "image/gif"
  );
}

function resizeTo(bitmap: ImageBitmap, maxWidth: number): HTMLCanvasElement | null {
  if (bitmap.width <= maxWidth) return null;
  const scale = maxWidth / bitmap.width;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToWebP(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.8);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Generate the two thumbnail variants for an image file, or null
 * when thumbnails are not applicable / could not be generated.
 * A variant is dropped when it is not smaller than the original
 * (a tiny source image gains nothing from a "thumbnail").
 */
export async function generateThumbnails(file: File): Promise<GeneratedThumbnails | null> {
  if (!canGenerateThumbnail(file)) return null;
  try {
    let bitmap: ImageBitmap;
    try {
      // EXIF-correct: a phone photo taken in portrait stays upright.
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bitmap = await createImageBitmap(file);
    }
    try {
      const out: GeneratedThumbnails = {};
      const thumbCanvas = resizeTo(bitmap, THUMB_WIDTH);
      if (thumbCanvas) {
        const blob = await canvasToWebP(thumbCanvas);
        if (blob && blob.size < file.size) out.thumb = blob;
      }
      const smallCanvas = resizeTo(bitmap, SMALL_WIDTH);
      if (smallCanvas) {
        const blob = await canvasToWebP(smallCanvas);
        if (blob && blob.size < file.size) out.small = blob;
      }
      return out.thumb || out.small ? out : null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
