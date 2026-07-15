import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { levenshtein } from "../core/score";
import { bucket, getJson, s3 } from "./sessions";

/**
 * Verified-code pool: one object per aadl.org-oracle-confirmed code at
 * sessions/_codes/<CODE>.json. The code IS the key, so a ListObjectsV2 sweep
 * yields the whole pool with zero GETs — that's what makes pool correction
 * (snapping a rejected OCR read to the unique known code one edit away)
 * cheap enough to run inline in /api/submit.
 *
 * Privacy: pool codes are live redeemable secrets. They must never reach the
 * public surface (/dash, /api/dash-stats, API responses beyond the single
 * corrected code the submitting client earned) — viewing the pool is the
 * admin-credentialed CLI only (sessions-report --codes).
 */

const POOL_PREFIX = "sessions/_codes/";
// Defense in depth: the code becomes an S3 key segment. handleSubmit already
// normalizes to uppercase alnum; backfill/CLI callers enter here too.
const CODE_RE = /^[A-Z0-9]{1,80}$/;
const POOL_MEMO_TTL_MS = 60_000;

export interface PoolEntry {
  code: string;
  firstSeenAt: string;
  points?: number;
  /** Creator's hidden message, boilerplate-stripped (aadl.ts hiddenMessage).
   * Absent until some account redeems the code fresh — already_redeemed
   * responses don't carry it. Raw text stays in submit.json forever. */
  message?: string;
}

const poolKey = (code: string): string => {
  if (!CODE_RE.test(code)) throw new Error(`bad pool code: ${JSON.stringify(code)}`);
  return `${POOL_PREFIX}${code}.json`;
};

/**
 * Record an oracle-confirmed code. Upgrade-once semantics: an entry with a
 * message is final; a message-less entry (seeded by already_redeemed) gets
 * upgraded when a fresh redeem supplies the message. GET-then-PUT race =
 * last-writer-wins with near-identical bodies — acceptable. Callers must
 * .catch(): a pool write must never fail a user submit.
 */
export async function recordCode(
  code: string,
  info: { points?: number | null; message?: string; firstSeenAt?: string },
): Promise<void> {
  const key = poolKey(code);
  const existing: PoolEntry | null = await getJson(key);
  if (existing?.message) return;
  if (existing && !info.message) return;
  const entry: PoolEntry = {
    code,
    // Backfill passes the historical attempt time; live submits default to now.
    firstSeenAt: existing?.firstSeenAt ?? info.firstSeenAt ?? new Date().toISOString(),
  };
  const points = info.points ?? existing?.points;
  if (typeof points === "number") entry.points = points;
  if (info.message) entry.message = info.message;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(entry, null, 2),
      ContentType: "application/json",
    }),
  );
}

async function sweepPool(): Promise<string[]> {
  const codes: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: POOL_PREFIX, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      const m = o.Key!.match(/^sessions\/_codes\/([A-Z0-9]+)\.json$/);
      if (m) codes.push(m[1]);
    }
    token = page.NextContinuationToken;
  } while (token);
  return codes;
}

let memo: { at: number; codes: Promise<string[]> } | null = null;

/** Pool code list, memoized in-process (bounds S3 sweeps to 1/min). */
export function listPool(): Promise<string[]> {
  if (!memo || Date.now() - memo.at > POOL_MEMO_TTL_MS) {
    const codes = sweepPool();
    memo = { at: Date.now(), codes: codes };
    // a failed sweep shouldn't get pinned for the full TTL
    codes.catch(() => {
      if (memo?.codes === codes) memo = null;
    });
  }
  return memo.codes;
}

/** Full pool entries (one GET per code) — offline CLI reporting only; pool
 * codes never go out through the app's public surface. */
export async function loadPoolEntries(): Promise<PoolEntry[]> {
  const codes = await sweepPool();
  const entries = await Promise.all(codes.map((c) => getJson(poolKey(c))));
  return entries.filter((e): e is PoolEntry => e !== null);
}

/**
 * The unique pool code one edit away from a rejected read, or null. Exact
 * membership returns null too — the oracle just rejected a code we believe
 * valid (stale entry), and "correcting" it would resubmit the same string.
 * Length <4 reads are too ambiguous to snap; 2+ candidates = ambiguous, skip.
 */
export function poolCandidate(code: string, pool: string[]): string | null {
  if (code.length < 4 || pool.includes(code)) return null;
  const cands = pool.filter((p) => levenshtein(code, p) === 1);
  return cands.length === 1 ? cands[0] : null;
}
