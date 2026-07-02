import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config";

const client = new BedrockRuntimeClient({ region: config.awsRegion });

export interface VisionCall {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface VisionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  raw: unknown;
}

/**
 * Single multimodal call via the Bedrock Converse API. Works uniformly for
 * Claude and Nova family models. For Claude we disable thinking (unless
 * configured off) so the model returns literal JSON fast without spending the
 * token budget on reasoning.
 */
export async function converseVision(
  modelId: string,
  imageJpeg: Buffer,
  call: VisionCall,
): Promise<VisionResult> {
  const isClaude = /anthropic|claude/i.test(modelId);
  const disableThinking = isClaude && config.claudeThinking === "disabled";

  const content: ContentBlock[] = [
    { image: { format: "jpeg", source: { bytes: new Uint8Array(imageJpeg) } } },
    { text: call.user },
  ];

  const cmd = new ConverseCommand({
    modelId,
    system: [{ text: call.system }],
    messages: [{ role: "user", content }],
    inferenceConfig: { maxTokens: call.maxTokens ?? 1024 },
    ...(disableThinking
      ? { additionalModelRequestFields: { thinking: { type: "disabled" } } }
      : {}),
  });

  const t0 = Date.now();
  const resp = await client.send(cmd);
  const latencyMs = Date.now() - t0;

  const text = (resp.output?.message?.content ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim();

  return {
    text,
    inputTokens: resp.usage?.inputTokens ?? 0,
    outputTokens: resp.usage?.outputTokens ?? 0,
    latencyMs,
    raw: resp,
  };
}
