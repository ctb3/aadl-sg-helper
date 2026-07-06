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
  // JPEG quality of the harness's GCV input (upload-bytes ladder; 90 = classic).
  gcvQuality: num("GCV_QUALITY", 90),
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

  // --- field-test app (src/app) ---
  appPin: str("APP_PIN", ""),
  // Summer Game submission target; overridable for testing against a mirror.
  aadlBaseUrl: str("AADL_BASE_URL", "https://aadl.org"),
  sessionsBucket: str("SESSIONS_BUCKET", ""),
  // PORT is the Lambda Web Adapter convention; also used locally.
  appPort: num("PORT", 8080),

  // --- runtime feature flags (AWS AppConfig) ---
  // Identifiers (not secrets) of the AppConfig feature-flag profile the app
  // polls. Empty appconfigEnv (local dev) makes flags.ts fall back to env.
  appconfigApp: str("APPCONFIG_APP", "aadl-sg"),
  appconfigEnv: str("APPCONFIG_ENV", ""),
  appconfigProfile: str("APPCONFIG_PROFILE", "flags"),
  // Local/fail-open override for the store-images flag when AppConfig is
  // unreachable (no env configured, no perms): keeps today's "always store".
  storeImagesDefault: str("STORE_IMAGES", "on"),
  // Same fail-open override for the extract-mode flag: full | gcv | off.
  extractModeDefault: str("EXTRACT_MODE", "full"),
  // How long a fetched flag value is trusted before the next AppConfig poll.
  flagCacheTtlMs: num("FLAG_CACHE_TTL_MS", 60000),
} as const;

export function tokenCost(inTok: number, outTok: number, inPerM: number, outPerM: number): number {
  return (inTok / 1_000_000) * inPerM + (outTok / 1_000_000) * outPerM;
}
