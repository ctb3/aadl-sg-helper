import fs from "node:fs";
import path from "node:path";
import { modelTag, sanitize } from "./cachekey";
import { config } from "../core/config";
import { downscaleToLongestEdge, cropWithPadding } from "../core/image";
import { localize, type LocalizeResult } from "./localizer";
import { readers } from "../core/readers/index";
import { writeReportMd, writeResultsCsv } from "./report";
import { cer, normalize } from "../core/score";
import {
  ALL_ARMS,
  ALL_READERS,
  type Arm,
  type GroundTruth,
  type ReaderName,
  type ReaderResult,
  type RunRecord,
} from "../core/types";

interface Args {
  readers: ReaderName[];
  arms: Arm[];
  image?: string;
  limit?: number;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { readers: [...ALL_READERS], arms: [...ALL_ARMS], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--reader") out.readers = [next() as ReaderName];
    else if (a === "--arm") out.arms = [next() as Arm];
    else if (a === "--image") out.image = next();
    else if (a === "--limit") out.limit = Number(next());
    else if (a === "--force") out.force = true;
  }
  return out;
}

function readLabels(): GroundTruth[] {
  if (!fs.existsSync(config.labelsPath)) {
    throw new Error(`labels file not found: ${config.labelsPath} — run \`npm run label\` first`);
  }
  const lines = fs.readFileSync(config.labelsPath, "utf8").split(/\r?\n/);
  const out: GroundTruth[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const filename = line.slice(0, comma).trim();
    const code = line.slice(comma + 1).trim();
    if (filename.toLowerCase() === "filename") continue; // header
    if (!code) continue; // unlabeled row
    out.push({ filename, code });
  }
  return out;
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

async function getPrepped(
  gt: GroundTruth,
  orig: Buffer,
  edge = config.maxEdge,
  quality = 90,
): Promise<Buffer> {
  ensureDir(config.preppedDir);
  const suffix =
    (edge === config.maxEdge ? "" : `.e${edge}`) + (quality === 90 ? "" : `.q${quality}`);
  const p = path.join(config.preppedDir, sanitize(gt.filename) + suffix + ".jpg");
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const buf = await downscaleToLongestEdge(orig, edge, quality);
  fs.writeFileSync(p, buf);
  return buf;
}

async function getCrop(gt: GroundTruth, orig: Buffer, force: boolean): Promise<Buffer> {
  ensureDir(config.cropsDir);
  ensureDir(config.cacheDir);
  const cropPath = path.join(
    config.cropsDir,
    `${sanitize(gt.filename)}__${sanitize(config.localizerModel)}.jpg`,
  );
  if (fs.existsSync(cropPath) && !force) return fs.readFileSync(cropPath);

  // localize (cached separately) → crop original at high res
  const locPath = path.join(
    config.cacheDir,
    `${sanitize(gt.filename)}__localizer__${sanitize(config.localizerModel)}.json`,
  );
  let loc: LocalizeResult;
  if (fs.existsSync(locPath) && !force) {
    loc = JSON.parse(fs.readFileSync(locPath, "utf8"));
  } else {
    const prepped = await getPrepped(gt, orig);
    loc = await localize(prepped);
    fs.writeFileSync(locPath, JSON.stringify(loc, null, 2));
  }
  const crop = await cropWithPadding(orig, loc.bbox, config.cropPaddingPct);
  fs.writeFileSync(cropPath, crop);
  return crop;
}

async function cachedRead(
  gt: GroundTruth,
  reader: ReaderName,
  arm: Arm,
  image: Buffer,
  force: boolean,
): Promise<ReaderResult> {
  ensureDir(config.cacheDir);
  const cachePath = path.join(
    config.cacheDir,
    `${sanitize(gt.filename)}__${reader}__${arm}${modelTag(reader, arm)}.json`,
  );
  if (fs.existsSync(cachePath) && !force) {
    // The cached flag never lands in the cache file itself: it's added here on
    // replay so reports can separate live latencies from replayed ones.
    return { ...JSON.parse(fs.readFileSync(cachePath, "utf8")), cached: true };
  }
  let result: ReaderResult;
  try {
    result = await readers[reader].read(image, arm);
  } catch (err) {
    result = {
      code: "",
      rawResponse: null,
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Only cache successful results, so a re-run retries after fixing creds/access.
  if (!result.error) fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  return result;
}

function buildRecord(gt: GroundTruth, reader: ReaderName, arm: Arm, res: ReaderResult): RunRecord {
  const conf = res.perCharConfidence && res.perCharConfidence.length ? res.perCharConfidence : null;
  const minConfidence = conf ? Math.min(...conf) : null;
  const meanConfidence = conf ? conf.reduce((a, b) => a + b, 0) / conf.length : null;
  const predictedNorm = normalize(res.code);
  const truthNorm = normalize(gt.code);
  return {
    filename: gt.filename,
    reader,
    arm,
    predictedRaw: res.code,
    predictedNorm,
    truthNorm,
    exactMatch: !res.error && predictedNorm === truthNorm,
    cer: res.error ? 1 : cer(res.code, gt.code),
    minConfidence,
    meanConfidence,
    alternatives: res.alternatives ?? [],
    latencyMs: res.latencyMs,
    cached: res.cached ?? false,
    costUsd: res.costUsd ?? 0,
    error: res.error ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let labels = readLabels();
  if (args.image) labels = labels.filter((g) => g.filename === args.image);
  if (args.limit !== undefined) labels = labels.slice(0, args.limit);

  if (labels.length === 0) {
    console.error("No labeled images to run (check data/labels.csv and your filters).");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(config.outDir, stamp);
  ensureDir(outDir);

  console.log(
    `Bake-off: ${labels.length} image(s) × readers[${args.readers.join(",")}] × arms[${args.arms.join(",")}]`,
  );
  console.log(`Output: ${outDir}\n`);

  const records: RunRecord[] = [];
  const needCrop = args.arms.includes("model_crop");

  for (const gt of labels) {
    const imgPath = path.join(config.imagesDir, gt.filename);
    if (!fs.existsSync(imgPath)) {
      console.warn(`  ! missing image, skipping: ${gt.filename}`);
      continue;
    }
    const orig = fs.readFileSync(imgPath);
    console.log(`• ${gt.filename} (truth=${gt.code})`);

    const prepped = await getPrepped(gt, orig);
    const crop = needCrop ? await getCrop(gt, orig, args.force) : null;

    for (const arm of args.arms) {
      for (const reader of args.readers) {
        const image =
          arm !== "none" ? crop!
          : reader === "gcv" ? await getPrepped(gt, orig, config.gcvMaxEdge, config.gcvQuality)
          : prepped;
        const res = await cachedRead(gt, reader, arm, image, args.force);
        const rec = buildRecord(gt, reader, arm, res);
        records.push(rec);

        const rawPath = path.join(outDir, `${sanitize(gt.filename)}__${reader}__${arm}.json`);
        fs.writeFileSync(rawPath, JSON.stringify({ gt, reader, arm, result: res, record: rec }, null, 2));

        const status = rec.error
          ? `ERROR: ${rec.error}`
          : `${rec.exactMatch ? "✓" : "✗"} "${rec.predictedNorm}"  cer=${rec.cer.toFixed(2)}` +
            (rec.minConfidence !== null ? ` minConf=${rec.minConfidence.toFixed(2)}` : "");
        console.log(`    ${reader.padEnd(9)} ${arm.padEnd(11)} ${status}`);
      }
    }
  }

  writeResultsCsv(records, outDir);
  writeReportMd(records, outDir, {
    generatedAt: new Date().toISOString(),
    images: labels.length,
    readers: args.readers,
    arms: args.arms,
    models: {
      claude: config.claudeModel,
      nova: config.novaModel,
      localizer: config.localizerModel,
    },
    region: config.awsRegion,
  });

  console.log(`\nWrote ${records.length} records.`);
  console.log(`  ${path.join(outDir, "report.md")}`);
  console.log(`  ${path.join(outDir, "results.csv")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
