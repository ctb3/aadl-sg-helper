import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { downscaleToLongestEdge } from "../src/image";

/**
 * Local smoke client for src/app/server.ts (run with `npx tsx infra/apitest.ts`
 * so it executes on Windows node — WSL curl cannot reach Windows localhost).
 * With --full, walks the real paid API: session -> presigned upload ->
 * extract -> escalate -> verdict, using the first photo in IMAGES_DIR.
 * (A flag, not an env var: WSL env does not cross into Windows node.)
 */

const baseArg = process.argv.find((a) => a.startsWith("http"));
const BASE = baseArg ?? "http://localhost:8080";
const PIN = process.env.APP_PIN ?? "";

async function api(p: string, body?: unknown, pin = PIN): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-pin": pin },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const page = await fetch(BASE + "/");
  check("GET / serves page", page.status === 200 && (await page.text()).includes("SG Code Helper"));

  const noPin = await api("/api/session", {}, "wrong-pin");
  check("wrong PIN rejected", noPin.status === 401, `status=${noPin.status}`);

  const badId = await api("/api/extract", { sessionId: "../../etc" });
  check("bad sessionId rejected", badId.status === 400, `status=${badId.status}`);

  const s = await api("/api/session");
  // store-images ON → presigned uploadUrl present; OFF → absent (inline transport).
  const keep = s.json.storeImages !== false;
  check(
    "session created",
    s.status === 200 && (keep ? !!s.json.uploadUrl : !s.json.uploadUrl),
    `id=${s.json.sessionId} storeImages=${keep}`,
  );
  if (s.status !== 200) return;

  // Submission endpoints: validation only — no live aadl.org traffic here
  // (that's infra/aadltest.ts, run manually).
  const noCreds = await api("/api/aadl/connect", { username: "x" });
  check("connect without password rejected", noCreds.status === 400, `status=${noCreds.status}`);
  const noAccts = await api("/api/submit", { sessionId: s.json.sessionId, code: "ABC123", accounts: [] });
  check("submit without accounts rejected", noAccts.status === 400, `status=${noAccts.status}`);
  const badCode = await api("/api/submit", { sessionId: s.json.sessionId, code: "", accounts: [{ cookies: "{}" }] });
  check("submit with empty code rejected", badCode.status === 400, `status=${badCode.status}`);

  if (!process.argv.includes("--full")) {
    console.log("(pass --full to run the paid upload/extract/escalate path)");
    return;
  }

  const dir = process.env.IMAGES_DIR ?? "data/images";
  const img = fs.readdirSync(dir).find((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (!img) throw new Error(`no test image in ${dir}`);
  console.log(`  using ${img}`);

  const imgBytes = fs.readFileSync(path.join(dir, img));

  // Transport mirrors the client: ON → presigned PUT then {sessionId}; OFF →
  // the photo (and later the crop) ride inline, nothing is stored in S3.
  let extractBody: Record<string, unknown>;
  if (keep) {
    const up = await fetch(s.json.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: imgBytes,
    });
    check("photo uploaded via presigned URL", up.ok, `status=${up.status}`);
    extractBody = { sessionId: s.json.sessionId };
  } else {
    check("no presigned URL when store-images OFF", !s.json.uploadUrl);
    // Mirror the client: downscale to the GCV input size so the inline base64
    // payload stays under the ~6MB Function URL request cap (raw phone JPEGs
    // exceed it). The real client does this in a Web Worker before posting.
    const jpeg = await downscaleToLongestEdge(imgBytes, 2400);
    extractBody = { sessionId: s.json.sessionId, photo: jpeg.toString("base64") };
  }

  const t0 = Date.now();
  const ex = await api("/api/extract", extractBody);
  check(
    "extract ran",
    ex.status === 200 && typeof ex.json.tier1?.code === "string" && !!ex.json.cropDataUrl,
    `in ${Date.now() - t0}ms: tier1=${JSON.stringify({ ...ex.json.tier1, raw: undefined })} tier2=${JSON.stringify(ex.json.tier2)}`,
  );

  const t1 = Date.now();
  const esc = await api(
    "/api/escalate",
    keep ? { sessionId: s.json.sessionId } : { sessionId: s.json.sessionId, crop: ex.json.cropDataUrl },
  );
  check(
    "escalate ran (Claude on crop)",
    esc.status === 200 && typeof esc.json.tier2?.code === "string",
    `in ${Date.now() - t1}ms: ${JSON.stringify(esc.json.tier2)}`,
  );

  const v = await api("/api/verdict", {
    sessionId: s.json.sessionId,
    record: { verdicts: [{ tier: 2, code: esc.json.tier2?.code, action: "approved" }], finalCode: esc.json.tier2?.code, source: "tier2" },
  });
  check("verdict stored", v.status === 200 && v.json.ok === true);
  console.log(`session: ${s.json.sessionId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
