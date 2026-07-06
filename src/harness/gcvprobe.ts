import fs from "node:fs";
import path from "node:path";
import vision from "@google-cloud/vision";
import { config } from "../core/config";

/**
 * GCV latency probe: repeated documentTextDetection on ONE image, no hedge,
 * gRPC and REST transports interleaved so both sample the same time window.
 * Distinguishes client-library/channel trouble (one transport slow) from
 * service-side latency (both slow) from episodic spikes (occasional outliers
 * on both). Paid: N calls x $0.0015.
 *
 *   npx tsx src/harness/gcvprobe.ts [--n 20] [--image path] [--transport both|grpc|rest]
 */

const args = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const perTransport = Number(flag("n", "20"));
const transports = flag("transport", "both") === "both" ? ["grpc", "rest"] : [flag("transport", "both")];
const imagePath = flag(
  "image",
  path.join(config.preppedDir, fs.readdirSync(config.preppedDir).find((f) => f.endsWith(".e2400.jpg")) ?? ""),
);

const creds = process.env.GCP_SA_KEY_JSON ? { credentials: JSON.parse(process.env.GCP_SA_KEY_JSON) } : {};
const clients: Record<string, InstanceType<typeof vision.ImageAnnotatorClient>> = {};
for (const t of transports) {
  clients[t] = new vision.ImageAnnotatorClient({ ...creds, ...(t === "rest" ? { fallback: true } : {}) });
}

const image = fs.readFileSync(imagePath);
console.log(`image: ${imagePath} (${image.length} bytes)`);
console.log(`n: ${perTransport} per transport [${transports.join(", ")}], interleaved, no hedge\n`);

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const results: Record<string, number[]> = Object.fromEntries(transports.map((t) => [t, []]));
  const errors: Record<string, string[]> = Object.fromEntries(transports.map((t) => [t, []]));

  for (let i = 0; i < perTransport; i++) {
    for (const t of transports) {
      const t0 = Date.now();
      try {
        await clients[t].documentTextDetection({ image: { content: image } });
        const ms = Date.now() - t0;
        results[t].push(ms);
        console.log(`${String(i + 1).padStart(3)} ${t.padEnd(4)} ${ms}ms${i === 0 ? "  (first call: includes auth/channel setup)" : ""}`);
      } catch (err: any) {
        errors[t].push(String(err?.message ?? err));
        console.log(`${String(i + 1).padStart(3)} ${t.padEnd(4)} ERROR ${Date.now() - t0}ms: ${err?.message ?? err}`);
      }
    }
  }

  console.log("\n--- summary ---");
  for (const t of transports) {
    const all = [...results[t]].sort((a, b) => a - b);
    // First call carries one-time auth/channel setup; report warm separately.
    const warm = [...results[t].slice(1)].sort((a, b) => a - b);
    const fmt = (s: number[]) =>
      s.length ? `p50 ${pct(s, 50)}  p90 ${pct(s, 90)}  max ${s[s.length - 1]}  (n=${s.length})` : "no data";
    console.log(`${t}: all ${fmt(all)}`);
    console.log(`${" ".repeat(t.length)}  warm ${fmt(warm)}  errors=${errors[t].length}`);
    for (const e of errors[t]) console.log(`   err: ${e}`);
  }
}

main();
