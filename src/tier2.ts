import fs from "node:fs";
import path from "node:path";
import { modelTag, sanitize } from "./cachekey";
import { config } from "./config";
import { cropWithPadding, downscaleToLongestEdge } from "./image";
import { combinedLine, gcvLines } from "./postproc";
import { claudeReader } from "./readers/claude";
import { writeReportMd, writeResultsCsv } from "./report";
import { cer, normalize } from "./score";
import type { ReaderResult, RunRecord } from "./types";

/**
 * Tier-2 crop experiment: Claude reads a HIGH-RES crop of the original photo,
 * localized for free by GCV's tier-1 line geometry (no localizer model call).
 * Targets the failure mode of raw framing: at MAX_EDGE downscale a
 * small-in-frame sign leaves the handwriting too few pixels to read.
 *
 *   npx tsx src/tier2.ts
 *
 * Requires fresh GCV caches (npm run bake -- --reader gcv --arm none).
 * Results cached like the main harness; crops written to data/crops for
 * eyeballing.
 */

// Generous padding around the tight line box: keep neighbouring context (and
// any glyph the line grouping clipped) without re-admitting the whole sign.
const PAD_PCT = 0.6;

interface GroundTruth {
  filename: string;
  code: string;
}

function readLabels(): GroundTruth[] {
  const lines = fs.readFileSync(config.labelsPath, "utf8").split(/\r?\n/);
  const out: GroundTruth[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const filename = line.slice(0, comma).trim();
    const code = line.slice(comma + 1).trim();
    if (filename.toLowerCase() === "filename" || !code) continue;
    out.push({ filename, code });
  }
  return out;
}

async function main(): Promise<void> {
  const labels = readLabels();
  const claudeTag = modelTag("claude", "none");
  const gcvTag = modelTag("gcv", "none");
  fs.mkdirSync(config.cropsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(config.outDir, `${stamp}-gcvcrop`);
  fs.mkdirSync(outDir, { recursive: true });
  const records: RunRecord[] = [];

  let n = 0,
    ok = 0,
    noLine = 0;
  for (const gt of labels) {
    const gcvPath = path.join(config.cacheDir, `${sanitize(gt.filename)}__gcv__none${gcvTag}.json`);
    if (!fs.existsSync(gcvPath)) {
      console.warn(`  ! no GCV cache for ${gt.filename}, skipping (run the bake first)`);
      continue;
    }
    const gcvCache = JSON.parse(fs.readFileSync(gcvPath, "utf8"));
    const line = combinedLine(gcvLines(gcvCache.rawResponse?.words ?? []));

    const cachePath = path.join(
      config.cacheDir,
      `${sanitize(gt.filename)}__claude__gcvcrop${claudeTag}${gcvTag}.json`,
    );
    let result: any;
    if (fs.existsSync(cachePath)) {
      result = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } else {
      const orig = fs.readFileSync(path.join(config.imagesDir, gt.filename));
      let image: Buffer;
      if (line) {
        const crop = await cropWithPadding(orig, line.bbox, PAD_PCT);
        image = await downscaleToLongestEdge(crop, config.maxEdge);
        fs.writeFileSync(
          path.join(config.cropsDir, `${sanitize(gt.filename)}__gcvline.jpg`),
          image,
        );
      } else {
        // GCV found no candidate line — tier 2 falls back to the full photo.
        image = await downscaleToLongestEdge(orig, config.maxEdge);
      }
      result = await claudeReader.read(image, "none");
      result.usedGcvLine = !!line;
      if (!result.error) fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
    }

    if (!line) noLine++;
    n++;
    const res = result as ReaderResult;
    const pred = normalize(res.code ?? "");
    const exact = !res.error && pred === normalize(gt.code);
    if (exact) ok++;

    const conf =
      res.perCharConfidence && res.perCharConfidence.length ? res.perCharConfidence : null;
    const rec: RunRecord = {
      filename: gt.filename,
      reader: "claude",
      arm: "gcv_crop",
      predictedRaw: res.code ?? "",
      predictedNorm: pred,
      truthNorm: normalize(gt.code),
      exactMatch: exact,
      cer: res.error ? 1 : cer(res.code ?? "", gt.code),
      minConfidence: conf ? Math.min(...conf) : null,
      meanConfidence: conf ? conf.reduce((a, b) => a + b, 0) / conf.length : null,
      alternatives: res.alternatives ?? [],
      latencyMs: res.latencyMs,
      costUsd: res.costUsd ?? 0,
      error: res.error ?? null,
    };
    records.push(rec);
    fs.writeFileSync(
      path.join(outDir, `${sanitize(gt.filename)}__claude__gcv_crop.json`),
      JSON.stringify({ gt, reader: "claude", arm: "gcv_crop", usedGcvLine: !!line, result: res, record: rec }, null, 2),
    );

    console.log(
      `${exact ? "✓" : "✗"} ${gt.filename.padEnd(32)} truth=${normalize(gt.code).padEnd(13)} ` +
        `pred=${pred.padEnd(13)} ${line ? "" : "(no line; full photo)"}`,
    );
  }

  writeResultsCsv(records, outDir);
  writeReportMd(records, outDir, {
    generatedAt: new Date().toISOString(),
    images: n,
    readers: ["claude"],
    arms: ["gcv_crop"],
    models: { claude: config.claudeModel, localizer: `gcv-line (e${config.gcvMaxEdge})` },
    fullPhotoFallbacks: noLine,
    region: config.awsRegion,
  });

  console.log(
    `\nclaude on gcv-line crop: ${ok}/${n} (${((ok / (n || 1)) * 100).toFixed(1)}%) exact` +
      (noLine ? ` · ${noLine} full-photo fallback(s)` : ""),
  );
  console.log(`  ${path.join(outDir, "report.md")}`);
  console.log(`  ${path.join(outDir, "results.csv")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
