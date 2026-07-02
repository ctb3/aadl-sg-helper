import crypto from "node:crypto";
import { config } from "./config";
import { READER_SYSTEM, READER_USER } from "./prompt";
import type { Arm, ReaderName } from "./types";

export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Prompt-sensitive readers get a prompt hash in their cache key, so editing
// prompt.ts invalidates only their caches (old results stay on disk for
// comparison instead of being clobbered by --force).
const promptHash = crypto
  .createHash("sha1")
  .update(READER_SYSTEM + "\n" + READER_USER)
  .digest("hex")
  .slice(0, 8);

/**
 * Cache-key suffix identifying everything that influenced a prediction:
 * reader model + prompt for the LLM readers; localizer model too on the
 * model_crop arm, since the crop itself depends on it. Textract/GCV have no
 * model or prompt choice.
 */
export function modelTag(reader: ReaderName, arm: Arm): string {
  let tag = "";
  if (reader === "claude") tag += "__" + sanitize(config.claudeModel) + "__p" + promptHash;
  if (reader === "nova") tag += "__" + sanitize(config.novaModel) + "__p" + promptHash;
  if (arm === "model_crop") tag += "__loc-" + sanitize(config.localizerModel);
  return tag;
}
