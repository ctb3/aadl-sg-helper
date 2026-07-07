import vision from "@google-cloud/vision";
import { config } from "../config";
import type { Arm, Reader, ReaderResult } from "../types";

// Lambda has no key file on disk, so the service-account key arrives inline in
// GCP_SA_KEY_JSON; locally GOOGLE_APPLICATION_CREDENTIALS (a path) keeps
// working. Created on first use, not at import: on Lambda the key is fetched
// from SSM during startup (src/app/secrets.ts), after modules have loaded.
let _client: InstanceType<typeof vision.ImageAnnotatorClient> | undefined;
function client() {
  _client ??= process.env.GCP_SA_KEY_JSON
    ? new vision.ImageAnnotatorClient({ credentials: JSON.parse(process.env.GCP_SA_KEY_JSON) })
    : new vision.ImageAnnotatorClient();
  return _client;
}

/** Hedge outcome, logged in rawResponse (→ session extract.json) only when the
 * hedge actually fired: a winner latency far above the threshold means BOTH
 * attempts were slow — a correlated service-side episode no hedge can cap
 * (2026-07-06 evening: 10/13 prod sessions at 3.3-20s with the hedge active). */
export interface GcvHedge {
  fired: true;
  winner: "primary" | "hedge";
}

/** documentTextDetection with a hedged second attempt: GCV showed service-side
 * latency spikes in the field (median 659ms, spikes to 30s — 2026-07-06 batch;
 * same images fast on retry), and one duplicate call ($0.0015) caps that tail
 * at ~hedge+p50. The timer is cancelled the moment the first attempt settles,
 * so the hedge only ever fires — and only ever bills — on a slow call.
 * GCV_HEDGE_MS <= 0 disables. */
async function detectHedged(image: Buffer): Promise<{ result: [any]; hedge?: GcvHedge }> {
  const attempt = (): Promise<[any]> => client().documentTextDetection({ image: { content: image } }) as Promise<[any]>;
  if (config.gcvHedgeMs <= 0) return { result: await attempt() };
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const primary = attempt().then((r) => ({ r, who: "primary" as const }));
  const hedge = new Promise<{ r: [any]; who: "hedge" }>((resolve, reject) => {
    timer = setTimeout(() => {
      fired = true;
      attempt().then((r) => resolve({ r, who: "hedge" }), reject);
    }, config.gcvHedgeMs);
  });
  try {
    // Promise.any: first FULFILLED wins; a fast primary failure just waits for
    // the hedge (a natural retry). Both failing surfaces the primary's error.
    const { r, who } = await Promise.any([primary, hedge]);
    return { result: r, hedge: fired ? { fired, winner: who } : undefined };
  } catch (err) {
    throw (err as AggregateError).errors?.[0] ?? err;
  } finally {
    clearTimeout(timer);
  }
}

interface Sym {
  ch: string;
  conf: number;
  cx: number; // normalized center x
  cy: number; // normalized center y
  h: number; // normalized glyph height
  w: number; // normalized glyph width
}

// Persisted in rawResponse so post-processing strategies (height filters,
// phrase subtraction) can be re-scored offline without re-calling the API.
export interface GcvWord {
  text: string;
  conf: number;
  cx: number;
  cy: number;
  h: number;
  w: number;
  syms: Sym[];
}

/**
 * Google Cloud Vision is a faithful glyph reader with per-symbol confidence, but
 * has NO print/handwriting flag — so in the `none` arm it must isolate the code
 * from a blob of printed text using a spatial heuristic (the lower-center white
 * band). In the `model_crop` arm the image is already the code, so we skip the
 * band filter. This asymmetry is part of what the bake-off measures.
 */
export const gcvReader: Reader = {
  name: "gcv",
  async read(image: Buffer, arm: Arm): Promise<ReaderResult> {
    const t0 = Date.now();
    const { result: [result], hedge } = await detectHedged(image);
    const latencyMs = Date.now() - t0;

    const fta: any = result.fullTextAnnotation;
    const page: any = fta?.pages?.[0];
    const pw: number = page?.width || 0;
    const ph: number = page?.height || 0;

    const geom = (bb: any): { cx: number; cy: number; h: number; w: number } => {
      const vertices = bb?.vertices ?? [];
      const xs = vertices.map((v: any) => v.x ?? 0);
      const ys = vertices.map((v: any) => v.y ?? 0);
      const cx = pw ? xs.reduce((a: number, b: number) => a + b, 0) / (xs.length || 1) / pw : 0.5;
      const cy = ph ? ys.reduce((a: number, b: number) => a + b, 0) / (ys.length || 1) / ph : 0.5;
      const h = ph && ys.length ? (Math.max(...ys) - Math.min(...ys)) / ph : 0;
      const w = pw && xs.length ? (Math.max(...xs) - Math.min(...xs)) / pw : 0;
      return { cx, cy, h, w };
    };

    const symbols: Sym[] = [];
    const words: GcvWord[] = [];
    for (const block of page?.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? []) {
          const syms: Sym[] = [];
          for (const sym of word.symbols ?? []) {
            const s: Sym = {
              ch: sym.text ?? "",
              conf: typeof sym.confidence === "number" ? sym.confidence : 0,
              ...geom(sym.boundingBox),
            };
            syms.push(s);
            symbols.push(s);
          }
          words.push({
            text: syms.map((s) => s.ch).join(""),
            conf: typeof word.confidence === "number" ? word.confidence : 0,
            ...geom(word.boundingBox),
            syms,
          });
        }
      }
    }

    // Document order is reading order; filter to the band for the `none` arm.
    const b = config.gcvBand;
    const kept =
      arm === "none"
        ? symbols.filter((s) => s.cy >= b.top && s.cy <= b.bottom && s.cx >= b.left && s.cx <= b.right)
        : symbols;

    let chosen = kept.filter((s) => /[A-Za-z0-9]/.test(s.ch));

    // Fallback: if the band produced nothing, take the longest alphanumeric run
    // from the full detected text.
    if (chosen.length === 0) {
      const full = (fta?.text ?? "").toUpperCase();
      const tokens = full.match(/[A-Z0-9]+/g) ?? [];
      const longest = tokens.sort((a: string, z: string) => z.length - a.length)[0] ?? "";
      return {
        code: longest,
        rawResponse: {
          text: fta?.text ?? "",
          note: "band empty; used longest [A-Z0-9] token",
          words,
          ...(hedge && { hedge }),
        },
        latencyMs,
        costUsd: config.cost.gcvPerImage,
      };
    }

    const code = chosen.map((s) => s.ch).join("");
    const perCharConfidence = chosen.map((s) => s.conf);

    return {
      code,
      perCharConfidence,
      rawResponse: {
        text: fta?.text ?? "",
        keptSymbols: chosen.length,
        totalSymbols: symbols.length,
        words,
        ...(hedge && { hedge }),
      },
      latencyMs,
      costUsd: config.cost.gcvPerImage,
    };
  },
};
