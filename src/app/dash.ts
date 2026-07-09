import { PutObjectCommand } from "@aws-sdk/client-s3";
import { normalize } from "../core/score";
import { buildRow, bucket, collectIds, getJson, listVersionPrefixes, pctl, Row, s3 } from "./sessions";

/**
 * Stats behind GET /api/dash-stats (the /dash page). Aggregates every field
 * session by Detroit-local day and by version.
 *
 * Cost control (the endpoint is public and each raw sweep is 4 GETs per
 * session): per-(version, day) summaries are cached as compact per-session
 * records at sessions/_summary/v<ver>/<yyyy-mm-dd>.json once the day is
 * sealed (≥2 Detroit days old — late resubmits mutate submit.json for a day
 * or so). Records, not aggregates, because percentiles don't merge; at tens
 * of sessions/day exact recomputation over concatenated records is free.
 * Open days are always computed fresh and never written. The whole payload
 * is also memoized in-process for 60s.
 *
 * Privacy: no code strings (t1code/t2code/truth) ever leave the bucket —
 * codes are live redeemable secrets and the endpoint has no auth.
 */

const SCHEMA = 2;
const MEMO_TTL_MS = 60_000;
const MAX_DAYS = 60;

interface SessionStat {
  id: string; // dedupe key; day derivable from the epoch prefix
  completed: boolean; // truth !== null (else abandoned)
  gate: boolean;
  t1ok: boolean | null; // null when abandoned
  t2ran: boolean;
  t2ok: boolean | null; // null when t2 didn't run or abandoned
  t2how: "auto" | "escalated" | null;
  lat: { extractTotalMs?: number; gcvMs?: number; claudeMs?: number; clientMs?: number };
}

interface DaySummaryFile {
  schema: number;
  version: string;
  day: string; // yyyy-mm-dd, Detroit
  computedAt: string;
  sessions: SessionStat[];
}

interface LatStat {
  med: number | null;
  p90: number | null;
  n: number;
}

interface Agg {
  sessions: number;
  completed: number;
  abandoned: number;
  gatePassRate: { n: number; d: number };
  t1Correct: { n: number; d: number };
  t2CorrectWhenRun: { n: number; d: number };
  /** counts over completed sessions; the last two split the t1-wrong cases. */
  buckets: {
    t1Correct: number;
    t1WrongT2Caught: number;
    bothWrong: number;
    t1WrongGateFail: number;
    t1WrongGatePassed: number;
  };
  lat: { extractTotal: LatStat; gcv: LatStat; claude: LatStat; client: LatStat };
}

export interface DashPayload {
  generatedAt: string;
  appVersion: string;
  totals: Agg;
  byDay: Array<{ key: string; sealed: boolean } & Agg>;
  byVersion: Array<{ key: string } & Agg>;
}

// Detroit-local days: field batches happen Ann Arbor evenings, which UTC
// would split across two dates.
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Detroit",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayOf = (epochMs: number): string => dayFmt.format(new Date(epochMs));

/** Sealed = ≥2 Detroit days old (yyyy-mm-dd compares lexically). */
const isSealed = (day: string): boolean => day < dayOf(Date.now() - 24 * 3600 * 1000);

/**
 * The AADL submission response outranks the user's approval as truth: an
 * approved misread (e.g. a wrong crop that sailed through both tiers) shows
 * up as a rejected final submission, and truth-by-approval alone would score
 * it as a phantom tier-2 ✓.
 *   accepted → some attempt got success/already_redeemed; that attempt's code
 *              is the confirmed truth (a reject-then-retype session's
 *              verdict.finalCode still holds the wrong first read)
 *   rejected → attempts exist and every decisive outcome is a misread signal
 *   null     → never submitted / nothing decisive: approval stands
 */
function oracleOf(submits: any[]): { verdict: "accepted" | "rejected" | null; code: string | null } {
  const ok = (x: any): boolean => x.outcome === "success" || x.outcome === "already_redeemed";
  const accepted = submits.find((a) => (a.results ?? []).some(ok));
  if (accepted) return { verdict: "accepted", code: normalize(accepted.code ?? "") || null };
  const rejected = submits.some((a) =>
    (a.results ?? []).some((x: any) => x.outcome === "not_recognized" || x.outcome === "close_match"));
  return { verdict: rejected ? "rejected" : null, code: null };
}

function toStat(r: Row): SessionStat {
  const lat: SessionStat["lat"] = {};
  const totalMs = r.serverT.totalMs;
  if (typeof totalMs === "number") lat.extractTotalMs = totalMs;
  if (r.t1LatMs !== null) lat.gcvMs = r.t1LatMs;
  if (r.t2LatMs !== null) lat.claudeMs = r.t2LatMs;
  if (r.clientMs !== null) lat.clientMs = r.clientMs;
  const o = oracleOf(r.submits);
  const truth = o.code ?? r.truth;
  const rejected = o.verdict === "rejected";
  return {
    id: r.id,
    completed: truth !== null,
    gate: r.gate,
    t1ok: truth !== null ? !rejected && r.t1code === truth : null,
    t2ran: r.t2code !== null,
    t2ok: truth !== null && r.t2code !== null ? !rejected && r.t2code === truth : null,
    t2how: r.t2How,
    lat: lat,
  };
}

