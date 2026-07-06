import sharp from "sharp";
import type { BBox } from "./types";

export interface Dims {
  width: number;
  height: number;
}

export async function dims(buf: Buffer): Promise<Dims> {
  const m = await sharp(buf).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/** True when the image fits maxEdge AND carries no EXIF rotation — i.e. a
 * downscale-normalize pass would only re-encode the same pixels. */
export async function fitsAsIs(buf: Buffer, maxEdge: number): Promise<boolean> {
  const m = await sharp(buf).metadata();
  const w = m.width ?? 0;
  const h = m.height ?? 0;
  return w > 0 && h > 0 && Math.max(w, h) <= maxEdge && (m.orientation ?? 1) === 1;
}

/** Downscale so the longest edge is <= maxEdge, re-encode as JPEG.
 * `quality` exists for the upload-bytes ladder (the field client encodes at
 * its own quality; the harness sweeps this to find GCV's floor). */
export async function downscaleToLongestEdge(
  buf: Buffer,
  maxEdge: number,
  quality = 90,
): Promise<Buffer> {
  return sharp(buf)
    .rotate() // respect EXIF orientation
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

/** Crop to `bbox` (normalized, padded) and downscale to `maxEdge` in a single
 * decode→encode pass. The old crop path (rotate-re-encode → extract-re-encode
 * → downscale-re-encode) fully decoded the photo three times; on Lambda's
 * ~1.2 vCPU that was a measurable slice of extract. Sources carrying EXIF
 * rotation (never the app's client, which bakes orientation in) pay one
 * normalize pass first so the bbox applies to the oriented pixel grid. */
export async function cropAndDownscale(
  buf: Buffer,
  bbox: BBox,
  paddingPct: number,
  maxEdge: number,
): Promise<Buffer> {
  const m = await sharp(buf).metadata();
  const src = (m.orientation ?? 1) === 1 ? buf : await sharp(buf).rotate().toBuffer();
  const { width, height } = src === buf ? { width: m.width ?? 0, height: m.height ?? 0 } : await dims(src);
  if (!width || !height) return downscaleToLongestEdge(src, maxEdge);

  const px = padBboxToPixels(bbox, paddingPct, width, height);
  return sharp(src)
    .extract(px)
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Crop `buf` to `bbox` (normalized) expanded by paddingPct of the bbox size. */
export async function cropWithPadding(buf: Buffer, bbox: BBox, paddingPct: number): Promise<Buffer> {
  const rotated = await sharp(buf).rotate().toBuffer();
  const { width, height } = await dims(rotated);
  if (!width || !height) return downscaleToLongestEdge(rotated, 1500);

  const px = padBboxToPixels(bbox, paddingPct, width, height);
  return sharp(rotated).extract(px).jpeg({ quality: 92 }).toBuffer();
}

/** Normalized padded bbox → a clamped sharp extract region. */
function padBboxToPixels(
  bbox: BBox,
  paddingPct: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const x0 = Math.min(bbox.x0, bbox.x1);
  const x1 = Math.max(bbox.x0, bbox.x1);
  const y0 = Math.min(bbox.y0, bbox.y1);
  const y1 = Math.max(bbox.y0, bbox.y1);

  const padX = (x1 - x0) * paddingPct;
  const padY = (y1 - y0) * paddingPct;

  const left = clamp01(x0 - padX);
  const top = clamp01(y0 - padY);
  const right = clamp01(x1 + padX);
  const bottom = clamp01(y1 + padY);

  const pxLeft = Math.floor(left * width);
  const pxTop = Math.floor(top * height);
  const pxW = Math.max(1, Math.min(width - pxLeft, Math.ceil((right - left) * width)));
  const pxH = Math.max(1, Math.min(height - pxTop, Math.ceil((bottom - top) * height)));
  return { left: pxLeft, top: pxTop, width: pxW, height: pxH };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
