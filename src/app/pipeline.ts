import { config } from "../config";
import { cropWithPadding, downscaleToLongestEdge, fitsAsIs } from "../image";
import { alnum, combinedLine, gcvLines } from "../postproc";
import { claudeReader } from "../readers/claude";
import type { GcvWord } from "../readers/gcv";
import { gcvReader } from "../readers/gcv";
import type { ReaderResult } from "../types";

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
  latencyMs: number;
  costUsd: number;
  /** Full GCV output (all words + geometry) — session log only, never client. */
  raw: ReaderResult;
}

export async function runTier1(orig: Buffer): Promise<{ tier1: Tier1; cropJpeg: Buffer }> {
  // The client already uploads a 2400px EXIF-free JPEG; skip the redundant
  // decode+re-encode then. Oversized/EXIF-rotated uploads still get normalized.
  const gcvInput = (await fitsAsIs(orig, config.gcvMaxEdge))
    ? orig
    : await downscaleToLongestEdge(orig, config.gcvMaxEdge);
  const raw = await gcvReader.read(gcvInput, "gcv_crop");
  const words = (raw.rawResponse as { words?: GcvWord[] })?.words ?? [];
  const line = combinedLine(gcvLines(words));

  const code = line ? alnum(line.text) : "";
  const minConf = line && line.confs.length ? Math.min(...line.confs) : null;
  const gatePassed = code.length > 0 && minConf !== null && minConf >= MIN_CONF_GATE;

  // The crop is produced either way: tier 2 and the manual view both show it.
  const cropJpeg = line
    ? await downscaleToLongestEdge(await cropWithPadding(orig, line.bbox, CROP_PAD_PCT), config.maxEdge)
    : await downscaleToLongestEdge(orig, config.maxEdge);

  return {
    tier1: {
      code,
      minConf,
      gatePassed,
      usedLine: !!line,
      latencyMs: raw.latencyMs,
      costUsd: raw.costUsd ?? 0,
      raw,
    },
    cropJpeg,
  };
}

export interface Tier2 {
  code: string;
  perCharConfidence?: number[];
  alternatives?: string[];
  latencyMs: number;
  costUsd: number;
}

export async function runTier2(cropJpeg: Buffer): Promise<Tier2> {
  const res = await claudeReader.read(cropJpeg, "none");
  if (res.error) throw new Error(res.error);
  return {
    code: alnum(res.code ?? ""),
    perCharConfidence: res.perCharConfidence,
    alternatives: res.alternatives,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd ?? 0,
  };
}
