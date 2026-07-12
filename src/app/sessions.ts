import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { config } from "../core/config";
import { normalize } from "../core/score";

/**
 * Shared field-session loading + stat helpers, used by the sessions-report CLI
 * and the /dash stats endpoint (src/app/dash.ts). Ground truth = the user's
 * approved/manual final code (the verdict IS the label — that's the point of
 * the app).
 */

export const s3 = new S3Client({ region: config.awsRegion });
export const bucket = config.sessionsBucket;

export async function getJson(key: string): Promise<any | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body!.transformToString());
  } catch {
    return null;
  }
}

export interface Row {
  version: string;
  id: string;
  /** manual-entry-from-home session: no photo, no extract.json — nothing to
   * score for extraction accuracy, but submits/verdicts still count. */
  manual: boolean;
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

export function pct(a: number, b: number): string {
  return b ? `${a}/${b} (${((a / b) * 100).toFixed(0)}%)` : "n/a";
}

export function stats(xs: number[]): string {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return `med ${med}ms · max ${s[s.length - 1]}ms`;
}

export function mean(xs: number[]): number | null {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
export function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))];
}
export function fmt(ms: number | null): string {
  return ms === null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
/** "avg·p99" over a series of step timings. */
export function ap(xs: number[]): string {
  return xs.length ? `${fmt(mean(xs))}·${fmt(pctl(xs, 0.99))}` : "n/a";
}
/** compact "pct·hits/total" (percentages hide differing denominators). */
export function rate(a: number, b: number): string {
  return b ? `${Math.round((a / b) * 100)}%·${a}/${b}` : "n/a";
}

/** Session ids (sorted) directly under a `sessions/v<ver>/` prefix. */
export async function collectIds(prefix: string): Promise<string[]> {
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

export const versionOf = (prefix: string): string => prefix.match(/v([^/]+)\/$/)?.[1] ?? prefix;

// Detroit-local days: field batches happen Ann Arbor evenings, which UTC
// would split across two dates. Shared by the dash and the visit beacon.
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Detroit",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const dayOf = (epochMs: number): string => dayFmt.format(new Date(epochMs));

/** Load one session's JSON trail into a Row (null when there's nothing to analyze). */
export async function buildRow(prefix: string, id: string): Promise<Row | null> {
  const [extract, tier2, verdict, submit] = await Promise.all([
    getJson(`${prefix}${id}/extract.json`),
    getJson(`${prefix}${id}/tier2.json`),
    getJson(`${prefix}${id}/verdict.json`),
    getJson(`${prefix}${id}/submit.json`),
  ]);
  // Manual-entry sessions never call /api/extract; they still have a
  // verdict/submit trail worth reporting. Nothing at all → skip.
  if (!extract && !verdict && !submit) return null;
  const t2 = tier2?.tier2 ?? extract?.tier2 ?? null;
  return {
    version: versionOf(prefix),
    id,
    manual: !extract,
    at: extract?.at ?? new Date(Number(id.split("-")[0])).toISOString(),
    photo: extract?.photo ?? {},
    t1code: normalize(extract?.tier1?.code ?? ""),
    minConf: extract?.tier1?.minConf ?? null,
    gate: !!extract?.tier1?.gatePassed,
    usedLine: !!extract?.tier1?.usedLine,
    t1LatMs: extract?.tier1?.latencyMs ?? null,
    t2code: t2 ? normalize(t2.code ?? "") : null,
    t2How: t2 ? (extract?.tier2 ? "auto" : "escalated") : null,
    t2LatMs: t2?.latencyMs ?? null,
    truth: verdict?.finalCode ? normalize(verdict.finalCode) : null,
    source: verdict?.source ?? null,
    verdicts: verdict?.verdicts ?? [],
    timings: verdict?.timings ?? {},
    // extract.json's copy misses s3PutJsonMs/totalMs (it can't time its own
    // write); the client-plumbed copy in verdict.json has them, so prefer it.
    serverT: verdict?.timings?.server ?? extract?.serverTimings ?? {},
    escServerT: verdict?.timings?.escalateServer ?? tier2?.serverTimings ?? {},
    clientMs: typeof verdict?.clientMs === "number" ? verdict.clientMs : null,
    submits: submit?.attempts ?? [],
  };
}

export async function loadRows(prefix: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const id of await collectIds(prefix)) {
    const r = await buildRow(prefix, id);
    if (r) rows.push(r);
  }
  return rows;
}

/** Version prefixes (`sessions/v.../`) under the bucket — excludes non-version
 * folders like the `sessions/_summary/` dash cache. */
export async function listVersionPrefixes(): Promise<string[]> {
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
    for (const cp of page.CommonPrefixes ?? []) {
      if (cp.Prefix && /\/v[^/]+\/$/.test(cp.Prefix)) prefixes.push(cp.Prefix);
    }
    token = page.NextContinuationToken;
  } while (token);
  return prefixes;
}
