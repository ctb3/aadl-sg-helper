import { config } from "../core/config";
import { cropAndDownscale, downscaleToLongestEdge, fitsAsIs } from "../core/image";
import { alnum, combinedLine, gcvLines } from "../core/postproc";
import type { BBox } from "../core/types";
import { claudeReader } from "../core/readers/claude";
import type { GcvWord } from "../core/readers/gcv";
import { gcvReader } from "../core/readers/gcv";
import type { ReaderResult } from "../core/types";

/**
 * The proven cascade as buffer-in library functions for the field-test app:
 * tier 1 = GCV + phrase-subtraction/tallest-line + minConf gate, tier 2 =
 * Claude on a high-res crop of GCV's chosen line. No filesystem, no cache.
 *
 * The GCV spatial band is OFF here (`gcv_crop` arm): it was tuned for the
 * bake-off's fixed raw framing, and field photos won't match it. Isolation
 * rests on phrase subtraction + tallest line alone.
 */

/** Same generous padding the tier-2 bake used around the tight line box. */
export const CROP_PAD_PCT = 0.6;
/** Tier-1 gate: worst-glyph confidence at or above this is presented as-is. */
export const MIN_CONF_GATE = 0.5;

export interface Tier1 {
  code: string;
  minConf: number | null;
  gatePassed: boolean;
  /** false = GCV found no candidate line; the crop is the full photo. */
  usedLine: boolean;
  /** Chosen line's bbox, normalized to the ORIENTED image (resolution-free) —
   * the client cuts its escalation crop from its local original with it. */
  bbox: BBox | null;
  latencyMs: number;
  costUsd: number;
  /** Full GCV output (all words + geometry) — session log only, never client. */
  raw: ReaderResult;
}

export async function runTier1(
  orig: Buffer,
): Promise<{ tier1: Tier1; cropJpeg: Buffer; normMs: number; cropMs: number }> {
  // The client already uploads a 2400px EXIF-free JPEG; skip the redundant
  // decode+re-encode then. Oversized/EXIF-rotated uploads still get normalized.
  let t = Date.now();
  const gcvInput = (await fitsAsIs(orig, config.gcvMaxEdge))
    ? orig
    : await downscaleToLongestEdge(orig, config.gcvMaxEdge);
  const normMs = Date.now() - t;
  const raw = await gcvReader.read(gcvInput, "gcv_crop");
  const words = (raw.rawResponse as { words?: GcvWord[] })?.words ?? [];
  const line = combinedLine(gcvLines(words));

  const code = line ? alnum(line.text) : "";
  const minConf = line && line.confs.length ? Math.min(...line.confs) : null;
  const gatePassed = code.length > 0 && minConf !== null && minConf >= MIN_CONF_GATE;

  // The crop is produced either way: tier 2 and the manual view both show it.
  t = Date.now();
  const cropJpeg = line
    ? await cropAndDownscale(orig, line.bbox, CROP_PAD_PCT, config.maxEdge)
    : await downscaleToLongestEdge(orig, config.maxEdge);
  const cropMs = Date.now() - t;

  return {
    normMs,
    cropMs,
    tier1: {
      code,
      minConf,
      gatePassed,
      usedLine: !!line,
      bbox: line?.bbox ?? null,
      latencyMs: raw.latencyMs,
      costUsd: raw.costUsd ?? 0,
      raw,
    },
    cropJpeg,
  };
}

export interface Tier2 {
  code: string;
  alternatives?: string[];
  latencyMs: number;
  costUsd: number;
}

export async function runTier2(cropJpeg: Buffer): Promise<Tier2> {
  const res = await claudeReader.read(cropJpeg, "none");
  if (res.error) throw new Error(res.error);
  return {
    code: alnum(res.code ?? ""),
    alternatives: res.alternatives,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd ?? 0,
  };
}
