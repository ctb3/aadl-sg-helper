import fs from "node:fs";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { config } from "../core/config";
import { normalize } from "../core/score";

/**
 * Field-session analysis: pulls every session under an S3 prefix and reports
 * accuracy + stage timings. Ground truth = the user's approved/manual final
 * code (the verdict IS the label — that's the point of the app).
 *
 *   npx tsx src/app/sessions-report.ts [prefix]     detailed, one version
 *   npx tsx src/app/sessions-report.ts --summary    cross-version rollup
 *
 * Default prefix = the current app version's folder (sessions/v<package.json
 * version>/); pass an explicit prefix for older batches. `--summary` instead
 * groups every version into an accuracy + per-step-speed (avg·p99) table.
 */

const pkgVersion: string = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const s3 = new S3Client({ region: config.awsRegion });
const bucket = config.sessionsBucket;

async function getJson(key: string): Promise<any | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body!.transformToString());
  } catch {
    return null;
  }
}

interface Row {
  version: string;
  id: string;
  at: string;
  photo: { width?: number; height?: number; bytes?: number };
  t1code: string;
  minConf: number | null;
  gate: boolean;
  usedLine: boolean;
  t1LatMs: number | null;
  t2code: string | null;
  t2How: "auto" | "escalated" | null;
  t2LatMs: number | null;
  truth: string | null; // normalized finalCode; null = abandoned
  source: string | null;
  verdicts: any[];
  timings: Record<string, number>;
  /** per-step server breakdown from extract.json (present even when abandoned). */
  serverT: Record<string, number | boolean>;
  /** ditto for a user-escalated tier-2, from tier2.json. */
  escServerT: Record<string, number | boolean>;
  clientMs: number | null;
  /** submit.json attempts: [{at, code, results:[{label, outcome, points, ...}]}] */
  submits: any[];
}

function pct(a: number, b: number): string {
  return b ? `${a}/${b} (${((a / b) * 100).toFixed(0)}%)` : "n/a";
}

function stats(xs: number[]): string {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return `med ${med}ms · max ${s[s.length - 1]}ms`;
}

// --- summary helpers ---
function mean(xs: number[]): number | null {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))];
}
function fmt(ms: number | null): string {
  return ms === null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
/** "avg·p99" over a series of step timings. */
function ap(xs: number[]): string {
  return xs.length ? `${fmt(mean(xs))}·${fmt(pctl(xs, 0.99))}` : "n/a";
}
/** compact "pct·hits/total" (percentages hide differing denominators). */
function rate(a: number, b: number): string {
  return b ? `${Math.round((a / b) * 100)}%·${a}/${b}` : "n/a";
}

/** Session ids (sorted) directly under a `sessions/v<ver>/` prefix. */
async function collectIds(prefix: string): Promise<string[]> {
  const ids = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      const m = o.Key!.slice(prefix.length).match(/^([^/]+)\//);
      if (m) ids.add(m[1]);
    }
    token = page.NextContinuationToken;
  } while (token);
  return [...ids].sort();
}

const versionOf = (prefix: string): string => prefix.match(/v([^/]+)\/$/)?.[1] ?? prefix;

/** Load one session's JSON trail into a Row (null when there's nothing to analyze). */
async function buildRow(prefix: string, id: string): Promise<Row | null> {
  const [extract, tier2, verdict, submit] = await Promise.all([
    getJson(`${prefix}${id}/extract.json`),
    getJson(`${prefix}${id}/tier2.json`),
    getJson(`${prefix}${id}/verdict.json`),
    getJson(`${prefix}${id}/submit.json`),
  ]);
  if (!extract) return null;
  const t2 = tier2?.tier2 ?? extract.tier2 ?? null;
  return {
    version: versionOf(prefix),
    id,
    at: extract.at ?? new Date(Number(id.split("-")[0])).toISOString(),
    photo: extract.photo ?? {},
    t1code: normalize(extract.tier1?.code ?? ""),
    minConf: extract.tier1?.minConf ?? null,
    gate: !!extract.tier1?.gatePassed,
    usedLine: !!extract.tier1?.usedLine,
    t1LatMs: extract.tier1?.latencyMs ?? null,
    t2code: t2 ? normalize(t2.code ?? "") : null,
    t2How: t2 ? (extract.tier2 ? "auto" : "escalated") : null,
    t2LatMs: t2?.latencyMs ?? null,
    truth: verdict?.finalCode ? normalize(verdict.finalCode) : null,
    source: verdict?.source ?? null,
    verdicts: verdict?.verdicts ?? [],
    timings: verdict?.timings ?? {},
    // extract.json's copy misses s3PutJsonMs/totalMs (it can't time its own
    // write); the client-plumbed copy in verdict.json has them, so prefer it.
    serverT: verdict?.timings?.server ?? extract.serverTimings ?? {},
    escServerT: verdict?.timings?.escalateServer ?? tier2?.serverTimings ?? {},
    clientMs: typeof verdict?.clientMs === "number" ? verdict.clientMs : null,
    submits: submit?.attempts ?? [],
  };
}

