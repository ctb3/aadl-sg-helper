import { config, tokenCost } from "../config";
import { converseVision } from "../bedrock";
import { READER_SYSTEM, READER_USER, parseTranscription } from "../prompt";
import type { Arm, Reader, ReaderResult } from "../types";

export const claudeReader: Reader = {
  name: "claude",
  async read(image: Buffer, _arm: Arm): Promise<ReaderResult> {
    const res = await converseVision(config.claudeModel, image, {
      system: READER_SYSTEM,
      user: READER_USER,
      maxTokens: 1024,
    });
    const t = parseTranscription(res.text);
    return {
      code: t.code,
      perCharConfidence: t.perCharConfidence,
      alternatives: t.alternatives,
      rawResponse: { text: res.text, usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens } },
      latencyMs: res.latencyMs,
      costUsd: tokenCost(res.inputTokens, res.outputTokens, config.cost.claudeInPerMTok, config.cost.claudeOutPerMTok),
    };
  },
};
