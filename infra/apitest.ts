import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { cropAndDownscale, downscaleToLongestEdge } from "../src/core/image";

/**
 * Local smoke client for src/app/server.ts (run with `npx tsx infra/apitest.ts`
 * so it executes on Windows node — WSL curl cannot reach Windows localhost).
 * With --full, walks the real paid API the way the current client does:
 * session -> extract (photo inline, keep echo, clientCrop) -> escalate with a
 * locally-cut crop -> verdict, using the first photo in IMAGES_DIR; when
 * store-images is ON it also smoke-tests the legacy presigned-PUT transport.
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
  check("GET / serves page", page.status === 200 && (await page.text()).includes("AADL Summer Game Code Helper"));

  const noPin = await api("/api/session", {}, "wrong-pin");
  check("wrong PIN rejected", noPin.status === 401, `status=${noPin.status}`);

  const badId = await api("/api/extract", { sessionId: "../../etc" });
  check("bad sessionId rejected", badId.status === 400, `status=${badId.status}`);

  const s = await api("/api/session");
  // store-images ON → presigned uploadUrl present; OFF → absent (inline transport).
  const keep = s.json.storeImages !== false;
  // Reader circuit breaker: full | gcv | off (drives the --full assertions).
  const mode = s.json.extractMode ?? "full";
  check(
    "session created",
    s.status === 200 && (keep ? !!s.json.uploadUrl : !s.json.uploadUrl),
    `id=${s.json.sessionId} storeImages=${keep} extractMode=${mode}`,
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

  // Reading fully off: extract must refuse with the user-facing 503; the
  // verdict endpoint (telemetry) keeps working. No photo needed.
  if (mode === "off") {
    const ex = await api("/api/extract", { sessionId: s.json.sessionId });
    check("extract refused while off", ex.status === 503 && !!ex.json.error, `status=${ex.status}: ${ex.json.error}`);
    const esc = await api("/api/escalate", { sessionId: s.json.sessionId });
    check("escalate refused while off", esc.status === 503, `status=${esc.status}`);
    const v = await api("/api/verdict", {
      sessionId: s.json.sessionId,
      record: { verdicts: [{ tier: 0, code: "", action: "extract_off" }], finalCode: "APITEST", source: "manual" },
    });
    check("verdict stored", v.status === 200 && v.json.ok === true);
    console.log(`session: ${s.json.sessionId}`);
    return;
  }

  const dir = process.env.IMAGES_DIR ?? "data/images";
  const img = fs.readdirSync(dir).find((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (!img) throw new Error(`no test image in ${dir}`);
  console.log(`  using ${img}`);

  const imgBytes = fs.readFileSync(path.join(dir, img));

  // Transport mirrors the current client: the photo rides inline (downscaled
  // to the GCV input size — raw phone JPEGs exceed the ~6MB Function URL
  // request cap), with the session's store-images verdict echoed as `keep`
  // and clientCrop announcing that we cut our own tier-2 crop.
  const jpeg = await downscaleToLongestEdge(imgBytes, 2400, 70);
  const extractBody = {
    sessionId: s.json.sessionId,
    photo: jpeg.toString("base64"),
    keep,
    clientCrop: true,
  };

  const t0 = Date.now();
  const ex = await api("/api/extract", extractBody);
  check(
    "extract ran",
    ex.status === 200 && typeof ex.json.tier1?.code === "string",
    `in ${Date.now() - t0}ms: tier1=${JSON.stringify({ ...ex.json.tier1, raw: undefined })} tier2=${JSON.stringify(ex.json.tier2)}`,
  );
  check("no crop payload for clientCrop", ex.json.cropDataUrl === undefined);
  check("no server auto-tier2 for clientCrop", ex.json.tier2 === null);
  check("bbox present", "bbox" in (ex.json.tier1 ?? {}), `bbox=${JSON.stringify(ex.json.tier1?.bbox)}`);

  if (keep) {
    // Legacy transport (stale clients, one release): presigned PUT + bare
    // sessionId ⇒ the server reads photo.jpg back from S3 and auto-runs what
    // it needs. Reuses the session; extract.json is overwritten — smoke only.
    const up = await fetch(s.json.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: imgBytes,
    });
    check("legacy presigned PUT works", up.ok, `status=${up.status}`);
    const exL = await api("/api/extract", { sessionId: s.json.sessionId });
    check(
      "legacy S3 transport extract works",
      exL.status === 200 && typeof exL.json.tier1?.code === "string" && !!exL.json.cropDataUrl,
      `tier1.code=${exL.json.tier1?.code}`,
    );
  }

  // Escalate with a locally-cut crop from the original, like the client.
  const bbox = ex.json.tier1?.bbox ?? null;
  const cropJpeg = bbox
    ? await cropAndDownscale(imgBytes, bbox, 0.6, 1500)
    : await downscaleToLongestEdge(imgBytes, 1500);
  const t1 = Date.now();
  const esc = await api("/api/escalate", {
    sessionId: s.json.sessionId,
    crop: cropJpeg.toString("base64"),
    keep,
  });
  if (mode === "gcv") {
    // Claude circuit-broken: extract never auto-escalates, escalate refuses.
    check("no tier 2 while gcv-only", ex.json.tier2 === null);
    check("escalate refused while gcv-only", esc.status === 503, `status=${esc.status}`);
  } else {
    check(
      "escalate ran (Claude on crop)",
      esc.status === 200 && typeof esc.json.tier2?.code === "string",
      `in ${Date.now() - t1}ms: ${JSON.stringify(esc.json.tier2)}`,
    );
  }

  const finalCode = esc.json.tier2?.code ?? ex.json.tier1?.code;
  const v = await api("/api/verdict", {
    sessionId: s.json.sessionId,
    record: { verdicts: [{ tier: 2, code: finalCode, action: "approved" }], finalCode, source: "tier2" },
  });
  check("verdict stored", v.status === 200 && v.json.ok === true);
  console.log(`session: ${s.json.sessionId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