function latStat(xs: number[]): LatStat {
  return { med: pctl(xs, 0.5), p90: pctl(xs, 0.9), n: xs.length };
}

function agg(stats: SessionStat[]): Agg {
  const done = stats.filter((s) => s.completed);
  const t1Wrong = done.filter((s) => s.t1ok === false);
  const t2Ran = done.filter((s) => s.t2ran);
  const L = (k: keyof SessionStat["lat"]): number[] =>
    stats.map((s) => s.lat[k]).filter((x): x is number => typeof x === "number");
  return {
    sessions: stats.length,
    completed: done.length,
    abandoned: stats.length - done.length,
    gatePassRate: { n: stats.filter((s) => s.gate).length, d: stats.length },
    t1Correct: { n: done.filter((s) => s.t1ok === true).length, d: done.length },
    t2CorrectWhenRun: { n: t2Ran.filter((s) => s.t2ok === true).length, d: t2Ran.length },
    buckets: {
      t1Correct: done.filter((s) => s.t1ok === true).length,
      t1WrongT2Caught: t1Wrong.filter((s) => s.t2ran && s.t2ok === true).length,
      bothWrong: t1Wrong.filter((s) => !s.t2ran || s.t2ok === false).length,
      t1WrongGateFail: t1Wrong.filter((s) => !s.gate).length,
      t1WrongGatePassed: t1Wrong.filter((s) => s.gate).length,
    },
    lat: {
      extractTotal: latStat(L("extractTotalMs")),
      gcv: latStat(L("gcvMs")),
      claude: latStat(L("claudeMs")),
      client: latStat(L("clientMs")),
    },
  };
}

const summaryKey = (version: string, day: string): string =>
  `sessions/_summary/v${version}/${day}.json`;

/** Stats for one (version, day) cell: cached when sealed, fresh otherwise. */
async function cellStats(
  prefix: string,
  version: string,
  day: string,
  ids: string[],
): Promise<SessionStat[]> {
  const sealed = isSealed(day);
  if (sealed) {
    const cached: DaySummaryFile | null = await getJson(summaryKey(version, day));
    if (cached && cached.schema === SCHEMA) return cached.sessions;
  }
  const sessions: SessionStat[] = [];
  for (const id of ids) {
    const r = await buildRow(prefix, id);
    if (r) sessions.push(toStat(r));
  }
  if (sealed) {
    const file: DaySummaryFile = {
      schema: SCHEMA,
      version: version,
      day: day,
      computedAt: new Date().toISOString(),
      sessions: sessions,
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: summaryKey(version, day),
        Body: JSON.stringify(file, null, 2),
        ContentType: "application/json",
      }),
    );
  }
  return sessions;
}

async function compute(appVersion: string): Promise<DashPayload> {
  const byDay = new Map<string, SessionStat[]>();
  const byVersion = new Map<string, SessionStat[]>();
  const all: SessionStat[] = [];

  for (const prefix of await listVersionPrefixes()) {
    const version = prefix.match(/v([^/]+)\/$/)![1];
    const idsByDay = new Map<string, string[]>();
    for (const id of await collectIds(prefix)) {
      const day = dayOf(Number(id.split("-")[0]));
      (idsByDay.get(day) ?? idsByDay.set(day, []).get(day)!).push(id);
    }
    for (const [day, ids] of idsByDay) {
      const stats = await cellStats(prefix, version, day, ids);
      all.push(...stats);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(...stats);
      (byVersion.get(version) ?? byVersion.set(version, []).get(version)!).push(...stats);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    appVersion: appVersion,
    totals: agg(all),
    byDay: [...byDay.keys()]
      .sort()
      .reverse()
      .slice(0, MAX_DAYS)
      .map((day) => ({ key: day, sealed: isSealed(day), ...agg(byDay.get(day)!) })),
    byVersion: [...byVersion.keys()]
      .sort()
      .reverse()
      .map((v) => ({ key: v, ...agg(byVersion.get(v)!) })),
  };
}

let memo: { at: number; payload: Promise<DashPayload> } | null = null;

/** Full dashboard payload, memoized in-process (bounds S3 sweeps to 1/min). */
export function dashStats(appVersion: string): Promise<DashPayload> {
  if (!memo || Date.now() - memo.at > MEMO_TTL_MS) {
    const payload = compute(appVersion);
    memo = { at: Date.now(), payload: payload };
    // a failed sweep shouldn't get pinned for the full TTL
    payload.catch(() => {
      if (memo?.payload === payload) memo = null;
    });
  }
  return memo.payload;
}
