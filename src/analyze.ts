import fs from "node:fs";
import path from "node:path";
import { modelTag, sanitize } from "./cachekey";
import { config } from "./config";
import { cer, normalize } from "./score";
import {
  alnum,
  combined,
  groupIntoLines,
  phraseSubtract,
  tallestLine,
  type Line,
  type StrategyResult,
} from "./postproc";
import type { GcvWord } from "./readers/gcv";

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

function gcvLines(words: GcvWord[]): Line[] {
  return groupIntoLines(
    words.map((w) => {
      // Glyph height from symbol boxes, not the word box: an axis-aligned box
      // around a whole tilted word is inflated by the tilt; single-glyph boxes
      // barely are. (Matters for the curved ring text on rotated photos.)
      const symHs = w.syms.map((s) => s.h).filter((h) => h > 0);
      return {
        text: w.text,
        cx: w.cx,
        cy: w.cy,
        h: symHs.length ? symHs.reduce((a, b) => a + b, 0) / symHs.length : w.h,
        confs: w.syms.filter((s) => /[A-Za-z0-9]/.test(s.ch)).map((s) => s.conf),
      };
    }),
  );
}

/** Build lines from WORD blocks (word bbox height ≈ glyph height; the LINE
 * blocks' boxes span the curved ring text and have inflated heights). */
function textractLines(blocks: any[]): Line[] {
  const words = (blocks ?? [])
    .filter((b: any) => b.BlockType === "WORD" && (b.Text ?? "").trim())
    .map((b: any) => {
      const bb = b.Geometry?.BoundingBox ?? {};
      const text: string = b.Text ?? "";
      const conf = (b.Confidence ?? 0) / 100;
      return {
        text,
        cx: (bb.Left ?? 0) + (bb.Width ?? 0) / 2,
        cy: (bb.Top ?? 0) + (bb.Height ?? 0) / 2,
        h: bb.Height ?? 0,
        confs: alnum(text)
          .split("")
          .map(() => conf),
      };
    });
  return groupIntoLines(words);
}

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
    const gcvCache = loadCache(gt.filename, "gcv");
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

  // Full cascade simulation: tier 1 = GCV+Textract combined (accept on string
  // agreement), tier 2 = Claude full photo (cached), tier 3 = manual with the
  // best guess prefilled. Uses cached Claude answers — no API calls.
  const claudeTag = modelTag("claude", "none");
  out.push(``);
  out.push(`## Cascade simulation: GCV×Textract agreement → Claude → manual`);
  out.push(``);
  out.push(`| Image | Tier | Answer | ✓ |`);
  out.push(`| --- | --- | --- | --- |`);
  let tier1 = 0,
    tier1Ok = 0,
    tier2 = 0,
    tier2Ok = 0,
    claudeAlone = 0,
    claudeAloneOk = 0;
  for (const r of both) {
    const t = byFile.get(r.filename)!;
    const soloClaude = loadCache(r.filename, "claude", claudeTag);
    if (soloClaude) {
      claudeAlone++;
      if (normalize(soloClaude.code ?? "") === r.truth) claudeAloneOk++;
    }
    const gcvCode = normalize(r.result.code);
    if (gcvCode && gcvCode === normalize(t.result.code)) {
      tier1++;
      if (r.exact) tier1Ok++;
      out.push(`| ${r.filename} | 1 (agree) | ${gcvCode} | ${r.exact ? "✓" : "✗"} |`);
    } else {
      const claude = loadCache(r.filename, "claude", claudeTag);
      const code = normalize(claude?.code ?? "");
      const ok = code === r.truth;
      tier2++;
      if (ok) tier2Ok++;
      out.push(`| ${r.filename} | 2 (claude) | ${code} | ${ok ? "✓" : "✗"} |`);
    }
  }
  const n = both.length;
  out.push(``);
  out.push(
    `Tier 1 resolves ${tier1}/${n} (${((tier1 / n) * 100).toFixed(0)}%) at ~$0.003/img, ` +
      `${tier1Ok}/${tier1} correct. Tier 2 handles ${tier2} escalations, ${tier2Ok}/${tier2} correct. ` +
      `**End-to-end: ${tier1Ok + tier2Ok}/${n} (${(((tier1Ok + tier2Ok) / n) * 100).toFixed(1)}%)** ` +
      `vs Claude-alone ${claudeAloneOk}/${claudeAlone} (${((claudeAloneOk / (claudeAlone || 1)) * 100).toFixed(1)}%). ` +
      `Remaining misses fall through to tier 3 (manual, prefilled).`,
  );

  const report = out.join("\n");
  console.log(report);
  const outPath = path.join(config.outDir, `postproc-analysis.md`);
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.writeFileSync(outPath, report + "\n");
  console.log(`\nWrote ${outPath}`);
}

main();
