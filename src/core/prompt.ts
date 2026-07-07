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
  "- Charset: A-Z and 0-9 only. Output uppercase.\n" +
  "- The code is USER-GENERATED and arbitrary. It is NOT a real word and is not " +
  "guaranteed pronounceable. Do NOT 'correct' it toward any real or plausible " +
  "word. Transcribe each glyph literally, exactly as drawn, even if the result " +
  "looks like nonsense.\n" +
  "- People often DOODLE small drawings next to or around the code (a baseball, " +
  "heart, star, smiley, underline). Drawings are NOT characters — do not " +
  "transcribe them. In particular, a round shape with interior detail (stitch " +
  "marks, a face, a pattern) is a drawing, not an O or 0. EXCEPTION: when such " +
  "a drawing sits INLINE with the lettering — between glyphs, on the same " +
  "baseline, at glyph size — the writer may have drawn it AS a character " +
  "(e.g. a soccer ball as an O). Still keep it out of `code`, but add the " +
  "full reading that includes it to `alternatives`.\n" +
  "- Signs are reused every year and old codes get cleaned off. You may see " +
  "faint GHOST strokes of a previous code. Transcribe only the bold, " +
  "high-contrast current lettering; ignore faint remnants.\n" +
  "- When the same letter repeats consecutively (OO, OOO, LLL), COUNT the " +
  "repeats one stroke at a time — undercounting a run is a common error. If " +
  "unsure between two counts, put the other count in `alternatives`.\n" +
  "- If a glyph is genuinely ambiguous (e.g. M vs N, U vs V, 5 vs S, 0 vs O), " +
  "compare it against how this writer formed the same letters elsewhere in the " +
  "code — writers are consistent. Decide on letterFORM evidence only, never on " +
  "which reading makes a nicer word. Pick your single best LITERAL reading " +
  "for `code`, and list other plausible literal readings of the FULL code in " +
  "`alternatives`.\n" +
  // per_char_confidence was dropped from the contract 2026-07-06: nothing
  // consumed it (the shipped gate uses GCV confidences) and latency scales
  // with output tokens — same accuracy, ~15% faster (see speed-push runs).
  // parseTranscription still accepts it, so old caches stay readable.
  "Return ONLY strict JSON, no prose and no markdown fences:\n" +
  '{"code": "<string>", "alternatives": ["<full-code alternative>", ...]}';

export interface Transcription {
  code: string;
  perCharConfidence?: number[];
  alternatives?: string[];
}

/** Pull the first JSON object out of an LLM response, tolerating fences/prose.
 * "First" is load-bearing: models occasionally emit the object twice (or trail
 * prose), and a first-{ .. last-} slice spans the duplicates and fails to
 * parse — so walk to the first BALANCED closing brace instead. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  // strip ```json ... ``` fences if present
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in response: ${text.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error(`no JSON object in response: ${text.slice(0, 200)}`);
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
