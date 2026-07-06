import { config, tokenCost } from "../core/config";
import { converseVision } from "../core/bedrock";
import { extractJsonObject } from "../core/prompt";
import type { BBox } from "../core/types";

const LOCALIZER_SYSTEM =
  "You locate the handwritten code region on an AADL Summer Game sign.";

const LOCALIZER_USER =
  "Find the HANDWRITTEN code on this sign (large marker lettering, usually in " +
  "a white horizontal band). Look carefully at where the handwriting actually " +
  "is in THIS photo — the sign may fill any part of the frame at any angle.\n" +
  "Return the TIGHT bounding box around the handwritten lettering only — " +
  "exclude all printed text above and below it.\n" +
  "Return ONLY strict JSON, normalized coordinates in [0,1], origin top-left:\n" +
  '{"x0":<left>,"y0":<top>,"x1":<right>,"y1":<bottom>}\n' +
  'If there is no handwriting, return {"found":false}.';

export interface LocalizeResult {
  bbox: BBox;
  latencyMs: number;
  costUsd: number;
  raw: unknown;
}

const FALLBACK: BBox = { x0: 0.1, y0: 0.55, x1: 0.9, y1: 0.85 };

/** One cheap vision call → normalized bbox of the handwritten code. */
export async function localize(image: Buffer): Promise<LocalizeResult> {
  const res = await converseVision(config.localizerModel, image, {
    system: LOCALIZER_SYSTEM,
    user: LOCALIZER_USER,
    maxTokens: 256,
  });
  const cost = tokenCost(
    res.inputTokens,
    res.outputTokens,
    config.cost.localizerInPerMTok,
    config.cost.localizerOutPerMTok,
  );

  let bbox = FALLBACK;
  try {
    const obj = extractJsonObject(res.text) as Record<string, unknown>;
    const b: BBox = {
      x0: clamp01(Number(obj.x0)),
      y0: clamp01(Number(obj.y0)),
      x1: clamp01(Number(obj.x1)),
      y1: clamp01(Number(obj.y1)),
    };
    if (isValid(b)) bbox = b;
  } catch {
    // keep fallback
  }

  return { bbox, latencyMs: res.latencyMs, costUsd: cost, raw: { text: res.text } };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : NaN;
}
function isValid(b: BBox): boolean {
  return (
    [b.x0, b.y0, b.x1, b.y1].every((n) => Number.isFinite(n)) &&
    b.x1 > b.x0 &&
    b.y1 > b.y0
  );
}