async function loadRows(prefix: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const id of await collectIds(prefix)) {
    const r = await buildRow(prefix, id);
    if (r) rows.push(r);
  }
  return rows;
}

async function main(): Promise<void> {
  if (!bucket) throw new Error("SESSIONS_BUCKET not set");
  const prefix = process.argv[2] ?? `sessions/v${pkgVersion}/`;
  const rows = await loadRows(prefix);

  console.log(`\n${rows.length} session(s) under s3://${bucket}/${prefix}\n`);
  console.log(
    "id".padEnd(15) + "gate".padEnd(6) + "conf".padEnd(6) + "tier1".padEnd(14) +
    "tier2".padEnd(14) + "final".padEnd(14) + "src".padEnd(7) +
    "prep".padEnd(6) + "upld".padEnd(6) + "extr".padEnd(6) + "esc".padEnd(6) + "notes",
  );
  for (const r of rows) {
    const t = r.timings;
    const ok = (code: string | null): string =>
      code === null ? "-" : r.truth === null ? code : `${code}${code === r.truth ? " ✓" : " ✗"}`;
    const lastSubmit = r.submits.at(-1);
    const notes = [
      r.usedLine ? "" : "no-line",
      r.truth === null ? "ABANDONED" : "",
      r.t2How === "auto" ? "auto-t2" : "",
      lastSubmit ? `sub:${[...new Set(lastSubmit.results.map((x: any) => x.outcome))].join("/")}` : "",
    ].filter(Boolean).join(" ");
    console.log(
      r.id.slice(0, 13).padEnd(15) +
      (r.gate ? "pass" : "FAIL").padEnd(6) +
      (r.minConf === null ? "-" : r.minConf.toFixed(2)).padEnd(6) +
      ok(r.t1code).slice(0, 13).padEnd(14) +
      ok(r.t2code).slice(0, 13).padEnd(14) +
      (r.truth ?? "-").slice(0, 13).padEnd(14) +
      (r.source ?? "-").padEnd(7) +
      `${t.prepMs ?? "-"}`.padEnd(6) + `${t.uploadMs ?? "-"}`.padEnd(6) +
      `${t.extractMs ?? "-"}`.padEnd(6) + `${t.escalateMs ?? "-"}`.padEnd(6) +
      notes,
    );
  }

  const done = rows.filter((r) => r.truth !== null);
  const gatePassed = rows.filter((r) => r.gate);
  const t1RightOfDone = done.filter((r) => r.t1code === r.truth);
  const gateDone = done.filter((r) => r.gate);
  const gateRight = gateDone.filter((r) => r.t1code === r.truth);
  const t2Done = done.filter((r) => r.t2code !== null);
  const t2Right = t2Done.filter((r) => r.t2code === r.truth);
  const bySource = new Map<string, number>();
  for (const r of done) bySource.set(r.source!, (bySource.get(r.source!) ?? 0) + 1);

  console.log(`\n== accuracy (${done.length} completed, ${rows.length - done.length} abandoned)`);
  console.log(`gate pass rate:            ${pct(gatePassed.length, rows.length)}`);
  console.log(`tier1 correct (completed): ${pct(t1RightOfDone.length, done.length)}`);
  console.log(`tier1 correct when gated:  ${pct(gateRight.length, gateDone.length)}  <- instant-answer precision`);
  console.log(`tier2 correct when run:    ${pct(t2Right.length, t2Done.length)}`);
  console.log(`final source:              ${[...bySource].map(([k, v]) => `${k}=${v}`).join("  ")}`);

  // AADL submission: the site's response is the validation oracle the bake-off
  // never had — rejected first attempts are exactly the tier-escalation signal.
  const withSubmits = rows.filter((r) => r.submits.length);
  if (withSubmits.length) {
    const outcomes = new Map<string, number>();
    for (const r of withSubmits) {
      for (const a of r.submits) {
        for (const x of a.results) outcomes.set(x.outcome, (outcomes.get(x.outcome) ?? 0) + 1);
      }
    }
    const firstRejected = withSubmits.filter((r) =>
      r.submits[0].results.some((x: any) => x.outcome === "not_recognized" || x.outcome === "close_match"));
    const recovered = firstRejected.filter((r) =>
      r.submits.at(-1).results.some((x: any) => x.outcome === "success" || x.outcome === "already_redeemed"));
    console.log(`\n== AADL submission (${withSubmits.length} session(s) submitted)`);
    console.log(`outcomes (all attempts):   ${[...outcomes].map(([k, v]) => `${k}=${v}`).join("  ")}`);
    console.log(`rejected on first try:     ${pct(firstRejected.length, withSubmits.length)}  <- oracle-caught misreads`);
    if (firstRejected.length) console.log(`recovered after rejection: ${pct(recovered.length, firstRejected.length)}`);
    const subLat = withSubmits.flatMap((r) => r.submits.flatMap((a: any) => a.results.map((x: any) => x.latencyMs))).filter((x: any) => typeof x === "number");
    console.log(`submit latency:            ${stats(subLat)}`);
  }

  const T = (k: string): number[] => done.map((r) => r.timings[k]).filter((x) => typeof x === "number");
  console.log(`\n== speed (completed sessions)`);
  console.log(`prep:     ${stats(T("prepMs"))}`);
  if (T("decodeMs").length) {
    console.log(`  decode: ${stats(T("decodeMs"))} · encode: ${stats(T("encodeMs"))}`);
  }
  console.log(`upload:   ${stats(T("uploadMs"))}  bytes: ${stats(done.map((r) => r.photo.bytes ?? 0).filter(Boolean)).replace(/ms/g, "B")}`);
  console.log(`extract:  ${stats(T("extractMs"))}  (server GCV: ${stats(rows.map((r) => r.t1LatMs!).filter((x) => x != null))})`);
  // s3TailMs = concurrent tail writes (photo/crop/extract.json); older
  // serverTimings recorded serial s3PutCropMs/s3PutJsonMs instead.
  const puts = (st: Record<string, number | boolean>): number | null => {
    if (typeof st.s3TailMs === "number") return st.s3TailMs;
    if (typeof st.s3PutJsonMs === "number") return (st.s3PutJsonMs as number) + ((st.s3PutCropMs as number) || 0);
    return null;
  };
  const S = (k: string): number[] =>
    rows.map((r) => r.serverT[k]).filter((x): x is number => typeof x === "number");
  if (S("gcvMs").length) {
    const cold = rows.filter((r) => r.serverT.coldStart === true).length;
    console.log(
      `  server: flag ${stats(S("flagMs"))} · s3get ${stats(S("s3GetMs"))} · norm ${stats(S("normMs"))} · ` +
      `crop ${stats(S("cropMs"))} · puts ${stats(rows.map((r) => puts(r.serverT)).filter((x): x is number => x !== null))} · ` +
      `total ${stats(S("totalMs"))} · cold starts ${cold}/${rows.length}`,
    );
  }
  if (T("cropLocalMs").length) console.log(`local crop (client, from original): ${stats(T("cropLocalMs"))}`);
  console.log(`escalate: ${stats(T("escalateMs"))}  (server Claude: ${stats(rows.map((r) => r.t2LatMs!).filter((x) => x != null))})`);
  const E = (k: string): number[] =>
    rows.map((r) => r.escServerT[k]).filter((x): x is number => typeof x === "number");
  if (E("tier2Ms").length) {
    console.log(
      `  server: s3get ${stats(E("s3GetMs"))} · claude ${stats(E("claudeMs"))} · ` +
      `putJson ${stats(E("s3PutJsonMs"))} · total ${stats(E("totalMs"))}`,
    );
  }
  console.log(`shutter→verdict (clientMs incl. human): ${stats(done.map((r) => r.clientMs!).filter((x) => x !== null))}`);

  // Slow-prep forensics: the field batches show bimodal prep (0.3-1s vs 10s+);
  // the per-session breakdown is what identifies the stalled half.
  const slow = done.filter((r) => (r.timings.prepMs ?? 0) > 3000);
  if (slow.length) {
    console.log(`\n== slow-prep sessions (prep > 3s)`);
    for (const r of slow) {
      const t = r.timings as any;
      console.log(
        `${r.id.slice(0, 13)}  prep=${t.prepMs}ms fileRead=${t.fileReadMs ?? "?"}ms ` +
        `decode=${t.decodeMs ?? "?"}ms draw=${t.drawMs ?? "?"}ms blob=${t.blobMs ?? "?"}ms ` +
        `worker=${t.worker ?? "?"} fileAge=${t.fileAgeMs ?? "?"}ms ` +
        `type=${t.fileType ?? "?"} bytes=${t.fileBytes ?? "?"}`,
      );
    }
  }
}

