import fs from "node:fs";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config";
import { normalize } from "../score";

/**
 * Field-session analysis: pulls every session under an S3 prefix and reports
 * accuracy + stage timings. Ground truth = the user's approved/manual final
 * code (the verdict IS the label — that's the point of the app).
 *
 *   npx tsx src/app/sessions-report.ts [prefix]
 * Default prefix = the current app version's folder (sessions/v<package.json
 * version>/); pass an explicit prefix for older batches.
 */

const pkgVersion: string = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const prefix = process.argv[2] ?? `sessions/v${pkgVersion}/`;
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
  clientMs: number | null;
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

async function main(): Promise<void> {
  if (!bucket) throw new Error("SESSIONS_BUCKET not set");

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

  const rows: Row[] = [];
  for (const id of [...ids].sort()) {
    const [extract, tier2, verdict] = await Promise.all([
      getJson(`${prefix}${id}/extract.json`),
      getJson(`${prefix}${id}/tier2.json`),
      getJson(`${prefix}${id}/verdict.json`),
    ]);
    if (!extract) continue; // nothing to analyze
    const t2 = tier2?.tier2 ?? extract.tier2 ?? null;
    rows.push({
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
      clientMs: typeof verdict?.clientMs === "number" ? verdict.clientMs : null,
    });
  }

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
    const notes = [
      r.usedLine ? "" : "no-line",
      r.truth === null ? "ABANDONED" : "",
      r.t2How === "auto" ? "auto-t2" : "",
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

  const T = (k: string): number[] => done.map((r) => r.timings[k]).filter((x) => typeof x === "number");
  console.log(`\n== speed (completed sessions)`);
  console.log(`prep:     ${stats(T("prepMs"))}`);
  if (T("decodeMs").length) {
    console.log(`  decode: ${stats(T("decodeMs"))} · encode: ${stats(T("encodeMs"))}`);
  }
  console.log(`upload:   ${stats(T("uploadMs"))}  bytes: ${stats(done.map((r) => r.photo.bytes ?? 0).filter(Boolean)).replace(/ms/g, "B")}`);
  console.log(`extract:  ${stats(T("extractMs"))}  (server GCV: ${stats(rows.map((r) => r.t1LatMs!).filter((x) => x != null))})`);
  console.log(`escalate: ${stats(T("escalateMs"))}  (server Claude: ${stats(rows.map((r) => r.t2LatMs!).filter((x) => x != null))})`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
