import fs from "node:fs";
import path from "node:path";
import { modelTag, sanitize } from "./cachekey";
import { config } from "./config";
import { cer, normalize } from "./score";
import {
  alnum,
  combined,
  gcvLines,
  phraseSubtract,
  tallestLine,
  textractLines,
  type StrategyResult,
} from "./postproc";

/**
 * Offline post-processing bake-off: re-scores the geometry-aware engines
 * (GCV, Textract) under different isolation strategies using cached raw
 * responses — zero API calls. Run after `npm run bake`.
 *
 *   npx tsx src/analyze.ts
 */

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

function loadCache(filename: string, reader: string, modelTag = ""): any | null {
  const p = path.join(config.cacheDir, `${sanitize(filename)}__${reader}__none${modelTag}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------- adapters: cached raw response → Line[] ----------

/** Baseline: Textract's HANDWRITING-tagged words (what the main bake measured). */
function textractHandwriting(blocks: any[]): StrategyResult {
  const words = (blocks ?? []).filter(
    (b) => b.BlockType === "WORD" && b.TextType === "HANDWRITING",
  );
  words.sort((a, b) => {
    const at = a.Geometry?.BoundingBox?.Top ?? 0;
    const bt = b.Geometry?.BoundingBox?.Top ?? 0;
    if (Math.abs(at - bt) > 0.05) return at - bt;
    return (a.Geometry?.BoundingBox?.Left ?? 0) - (b.Geometry?.BoundingBox?.Left ?? 0);
  });
  const code = words.map((b) => alnum(b.Text ?? "")).join("");
  const confs = words.map((b) => (b.Confidence ?? 0) / 100);
  return { code, minConf: confs.length ? Math.min(...confs) : null };
}

// ---------- scoring ----------

interface Row {
  filename: string;
  truth: string;
  result: StrategyResult;
  exact: boolean;
  cer: number;
}

function score(gt: GroundTruth, r: StrategyResult): Row {
  return {
    filename: gt.filename,
    truth: normalize(gt.code),
    result: r,
    exact: normalize(r.code) === normalize(gt.code),
    cer: cer(r.code, gt.code),
  };
}

function summarize(name: string, rows: Row[]): string {
  const n = rows.length;
  const exact = rows.filter((r) => r.exact).length;
  const meanCer = rows.reduce((s, r) => s + r.cer, 0) / (n || 1);
  return `| ${name} | ${((exact / n) * 100).toFixed(1)}% (${exact}/${n}) | ${meanCer.toFixed(3)} |`;
}

function main(): void {
  const labels = readLabels();
  const strategies: Record<string, Row[]> = {};
  const add = (name: string, row: Row) => (strategies[name] ??= []).push(row);

  for (const gt of labels) {
    const gcvCache = loadCache(gt.filename, "gcv", modelTag("gcv", "none"));
    const txtCache = loadCache(gt.filename, "textract");

    if (gcvCache?.rawResponse?.words) {
      const lines = gcvLines(gcvCache.rawResponse.words);
      add("gcv: band heuristic (baseline)", score(gt, { code: gcvCache.code, minConf: null }));
      add("gcv: tallest line", score(gt, tallestLine(lines)));
      add("gcv: phrase subtraction", score(gt, phraseSubtract(lines)));
      add("gcv: phrase + tallest (combined)", score(gt, combined(lines)));
    }
    if (txtCache?.rawResponse?.blocks) {
      const lines = textractLines(txtCache.rawResponse.blocks);
      add("textract: HANDWRITING tag (baseline)", score(gt, textractHandwriting(txtCache.rawResponse.blocks)));
      add("textract: tallest line", score(gt, tallestLine(lines)));
      add("textract: phrase subtraction", score(gt, phraseSubtract(lines)));
      add("textract: phrase + tallest (combined)", score(gt, combined(lines)));
    }
  }

  const out: string[] = [];
  out.push(`# Post-processing strategy bake-off (offline, from cache)`);
  out.push(``);
  out.push(`Images: ${labels.length} · arm: none (full photo) · generated ${new Date().toISOString()}`);
  out.push(``);
  out.push(`| Strategy | Exact match | Mean CER |`);
  out.push(`| --- | --- | --- |`);
  for (const [name, rows] of Object.entries(strategies)) out.push(summarize(name, rows));

  // Per-image detail for the two combined strategies.
  for (const name of ["gcv: phrase + tallest (combined)", "textract: phrase + tallest (combined)"]) {
    const rows = strategies[name];
    if (!rows) continue;
    out.push(``);
    out.push(`## ${name} — per image`);
    out.push(``);
    out.push(`| Image | Truth | Predicted | ✓ | minConf |`);
    out.push(`| --- | --- | --- | --- | --- |`);
    for (const r of rows) {
      out.push(
        `| ${r.filename} | ${r.truth} | ${normalize(r.result.code)} | ${r.exact ? "✓" : "✗"} | ${r.result.minConf?.toFixed(2) ?? "—"} |`,
      );
    }
  }

  // Can GCV tell when it's right? (the cascade gate)
  const gcvRows = strategies["gcv: phrase + tallest (combined)"] ?? [];
  out.push(``);
  out.push(`## Cascade gating — gcv combined, accept if minConf ≥ t`);
  out.push(``);
  out.push(`| threshold | coverage | accuracy when accepted |`);
  out.push(`| --- | --- | --- |`);
  for (const t of [0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const accepted = gcvRows.filter((r) => (r.result.minConf ?? -1) >= t && r.result.code);
    const ok = accepted.filter((r) => r.exact).length;
    out.push(
      `| ${t.toFixed(1)} | ${((accepted.length / (gcvRows.length || 1)) * 100).toFixed(0)}% (${accepted.length}/${gcvRows.length}) | ${accepted.length ? ((ok / accepted.length) * 100).toFixed(0) : "—"}% |`,
    );
  }

  // GCV × Textract agreement as an alternative (still-cheap) gate.
  const txtRows = strategies["textract: phrase + tallest (combined)"] ?? [];
  const byFile = new Map(txtRows.map((r) => [r.filename, r]));
  const both = gcvRows.filter((r) => byFile.has(r.filename));
  const agree = both.filter((r) => {
    const t = byFile.get(r.filename)!;
    return normalize(r.result.code) !== "" && normalize(r.result.code) === normalize(t.result.code);
  });
  const agreeOk = agree.filter((r) => r.exact).length;
  out.push(``);
  out.push(`## GCV × Textract agreement gate (combined strategy on both)`);
  out.push(``);
  out.push(
    `Agree on ${agree.length}/${both.length} images (${((agree.length / (both.length || 1)) * 100).toFixed(0)}% coverage); ` +
      `accuracy when agreeing: ${agree.length ? ((agreeOk / agree.length) * 100).toFixed(0) : "—"}% (${agreeOk}/${agree.length}).`,
  );

  // Cascade simulation comparing tier-1 policies. Pipeline: tier 1 (cheap OCR)
  // → tier 2 (Claude full photo, cached) → tier 3 (manual, prefilled).
  //
  // The key UX difference between policies: when tier 1 emits an answer with
  // no gate, a wrong answer is only discovered when the user's submission
  // FAILS at play.aadl.org (one bad round trip, then escalate to Claude). A
  // gate (confidence / agreement) escalates BEFORE the user submits, at the
  // price of more Claude calls. So we track "wrong prefills" separately.
  const claudeTag = modelTag("claude", "none");
  const claudeByFile = new Map<string, { code: string; costUsd: number }>();
  const claudeCropByFile = new Map<string, string>(); // tier2 via GCV-line crop (src/tier2.ts)
  for (const r of both) {
    const c = loadCache(r.filename, "claude", claudeTag);
    if (c) claudeByFile.set(r.filename, { code: normalize(c.code ?? ""), costUsd: c.costUsd ?? 0 });
    const cropPath = path.join(
      config.cacheDir,
      `${sanitize(r.filename)}__claude__gcvcrop${claudeTag}${modelTag("gcv", "none")}.json`,
    );
    if (fs.existsSync(cropPath)) {
      const cc = JSON.parse(fs.readFileSync(cropPath, "utf8"));
      claudeCropByFile.set(r.filename, normalize(cc.code ?? ""));
    }
  }
  const claudeCost = [...claudeByFile.values()].reduce((s, c) => s + c.costUsd, 0) /
    Math.max(1, claudeByFile.size);

  const GCV_COST = config.cost.gcvPerImage;
  const TXT_COST = config.cost.textractPerPage;
  // Seconds, measured means. gcv/claude from prod field telemetry v0.4.0
  // (sessions-report: GCV 408ms, Claude-on-crop Sonnet 4.6 1578ms); textract
  // from the original bake. Claude was 2.6 when tier 2 read the 1500px full
  // photo — the line crop is far fewer input tokens.
  const LAT = { gcv: 0.4, textract: 1.6, claude: 1.6 };

  interface Policy {
    name: string;
    tier1Cost: number;
    tier1Lat: number;
    // returns tier-1 answer to show the user, or null to escalate immediately
    answer: (gcv: Row, txt: Row) => string | null;
  }
  const policies: Policy[] = [
    {
      name: "gcv alone",
      tier1Cost: GCV_COST,
      tier1Lat: LAT.gcv,
      answer: (g) => normalize(g.result.code) || null,
    },
    {
      name: "textract alone",
      tier1Cost: TXT_COST,
      tier1Lat: LAT.textract,
      answer: (_, t) => normalize(t.result.code) || null,
    },
    {
      name: "gcv, minConf ≥ 0.5 gate",
      tier1Cost: GCV_COST,
      tier1Lat: LAT.gcv,
      answer: (g) =>
        (g.result.minConf ?? -1) >= 0.5 ? normalize(g.result.code) || null : null,
    },
    {
      name: "gcv×textract agreement gate",
      tier1Cost: GCV_COST + TXT_COST,
      tier1Lat: Math.max(LAT.gcv, LAT.textract), // parallel calls
      answer: (g, t) => {
        const a = normalize(g.result.code);
        return a && a === normalize(t.result.code) ? a : null;
      },
    },
  ];

  out.push(``);
  out.push(`## Cascade simulation — tier-1 policy → Claude → manual`);
  out.push(``);
  out.push(
    `"Wrong prefill" = tier 1 answered wrong with no gate to catch it, so the user ` +
      `discovers it via a failed submission, then escalates. End-to-end assumes ` +
      `every tier-1 miss eventually reaches Claude (mean Claude cost $${claudeCost.toFixed(4)}/img).`,
  );
  out.push(``);
  out.push(
    `| Tier-1 policy | instant answer | wrong prefill | Claude calls | end-to-end (full) | end-to-end (crop) | est. cost/img | tier-1 latency |`,
  );
  out.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const p of policies) {
    let instant = 0,
      wrongPrefill = 0,
      claudeCalls = 0,
      endOk = 0,
      endOkCrop = 0;
    for (const r of both) {
      const t = byFile.get(r.filename)!;
      const ans = p.answer(r, t);
      const claude = claudeByFile.get(r.filename);
      const crop = claudeCropByFile.get(r.filename);
      if (ans !== null && ans === r.truth) {
        instant++;
        endOk++;
        endOkCrop++;
      } else {
        if (ans !== null) {
          instant++;
          wrongPrefill++; // rescued only after the failed submission
        }
        claudeCalls++;
        if (claude?.code === r.truth) endOk++;
        if (crop === r.truth) endOkCrop++;
      }
    }
    const n2 = both.length;
    const cost = p.tier1Cost + (claudeCalls / n2) * claudeCost;
    out.push(
      `| ${p.name} | ${((instant / n2) * 100).toFixed(0)}% (${instant}/${n2}) | ` +
        `${((wrongPrefill / n2) * 100).toFixed(0)}% (${wrongPrefill}) | ` +
        `${((claudeCalls / n2) * 100).toFixed(0)}% | ` +
        `${((endOk / n2) * 100).toFixed(1)}% (${endOk}/${n2}) | ` +
        `${claudeCropByFile.size ? ((endOkCrop / n2) * 100).toFixed(1) + "% (" + endOkCrop + "/" + n2 + ")" : "—"} | ` +
        `$${cost.toFixed(4)} | ${p.tier1Lat.toFixed(1)}s |`,
    );
  }
  out.push(``);
  out.push(
    `"end-to-end (crop)" = tier 2 reads a high-res crop of the original photo at ` +
      `GCV's tier-1 line bbox (src/tier2.ts) instead of the ${config.maxEdge}px full photo.`,
  );
  const claudeAloneOk = both.filter((r) => claudeByFile.get(r.filename)?.code === r.truth).length;
  out.push(``);
  out.push(
    `Claude-alone reference: ${claudeAloneOk}/${both.length} ` +
      `(${((claudeAloneOk / (both.length || 1)) * 100).toFixed(1)}%) at $${claudeCost.toFixed(4)}/img, ~${LAT.claude.toFixed(1)}s.`,
  );

  const report = out.join("\n");
  console.log(report);
  const outPath = path.join(config.outDir, `postproc-analysis.md`);
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.writeFileSync(outPath, report + "\n");
  console.log(`\nWrote ${outPath}`);
}

main();