/** Version prefixes (`sessions/v.../`) under the bucket. */
async function listVersionPrefixes(): Promise<string[]> {
  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "sessions/",
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of page.CommonPrefixes ?? []) if (cp.Prefix) prefixes.push(cp.Prefix);
    token = page.NextContinuationToken;
  } while (token);
  return prefixes;
}

// Cross-version rollup: one accuracy row + one speed row per version, so a
// glance shows whether a release moved step1/step2 correctness or timings.
async function summary(): Promise<void> {
  if (!bucket) throw new Error("SESSIONS_BUCKET not set");
  const rows: Row[] = [];
  for (const p of await listVersionPrefixes()) rows.push(...(await loadRows(p)));

  const byVer = new Map<string, Row[]>();
  for (const r of rows) (byVer.get(r.version) ?? byVer.set(r.version, []).get(r.version)!).push(r);
  const versions = [...byVer.keys()].sort().reverse();

  console.log(`\n${rows.length} session(s) across ${versions.length} version(s) under s3://${bucket}/sessions/`);

  console.log(`\n== accuracy (pct·hits/total)`);
  console.log(
    "version".padEnd(26) + "seen".padEnd(6) + "done".padEnd(6) + "aband".padEnd(7) +
    "tier1✓".padEnd(15) + "tier1-gated✓".padEnd(15) + "tier2✓".padEnd(15) + "gate%",
  );
  for (const v of versions) {
    const rs = byVer.get(v)!;
    const done = rs.filter((r) => r.truth !== null);
    const gd = done.filter((r) => r.gate);
    const t2d = done.filter((r) => r.t2code !== null);
    console.log(
      v.slice(0, 25).padEnd(26) +
      String(rs.length).padEnd(6) + String(done.length).padEnd(6) +
      String(rs.length - done.length).padEnd(7) +
      rate(done.filter((r) => r.t1code === r.truth).length, done.length).padEnd(15) +
      rate(gd.filter((r) => r.t1code === r.truth).length, gd.length).padEnd(15) +
      rate(t2d.filter((r) => r.t2code === r.truth).length, t2d.length).padEnd(15) +
      rate(rs.filter((r) => r.gate).length, rs.length),
    );
  }

  console.log(`\n== speed per step, completed sessions (avg·p99)`);
  console.log(
    "version".padEnd(26) + "prep".padEnd(15) + "upload".padEnd(15) +
    "extract".padEnd(15) + "escalate".padEnd(15) + "shutter→verdict",
  );
  for (const v of versions) {
    const done = byVer.get(v)!.filter((r) => r.truth !== null);
    const col = (k: string): string =>
      ap(done.map((r) => r.timings[k]).filter((x): x is number => typeof x === "number"));
    console.log(
      v.slice(0, 25).padEnd(26) +
      col("prepMs").padEnd(15) + col("uploadMs").padEnd(15) +
      col("extractMs").padEnd(15) + col("escalateMs").padEnd(15) +
      ap(done.map((r) => r.clientMs).filter((x): x is number => x !== null)),
    );
  }

  // Server-side extract breakdown (only versions that record serverTimings).
  const withServer = versions.filter((v) => byVer.get(v)!.some((r) => typeof r.serverT.gcvMs === "number"));
  if (withServer.length) {
    console.log(`\n== server extract breakdown (avg·p99; cold = cold-start share)`);
    console.log(
      "version".padEnd(26) + "s3get".padEnd(15) + "gcv".padEnd(15) + "crop".padEnd(15) +
      "puts".padEnd(15) + "total".padEnd(15) + "cold",
    );
    for (const v of withServer) {
      const rs = byVer.get(v)!;
      const col = (k: string): string =>
        ap(rs.map((r) => r.serverT[k]).filter((x): x is number => typeof x === "number"));
      // s3TailMs (concurrent tail) with the older serial fields as fallback.
      const putsCol = ap(rs.map((r) => {
        const st = r.serverT;
        if (typeof st.s3TailMs === "number") return st.s3TailMs;
        if (typeof st.s3PutJsonMs === "number") return (st.s3PutJsonMs as number) + ((st.s3PutCropMs as number) || 0);
        return null;
      }).filter((x): x is number => x !== null));
      console.log(
        v.slice(0, 25).padEnd(26) +
        col("s3GetMs").padEnd(15) + col("gcvMs").padEnd(15) + col("cropMs").padEnd(15) +
        putsCol.padEnd(15) + col("totalMs").padEnd(15) +
        rate(rs.filter((r) => r.serverT.coldStart === true).length, rs.length),
      );
    }
  }
}

const run = process.argv.includes("--summary") ? summary : main;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
