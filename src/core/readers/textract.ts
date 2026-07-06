import {
  TextractClient,
  DetectDocumentTextCommand,
  type Block,
} from "@aws-sdk/client-textract";
import { config } from "../config";
import type { Arm, Reader, ReaderResult } from "../types";

const client = new TextractClient({ region: config.awsRegion });

/**
 * Textract's real advantage on this noisy sign: WORD blocks are tagged
 * PRINTED vs HANDWRITING. We keep only HANDWRITING words, order them
 * top-to-bottom / left-to-right, and concatenate. This filter applies in both
 * arms (on the crop it's typically just the code anyway).
 */
export const textractReader: Reader = {
  name: "textract",
  async read(image: Buffer, _arm: Arm): Promise<ReaderResult> {
    const t0 = Date.now();
    const resp = await client.send(
      new DetectDocumentTextCommand({ Document: { Bytes: new Uint8Array(image) } }),
    );
    const latencyMs = Date.now() - t0;

    const handwritten = (resp.Blocks ?? []).filter(
      (b): b is Block => b.BlockType === "WORD" && b.TextType === "HANDWRITING",
    );

    handwritten.sort((a, b) => {
      const at = a.Geometry?.BoundingBox?.Top ?? 0;
      const bt = b.Geometry?.BoundingBox?.Top ?? 0;
      // treat words within ~one line height as same line
      if (Math.abs(at - bt) > 0.05) return at - bt;
      return (a.Geometry?.BoundingBox?.Left ?? 0) - (b.Geometry?.BoundingBox?.Left ?? 0);
    });

    const code = handwritten.map((b) => b.Text ?? "").join("");
    // Replicate each word's confidence (0-100 → 0-1) across its characters.
    const perCharConfidence: number[] = [];
    for (const b of handwritten) {
      const conf = (b.Confidence ?? 0) / 100;
      for (let i = 0; i < (b.Text?.length ?? 0); i++) perCharConfidence.push(conf);
    }

    return {
      code,
      perCharConfidence: perCharConfidence.length ? perCharConfidence : undefined,
      rawResponse: { blocks: resp.Blocks },
      latencyMs,
      costUsd: config.cost.textractPerPage,
    };
  },
};
