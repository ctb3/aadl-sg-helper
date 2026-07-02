import { levenshtein } from "./score";

/**
 * Post-processing strategies for the geometry-aware readers (GCV, Textract).
 *
 * The sign's printed copy is fixed and known, and the handwritten code is
 * written far larger than any printed text. That gives two engine-agnostic
 * isolation signals that need no ML:
 *   1. glyph height  — pick the tallest line of text
 *   2. known phrases — subtract lines that match the sign's printed copy
 * Both operate on "lines" (text + mean glyph height + confidences), which each
 * reader adapter constructs from its cached raw response.
 */

export interface Line {
  text: string; // raw text as read (may include spaces/punct)
  h: number; // normalized mean glyph height
  cy: number; // normalized vertical center (for ordering)
  confs: number[]; // per-char confidence for the alphanumeric chars
}

export interface StrategyResult {
  code: string;
  minConf: number | null;
}

export interface WordLike {
  text: string;
  cx: number;
  cy: number;
  h: number; // normalized glyph height (word bbox, NOT line bbox — line boxes
  // around the curved ring text are inflated and break height ranking)
  confs: number[]; // per-char confidence for the alphanumeric chars
}

/**
 * Group words into visual lines: vertically close AND similar glyph height —
 * the huge handwriting must not absorb the small printed lines above/below it.
 */
export function groupIntoLines(words: WordLike[]): Line[] {
  interface Acc {
    words: WordLike[];
    cy: number;
    h: number;
  }
  const accs: Acc[] = [];
  for (const w of words) {
    if (w.h <= 0) continue;
    const hit = accs.find(
      (a) =>
        Math.abs(a.cy - w.cy) < 0.6 * Math.min(a.h, w.h) &&
        Math.max(a.h, w.h) / Math.min(a.h, w.h) <= 2.5,
    );
    if (hit) {
      hit.words.push(w);
      hit.cy = hit.words.reduce((s, x) => s + x.cy, 0) / hit.words.length;
      hit.h = Math.max(hit.h, w.h);
    } else {
      accs.push({ words: [w], cy: w.cy, h: w.h });
    }
  }
  return accs.map((a) => {
    const ws = [...a.words].sort((x, y) => x.cx - y.cx);
    const hs = ws.map((w) => w.h);
    return {
      text: ws.map((w) => w.text).join(" "),
      h: hs.reduce((x, y) => x + y, 0) / hs.length,
      cy: a.cy,
      confs: ws.flatMap((w) => w.confs),
    };
  });
}

export const alnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function sim(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Every printed phrase on the sign (both the classic and the 2026 "checkbox"
 * variants), normalized to [A-Z0-9]. Lines are matched fuzzily, so partial /
 * garbled OCR reads of these still count as printed.
 */
export const SIGN_PHRASES: string[] = [
  "PLAYAADLORG",
  "WEPLAYTHE",
  "SUMMERGAME",
  "WEPLAYTHESUMMERGAME",
  "WRITEYOURCODEINTHISSPACETHENCLEANITOFFATTHEENDOFTHESUMMERUSETHISSIGNAGAINNEXTYEAR",
  "CHECKTHISBOXWHENYOUVEREGISTEREDYOURCODEATAADLORGLAWNCODES",
  "WHATISTHISITSANAADLSUMMERGAMECODE",
  "TOPLAYTHEGAMEVISITPLAYAADLORG",
  "QUESTIONSORCOMMENTSEMAILASKAADLORG",
  "ORTEXT7343274200",
];

const PHRASE_SIM_THRESHOLD = 0.7;
const PHRASE_COVERAGE_THRESHOLD = 0.6;

// All 6-grams of the printed copy, for coverage matching: OCR sometimes merges
// several printed lines into one ("ADLORGWEPLAYTHEPLAYAADLORG…"), which fuzzy
// whole-line matching misses but n-gram coverage catches.
const PHRASE_6GRAMS = new Set<string>();
for (const p of SIGN_PHRASES) {
  for (let i = 0; i + 6 <= p.length; i++) PHRASE_6GRAMS.add(p.slice(i, i + 6));
}

/** Fraction of the line's alphanumeric chars covered by 6-grams of printed copy. */
function phraseCoverage(a: string): number {
  if (a.length < 6) return 0;
  const covered = new Array<boolean>(a.length).fill(false);
  for (let i = 0; i + 6 <= a.length; i++) {
    if (PHRASE_6GRAMS.has(a.slice(i, i + 6))) {
      for (let j = i; j < i + 6; j++) covered[j] = true;
    }
  }
  return covered.filter(Boolean).length / a.length;
}

/**
 * Is this line printed sign copy (or OCR garbage from the curved ring text)
 * rather than a candidate handwritten code?
 *
 * Known blind spot, accepted: a handwritten code that IS one of the printed
 * phrases (e.g. someone writes "SUMMERGAME") gets subtracted too.
 */
export function isPrintedLine(text: string): boolean {
  const a = alnum(text);
  if (!a) return true;

  // Ring text: "play.aadl.org" repeated around the circle (any fragment with
  // AADL twice can't be a ≤12-char code).
  if ((a.match(/AADL/g)?.length ?? 0) >= 2) return true;

  // Mostly made of known printed copy (handles merged/concatenated lines).
  if (phraseCoverage(a) >= PHRASE_COVERAGE_THRESHOLD) return true;

  // Upside-down ring text misreads repeat the same token ("held 6101pee held
  // 6101pee held…"). A ≤12-char code can't repeat a token 3+ times.
  const tokens = text
    .toUpperCase()
    .split(/\s+/)
    .map(alnum)
    .filter((t) => t.length >= 2);
  const counts = new Map<string, number>();
  for (const t of tokens) {
    const n = (counts.get(t) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(t, n);
  }

  for (const p of SIGN_PHRASES) {
    if (sim(a, p) >= PHRASE_SIM_THRESHOLD) return true;
    // OCR often splits a phrase across lines; fragments of known copy are
    // printed too (min length 3 to avoid nuking short codes by accident).
    if (a.length >= 3 && p.includes(a)) return true;
  }
  return false;
}

function pick(lines: Line[]): StrategyResult {
  if (lines.length === 0) return { code: "", minConf: null };
  const code = lines.map((l) => alnum(l.text)).join("");
  const confs = lines.flatMap((l) => l.confs);
  return { code, minConf: confs.length ? Math.min(...confs) : null };
}

/** Tallest line wins — pure geometry, no knowledge of the sign's copy. */
export function tallestLine(lines: Line[]): StrategyResult {
  const withText = lines.filter((l) => alnum(l.text).length > 0);
  if (withText.length === 0) return { code: "", minConf: null };
  const best = withText.reduce((a, b) => (b.h > a.h ? b : a));
  return pick([best]);
}

/** Subtract known printed copy, keep everything else (top-to-bottom). */
export function phraseSubtract(lines: Line[]): StrategyResult {
  const kept = lines
    .filter((l) => !isPrintedLine(l.text))
    .sort((a, b) => a.cy - b.cy);
  return pick(kept);
}

/** Subtract known printed copy, then take the tallest survivor. */
export function combined(lines: Line[]): StrategyResult {
  return tallestLine(lines.filter((l) => !isPrintedLine(l.text)));
}
