import vision from "@google-cloud/vision";
import { config } from "../config";
import type { Arm, Reader, ReaderResult } from "../types";

const client = new vision.ImageAnnotatorClient();

interface Sym {
  ch: string;
  conf: number;
  cx: number; // normalized center x
  cy: number; // normalized center y
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
    const [result] = await client.documentTextDetection({ image: { content: image } });
    const latencyMs = Date.now() - t0;

    const fta: any = result.fullTextAnnotation;
    const page: any = fta?.pages?.[0];
    const pw: number = page?.width || 0;
    const ph: number = page?.height || 0;

    const symbols: Sym[] = [];
    for (const block of page?.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? []) {
          for (const sym of word.symbols ?? []) {
            const text: string = sym.text ?? "";
            const vertices = sym.boundingBox?.vertices ?? [];
            const xs = vertices.map((v: any) => v.x ?? 0);
            const ys = vertices.map((v: any) => v.y ?? 0);
            const cx = pw ? (xs.reduce((a: number, b: number) => a + b, 0) / (xs.length || 1)) / pw : 0.5;
            const cy = ph ? (ys.reduce((a: number, b: number) => a + b, 0) / (ys.length || 1)) / ph : 0.5;
            symbols.push({ ch: text, conf: typeof sym.confidence === "number" ? sym.confidence : 0, cx, cy });
          }
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
        rawResponse: { text: fta?.text ?? "", note: "band empty; used longest [A-Z0-9] token" },
        latencyMs,
        costUsd: config.cost.gcvPerImage,
      };
    }

    const code = chosen.map((s) => s.ch).join("");
    const perCharConfidence = chosen.map((s) => s.conf);

    return {
      code,
      perCharConfidence,
      rawResponse: { text: fta?.text ?? "", keptSymbols: chosen.length, totalSymbols: symbols.length },
      latencyMs,
      costUsd: config.cost.gcvPerImage,
    };
  },
};
