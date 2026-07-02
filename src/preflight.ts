import sharp from "sharp";
import { config } from "./config";
import { converseVision } from "./bedrock";

/**
 * Preflight: one tiny call per cloud dependency (each a fraction of a cent) so
 * creds / Bedrock model-access / API-enablement gaps surface *before* a real
 * run. Exits 0 only if every check passes.
 */

async function tinyImage(): Promise<Buffer> {
  return sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .jpeg()
    .toBuffer();
}

interface Check {
  name: string;
  run: (img: Buffer) => Promise<string>;
}

async function bedrockCheck(modelId: string, img: Buffer): Promise<string> {
  const res = await converseVision(modelId, img, {
    system: "You are a test probe.",
    user: 'Reply with exactly: {"ok":true}',
    maxTokens: 64,
  });
  return `responded (${res.latencyMs}ms, ${res.outputTokens} out-tok)`;
}

const checks: Check[] = [
  { name: `bedrock claude  (${config.claudeModel})`, run: (img) => bedrockCheck(config.claudeModel, img) },
  { name: `bedrock nova    (${config.novaModel})`, run: (img) => bedrockCheck(config.novaModel, img) },
  { name: `bedrock localizer (${config.localizerModel})`, run: (img) => bedrockCheck(config.localizerModel, img) },
  {
    name: "textract",
    run: async (img) => {
      const { TextractClient, DetectDocumentTextCommand } = await import("@aws-sdk/client-textract");
      const client = new TextractClient({ region: config.awsRegion });
      const t0 = Date.now();
      const resp = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: new Uint8Array(img) } }));
      return `responded (${Date.now() - t0}ms, ${resp.Blocks?.length ?? 0} blocks)`;
    },
  },
  {
    name: "google cloud vision",
    run: async (img) => {
      const vision = (await import("@google-cloud/vision")).default;
      const client = new vision.ImageAnnotatorClient();
      const t0 = Date.now();
      await client.documentTextDetection({ image: { content: img } });
      return `responded (${Date.now() - t0}ms)`;
    },
  },
];

async function main(): Promise<void> {
  console.log(`Preflight — region=${config.awsRegion}\n`);
  const img = await tinyImage();
  let failures = 0;
  for (const check of checks) {
    try {
      const detail = await check.run(img);
      console.log(`  ✓ ${check.name}: ${detail}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${check.name}: ${msg.split("\n")[0]}`);
    }
  }
  console.log(failures === 0 ? "\nAll checks passed — ready to bake." : `\n${failures} check(s) failed — fix before running the bake-off.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
