import type { RunRecord } from "./types";

/**
 * Normalize for scoring: uppercase and strip whitespace. Submission at
 * play.aadl.org is case-insensitive and strips spaces, so we mirror that.
 */
export function normalize(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

export function exactMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Character error rate = edit distance / truth length (on normalized strings). */
export function cer(predicted: string, truth: string): number {
  const p = normalize(predicted);
  const t = normalize(truth);
  if (t.length === 0) return p.length === 0 ? 0 : 1;
  return levenshtein(p, t) / t.length;
}

export interface CalibrationBucket {
  label: string;
  lo: number;
  hi: number;
  n: number;
  correct: number;
  accuracy: number;
}

/**
 * Bucket predictions by min per-char confidence and report exact-match accuracy
 * per bucket. Answers: does low reported confidence actually predict errors?
 * Records without a confidence signal (or with errors) are skipped.
 */
export function calibrationBuckets(records: RunRecord[]): CalibrationBucket[] {
  const edges = [0, 0.5, 0.7, 0.9, 1.0001];
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const label = i === edges.length - 2 ? `[${lo.toFixed(2)}, 1.00]` : `[${lo.toFixed(2)}, ${hi.toFixed(2)})`;
    const inBucket = records.filter(
      (r) => r.error === null && r.minConfidence !== null && r.minConfidence >= lo && r.minConfidence < hi,
    );
    const correct = inBucket.filter((r) => r.exactMatch).length;
    buckets.push({
      label,
      lo,
      hi,
      n: inBucket.length,
      correct,
      accuracy: inBucket.length ? correct / inBucket.length : 0,
    });
  }
  return buckets;
}
