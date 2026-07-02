export type Arm = "none" | "model_crop";
export type ReaderName = "claude" | "nova" | "textract" | "gcv";

export const ALL_READERS: ReaderName[] = ["claude", "nova", "textract", "gcv"];
export const ALL_ARMS: Arm[] = ["none", "model_crop"];

/** Normalized bounding box, fractions of image dims, origin top-left. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Engine-agnostic output of a single reader on a single image. */
export interface ReaderResult {
  /** Raw extracted code, before scoring normalization. */
  code: string;
  /** Per-character confidence in [0,1], if the engine provides it. */
  perCharConfidence?: number[];
  /** Alternative full-code readings (LLM readers only). */
  alternatives?: string[];
  /** The engine's raw response, stored for eyeball auditing. */
  rawResponse: unknown;
  latencyMs: number;
  costUsd?: number;
  /** Populated instead of a code when the call failed. */
  error?: string;
}

export interface GroundTruth {
  filename: string;
  code: string;
}

/** One scored (image × reader × arm) row. */
export interface RunRecord {
  filename: string;
  reader: ReaderName;
  arm: Arm;
  predictedRaw: string;
  predictedNorm: string;
  truthNorm: string;
  exactMatch: boolean;
  cer: number;
  /** min per-char confidence (worst glyph) — the calibration signal. */
  minConfidence: number | null;
  meanConfidence: number | null;
  alternatives: string[];
  latencyMs: number;
  costUsd: number;
  error: string | null;
}

/** A reader knows its name and can read a prepared image for a given arm. */
export interface Reader {
  name: ReaderName;
  read(image: Buffer, arm: Arm): Promise<ReaderResult>;
}
