/**
 * Shared literal-transcription prompt + JSON contract for the LLM readers
 * (Claude and Nova use it identically for a fair comparison). The core rule:
 * do NOT guess toward real words — the code is user-generated and arbitrary.
 */

export const READER_SYSTEM =
  "You are a faithful OCR transcription engine. You will be shown a photo of an " +
  "AADL Summer Game sign (a circular sign), or a cropped close-up of one. " +
  "Somewhere in the image is a single HANDWRITTEN code. Transcribe ONLY that " +
  "handwritten code.";

export const READER_USER =
  "Rules:\n" +
  "- Ignore ALL printed text (e.g. 'play.aadl.org', 'WE PLAY THE SUMMER GAME', " +
  "ring text, footer). Read ONLY the handwritten code, usually written in a " +
  "white horizontal band.\n" +
  "- Charset: A-Z and 0-9 only. Output uppercase. Maximum 12 characters.\n" +
  "- The code is USER-GENERATED and arbitrary. It is NOT a real word and is not " +
  "guaranteed pronounceable. Do NOT 'correct' it toward any real or plausible " +
  "word. Transcribe each glyph literally, exactly as drawn, even if the result " +
  "looks like nonsense.\n" +
  "- If a glyph is genuinely ambiguous, pick your single best LITERAL reading " +
  "for `code`, and list other plausible literal readings of the FULL code in " +
  "`alternatives`.\n" +
  "Return ONLY strict JSON, no prose and no markdown fences:\n" +
  '{"code": "<string>", "per_char_confidence": [<0..1 for each character>], ' +
  '"alternatives": ["<full-code alternative>", ...]}';

export interface Transcription {
  code: string;
  perCharConfidence?: number[];
  alternatives?: string[];
}

/** Pull the first JSON object out of an LLM response, tolerating fences/prose. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  // strip ```json ... ``` fences if present
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(t.slice(start, end + 1));
}

export function parseTranscription(text: string): Transcription {
  const obj = extractJsonObject(text) as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : String(obj.code ?? "");
  const perCharConfidence = Array.isArray(obj.per_char_confidence)
    ? obj.per_char_confidence.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : undefined;
  const alternatives = Array.isArray(obj.alternatives)
    ? obj.alternatives.map((a) => String(a))
    : undefined;
  return { code, perCharConfidence, alternatives };
}
