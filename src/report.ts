import fs from "node:fs";
import path from "node:path";
import { ALL_ARMS, ALL_READERS, type Arm, type ReaderName, type RunRecord } from "./types";
import { calibrationBuckets } from "./score";

const CSV_COLUMNS: (keyof RunRecord)[] = [
  "filename",
  "reader",
  "arm",
  "predictedRaw",
  "predictedNorm",
  "truthNorm",
  "exactMatch",
  "cer",
  "minConfidence",
  "meanConfidence",
  "latencyMs",
  "cached",
  "costUsd",
  "error",
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeResultsCsv(records: RunRecord[], outDir: string): void {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  fs.writeFileSync(path.join(outDir, "results.csv"), [header, ...rows].join("\n") + "\n");
}

interface Cell {
  n: number;
  exact: number;
  cerSum: number;
  latencySum: number;
  /** Latencies of live (non-cache-replayed) calls only — cache hits report the
   * original call's latency, which lies about the current run. */
  freshLat: number[];
  costSum: number;
  errors: number;
}

function emptyCell(): Cell {
  return { n: 0, exact: 0, cerSum: 0, latencySum: 0, freshLat: [], costSum: 0, errors: 0 };
}

function pctlMs(xs: number[], p: number): string {
  if (!xs.length) return "—";
  const s = [...xs].sort((a, b) => a - b);
  return String(s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))]);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function writeReportMd(records: RunRecord[], outDir: string, meta: Record<string, unknown>): void {
  // aggregate by reader × arm
  const cells = new Map<string, Cell>();
  const key = (r: ReaderName, a: Arm) => `${r}|${a}`;
  for (const r of records) {
    const c = cells.get(key(r.reader, r.arm)) ?? emptyCell();
    c.n++;
    if (r.error) c.errors++;
    if (r.exactMatch) c.exact++;
    c.cerSum += r.cer;
    c.latencySum += r.latencyMs;
    if (!r.cached && !r.error) c.freshLat.push(r.latencyMs);
    c.costSum += r.costUsd;
    cells.set(key(r.reader, r.arm), c);
  }
  const get = (r: ReaderName, a: Arm) => cells.get(key(r, a)) ?? emptyCell();

  // Derive the table axes from the records themselves (tier2.ts produces arms
  // outside the run.ts matrix), keeping the canonical ALL_* ordering.
  const readers = ALL_READERS.filter((r) => records.some((rec) => rec.reader === r));
  const arms = [...ALL_ARMS, "gcv_crop" as Arm].filter((a) =>
    records.some((rec) => rec.arm === a),
  );

  const lines: string[] = [];
  lines.push("# AADL Summer Game — Extraction Bake-off Report", "");
  lines.push(`Generated: ${new Date().toISOString()}`, "");
  lines.push("```json", JSON.stringify(meta, null, 2), "```", "");

  const armHeader = `| Reader | ${arms.join(" | ")} |`;
  const armSep = `| --- | ${arms.map(() => "---").join(" | ")} |`;

  // Exact-match rate (headline)
  lines.push("## Exact full-code match rate (headline)", "");
  lines.push(armHeader, armSep);
  for (const reader of readers) {
    const row = arms.map((arm) => {
      const c = get(reader, arm);
      return c.n ? `${pct(c.exact / c.n)} (${c.exact}/${c.n})` : "—";
    });
    lines.push(`| ${reader} | ${row.join(" | ")} |`);
  }
  lines.push("");

  // Mean CER
  lines.push("## Mean character error rate (CER)", "");
  lines.push(armHeader, armSep);
  for (const reader of readers) {
    const row = arms.map((arm) => {
      const c = get(reader, arm);
      return c.n ? (c.cerSum / c.n).toFixed(3) : "—";
    });
    lines.push(`| ${reader} | ${row.join(" | ")} |`);
  }
  lines.push("");

  // Latency + cost + errors. "fresh" = live calls this run; the mean also
  // counts cache replays, whose latencies belong to the run that made them.
  lines.push("## Latency, cost, errors (by reader × arm)", "");
  lines.push("| Reader | Arm | n | mean latency (ms) | fresh n | fresh p50 | fresh p95 | total cost (USD) | errors |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const reader of readers) {
    for (const arm of arms) {
      const c = get(reader, arm);
      if (!c.n) continue;
      lines.push(
        `| ${reader} | ${arm} | ${c.n} | ${(c.latencySum / c.n).toFixed(0)} | ${c.freshLat.length} | ` +
        `${pctlMs(c.freshLat, 0.5)} | ${pctlMs(c.freshLat, 0.95)} | ${c.costSum.toFixed(4)} | ${c.errors} |`,
      );
    }
  }
  lines.push("");

  // Confidence calibration per reader (both arms combined)
  lines.push("## Confidence calibration (min per-char confidence vs correctness)", "");
  lines.push(
    "Can we tell *when we're wrong*? Each bucket shows exact-match accuracy for " +
      "predictions whose worst-glyph confidence fell in that range.",
    "",
  );
  for (const reader of readers) {
    const recs = records.filter((r) => r.reader === reader);
    const withConf = recs.filter((r) => r.error === null && r.minConfidence !== null);
    if (withConf.length === 0) {
      lines.push(`### ${reader}`, "", "_No confidence signal available._", "");
      continue;
    }
    lines.push(`### ${reader}`, "");
    lines.push("| min-confidence bucket | n | exact-match accuracy |");
    lines.push("| --- | --- | --- |");
    for (const bkt of calibrationBuckets(recs)) {
      lines.push(`| ${bkt.label} | ${bkt.n} | ${bkt.n ? pct(bkt.accuracy) : "—"} |`);
    }
    lines.push("");
  }

  fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
}
