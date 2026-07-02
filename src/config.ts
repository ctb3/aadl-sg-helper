import "dotenv/config";
import path from "node:path";

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const root = process.cwd();
function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

export const config = {
  awsRegion: str("AWS_REGION", "us-east-1"),

  claudeModel: str("CLAUDE_READER_MODEL", "us.anthropic.claude-sonnet-5"),
  novaModel: str("NOVA_READER_MODEL", "us.amazon.nova-pro-v1:0"),
  localizerModel: str("LOCALIZER_MODEL", "us.amazon.nova-lite-v1:0"),
  /** "disabled" adds thinking:{type:disabled} for Claude on Converse; "omit" sends nothing. */
  claudeThinking: str("CLAUDE_THINKING", "disabled"),

  imagesDir: resolve(str("IMAGES_DIR", "data/images")),
  labelsPath: resolve(str("LABELS_PATH", "data/labels.csv")),
  preppedDir: resolve("data/prepped"),
  cropsDir: resolve("data/crops"),
  cacheDir: resolve("data/cache"),
  outDir: resolve("out/runs"),

  maxEdge: num("MAX_EDGE", 1500),
  // GCV bills per image regardless of size, and its glyph reading is the
  // resolution-bound step — so it gets its own (higher) downscale target.
  gcvMaxEdge: num("GCV_MAX_EDGE", 2400),
  cropPaddingPct: num("CROP_PADDING_PCT", 0.15),

  gcvBand: {
    top: num("GCV_BAND_TOP", 0.55),
    bottom: num("GCV_BAND_BOTTOM", 0.85),
    left: num("GCV_BAND_LEFT", 0.15),
    right: num("GCV_BAND_RIGHT", 0.85),
  },

  cost: {
    claudeInPerMTok: num("CLAUDE_IN_PER_MTOK", 3.0),
    claudeOutPerMTok: num("CLAUDE_OUT_PER_MTOK", 15.0),
    novaInPerMTok: num("NOVA_IN_PER_MTOK", 0.8),
    novaOutPerMTok: num("NOVA_OUT_PER_MTOK", 3.2),
    localizerInPerMTok: num("LOCALIZER_IN_PER_MTOK", 0.06),
    localizerOutPerMTok: num("LOCALIZER_OUT_PER_MTOK", 0.24),
    textractPerPage: num("TEXTRACT_PER_PAGE", 0.0015),
    gcvPerImage: num("GCV_PER_IMAGE", 0.0015),
  },

  labelPort: num("LABEL_PORT", 5178),
} as const;

export function tokenCost(inTok: number, outTok: number, inPerM: number, outPerM: number): number {
  return (inTok / 1_000_000) * inPerM + (outTok / 1_000_000) * outPerM;
}
