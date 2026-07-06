import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { dims } from "../image";
import { AuthExpiredError, connect, loadJar, submitCode } from "./aadl";
import { extractMode, storeImages } from "./flags";
import { runTier1, runTier2 } from "./pipeline";

/**
 * Field-test app server. Plain node:http (pattern: label.ts); runs unchanged
 * locally (`npm run app`) and on Lambda behind the Web Adapter.
 *
 * Session flow (client drives it, S3 is the only state):
 *   POST /api/session   → { sessionId, storeImages, uploadUrl? }
 *   POST /api/extract   → tier 1; auto-runs tier 2 when the gate fails
 *   POST /api/escalate  → tier 2 on the crop (user rejected tier 1)
 *   POST /api/verdict   → writes the user's approve/reject trail + final code
 *
 * The `store-images` AppConfig flag (see ./flags) gates image *retention*, not
 * telemetry, and picks the transport at session start:
 *   ON  → client PUTs photo.jpg via a presigned URL (dodges the 6MB Function
 *         URL cap); server reads photo + crop back from S3 (the crop bridges
 *         extract→escalate). Every session leaves photo/crop/extract/verdict
 *         JSON under sessions/<id>/ — raw material for future labels.csv entries.
 *   OFF → client posts the photo (and, on escalate, the crop) inline; the
 *         server processes them in memory and writes *only* the telemetry JSON.
 *         No image bytes ever land in S3.
 */

const s3 = new S3Client({ region: config.awsRegion });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// CI stamps package.json at image build (test) or ships it as tagged (prod);
// the version tags the page (so a stale cached client is visible at a
// glance), the S3 prefix, and extract.json.
const APP_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

// First extract/escalate served by this process = a Lambda cold start (locally:
// first request since launch). Attributes the p99 tail before tuning for it.
let coldProcess = true;
function takeColdStart(): boolean {
  const was = coldProcess;
  coldProcess = false;
  return was;
}

const SESSION_ID_RE = /^\d{10,16}-[a-f0-9]{8}$/;
const sessionKey = (id: string, name: string): string =>
  `sessions/v${APP_VERSION}/${id}/${name}`;

function pinOk(req: http.IncomingMessage): boolean {
  if (!config.appPin) return true; // no PIN configured (local dev)
  const pin = req.headers["x-app-pin"];
  if (typeof pin !== "string") return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(config.appPin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

// Default 1MB cap; the inline-image routes (extract/escalate when store-images
// is OFF) carry a base64 JPEG, so they raise it (see MAX_BODY_BYTES).
async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

// Inline base64 JPEGs ride in these bodies when store-images is OFF. A ≤2400px
// photo is ~1–3MB (~1.3–4MB base64); 9MB leaves margin under the client's
// re-encode-to-fit guard while still rejecting absurd payloads.
const MAX_BODY_BYTES: Record<string, number> = {
  "/api/extract": 9_000_000,
  "/api/escalate": 9_000_000,
};

/** Decode a raw-base64 or `data:...;base64,` string into a JPEG buffer. */
function decodeImage(v: unknown, what: string): Buffer {
  if (typeof v !== "string" || !v) throw new Error(`bad ${what}`);
  const b64 = v.startsWith("data:") ? v.slice(v.indexOf(",") + 1) : v;
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error(`bad ${what}`);
  return buf;
}

async function s3GetBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.sessionsBucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

async function s3Put(key: string, body: Buffer | string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: config.sessionsBucket, Key: key, Body: body, ContentType: contentType }),
  );
}

const s3PutJson = (key: string, obj: unknown): Promise<void> =>
  s3Put(key, JSON.stringify(obj, null, 2), "application/json");

function requireSessionId(body: Record<string, unknown>): string {
  const id = body.sessionId;
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) throw new Error("bad sessionId");
  return id;
}

// ---------- handlers ----------

async function handleSession(): Promise<unknown> {
  const sessionId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const [keep, mode] = await Promise.all([storeImages(), extractMode()]);
  // The presigned PUT (S3 transport) is issued only when we intend to keep the
  // photo. When OFF the client posts it inline instead — nothing hits S3.
  // Still issued when extract-mode is off (presigning is a free local
  // signature, and a stale pre-flag client would break without it).
  const uploadUrl = keep
    ? await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.sessionsBucket,
          Key: sessionKey(sessionId, "photo.jpg"),
          ContentType: "image/jpeg",
        }),
        { expiresIn: 600 },
      )
    : undefined;
  return { sessionId, storeImages: keep, extractMode: mode, uploadUrl };
}

// User-facing "sorry" messages for the extract-mode circuit breaker; the
// request handler maps them to 503 and the client shows them verbatim. The
// client normally never calls a disabled endpoint (it acts on the session's
// extractMode), so these guard stale clients and mid-session flips.
const EXTRACT_OFF_MSG =
  "Sorry — automatic code reading is switched off right now. You can still type the code by hand.";
const ESCALATE_OFF_MSG =
  "Sorry — the closer-look reader is switched off right now. Check the code by hand instead.";

async function handleExtract(body: Record<string, unknown>): Promise<unknown> {
  const t0 = Date.now();
  const coldStart = takeColdStart();
  const sessionId = requireSessionId(body);
  let t = Date.now();
  const mode = await extractMode();
  const flagMs = Date.now() - t;
  if (mode === "off") throw new Error(EXTRACT_OFF_MSG);
  // Transport is derived from the request shape, not a re-read of the flag, so
  // it can't disagree with what the client actually did across a mid-session
  // flip: an inline `photo` ⇒ store-images was OFF at session start; its
  // absence ⇒ ON, and the photo was PUT to S3 (presigned).
  const inline = typeof body.photo === "string" && body.photo.length > 0;
  const keep = !inline;
  t = Date.now();
  const photo = inline
    ? decodeImage(body.photo, "photo")
    : await s3GetBuffer(sessionKey(sessionId, "photo.jpg"));
  const s3GetMs = inline ? 0 : Date.now() - t;

  const { tier1, cropJpeg, normMs, cropMs } = await runTier1(photo);
  // Persist the crop only when keeping images (it bridges extract→escalate);
  // when OFF the client holds the crop (cropDataUrl) and hands it back.
  t = Date.now();
  if (keep) await s3Put(sessionKey(sessionId, "crop.jpg"), cropJpeg, "image/jpeg");
  const s3PutCropMs = keep ? Date.now() - t : 0;

  // Gate failure auto-escalates server-side: the user should never be shown a
  // result the bake-off proved unreliable. Unless Claude is circuit-broken
  // (mode gcv) — then the manual screen is the fallback and tier2 stays null.
  t = Date.now();
  const tier2 = tier1.gatePassed || mode !== "full" ? null : await runTier2(cropJpeg);
  const tier2Ms = tier2 ? Date.now() - t : 0;

  // Per-step wall times for the speed work; gcvMs/tier2 latencyMs are the
  // vendor calls alone, so overhead is attributable line by line. extract.json
  // can't contain its own write time — the response's copy carries it.
  const serverTimings: Record<string, number | boolean> = {
    coldStart,
    flagMs,
    s3GetMs,
    normMs,
    gcvMs: tier1.latencyMs,
    cropMs,
    s3PutCropMs,
    tier2Ms,
  };

  t = Date.now();
  await s3PutJson(sessionKey(sessionId, "extract.json"), {
    at: new Date().toISOString(),
    version: APP_VERSION,
    storeImages: keep,
    extractMode: mode,
    photo: { ...(await dims(photo)), bytes: photo.length },
    serverTimings,
    tier1, // includes raw GCV words/geometry for later analysis
    tier2,
  });
  serverTimings.s3PutJsonMs = Date.now() - t;
  serverTimings.totalMs = Date.now() - t0;

  const { raw: _raw, ...tier1Public } = tier1;
  return {
    tier1: tier1Public,
    tier2,
    extractMode: mode, // fresher than the session's copy if the flag flipped
    serverTimings,
    cropDataUrl: `data:image/jpeg;base64,${cropJpeg.toString("base64")}`,
  };
}

async function handleEscalate(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  if ((await extractMode()) !== "full") throw new Error(ESCALATE_OFF_MSG);
  // Inline `crop` ⇒ OFF (client hands back the crop it holds); its absence ⇒
  // re-read the stored crop from S3. Mirrors the extract transport, race-free.
  const t0 = Date.now();
  const coldStart = takeColdStart();
  let t = Date.now();
  const inline = typeof body.crop === "string" && body.crop;
  const crop = inline
    ? decodeImage(body.crop, "crop")
    : await s3GetBuffer(sessionKey(sessionId, "crop.jpg"));
  const s3GetMs = inline ? 0 : Date.now() - t;
  t = Date.now();
  const tier2 = await runTier2(crop);
  const tier2Ms = Date.now() - t;
  const serverTimings: Record<string, number | boolean> = { coldStart, s3GetMs, claudeMs: tier2.latencyMs, tier2Ms };
  t = Date.now();
  await s3PutJson(sessionKey(sessionId, "tier2.json"), { at: new Date().toISOString(), serverTimings, tier2 });
  serverTimings.s3PutJsonMs = Date.now() - t;
  serverTimings.totalMs = Date.now() - t0;
  return { tier2, serverTimings };
}

async function handleVerdict(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  await s3PutJson(sessionKey(sessionId, "verdict.json"), {
    at: new Date().toISOString(),
    ...(typeof body.record === "object" && body.record !== null ? body.record : {}),
  });
  // No image cleanup needed: a photo only ever reaches S3 when store-images was
  // ON at session start (the client used the presigned PUT), so anything stored
  // was stored intentionally. Flipping OFF is forward-looking — new sessions
  // post inline and never write images.
  return { ok: true };
}

// AADL credentials/cookies pass through these two handlers and are never
// persisted or logged — the client holds the cookie blob (see aadl.ts).

async function handleAadlConnect(body: Record<string, unknown>): Promise<unknown> {
  const { username, password } = body;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) {
    throw new Error("username and password required");
  }
  return connect(username, password);
}

interface SubmitAccount {
  cookies: string;
  pids: number[];
  label: string;
}

function parseAccounts(body: Record<string, unknown>): SubmitAccount[] {
  if (!Array.isArray(body.accounts) || body.accounts.length === 0 || body.accounts.length > 8) {
    throw new Error("accounts must be a list of 1-8 connected accounts");
  }
  return body.accounts.map((a: any, i: number) => {
    if (typeof a?.cookies !== "string") throw new Error("accounts must be a list of 1-8 connected accounts");
    return {
      cookies: a.cookies,
      pids: Array.isArray(a.pids) ? a.pids.map(Number).filter(Number.isFinite) : [],
      label: typeof a.label === "string" && a.label ? a.label.slice(0, 40) : `account ${i + 1}`,
    };
  });
}

async function handleSubmit(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  const code = typeof body.code === "string" ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  // No length cap: signup limits new codes to 12 chars, but grandfathered
  // longer ones exist (HOTLIKEHARISSA); aadl.org is the validity oracle.
  if (!code) throw new Error("bad code");
  const accounts = parseAccounts(body);

  // Sequential on purpose: be gentle with aadl.org.
  const results = [];
  for (const acct of accounts) {
    try {
      const r = await submitCode(loadJar(acct.cookies), code, acct.pids);
      results.push({ label: acct.label, ...r });
    } catch (err: any) {
      results.push({
        label: acct.label,
        outcome: err instanceof AuthExpiredError ? ("auth_expired" as const) : ("error" as const),
        error: String(err?.message ?? err),
      });
    }
  }

  // Cookie-free trail: one submit.json per session, accumulating attempts
  // (approve-submit then escalate-resubmit is the expected two-entry shape).
  const key = sessionKey(sessionId, "submit.json");
  let attempts: unknown[] = [];
  try {
    attempts = JSON.parse((await s3GetBuffer(key)).toString("utf8")).attempts ?? [];
  } catch {
    // first attempt for this session
  }
  attempts.push({ at: new Date().toISOString(), code, results });
  await s3PutJson(key, { attempts });

  return { code, results };
}

// ---------- server ----------

const API: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/api/session": handleSession,
  "/api/extract": handleExtract,
  "/api/escalate": handleEscalate,
  "/api/verdict": handleVerdict,
  "/api/aadl/connect": handleAadlConnect,
  "/api/submit": handleSubmit,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    // no-store: a phone-cached stale client silently dropped a whole field
    // batch's instrumentation once. The page is ~12KB; always fetch fresh.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(
      fs.readFileSync(path.join(publicDir, "index.html"), "utf8").replaceAll("{{VERSION}}", APP_VERSION),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const handler = req.method === "POST" ? API[url.pathname] : undefined;
  if (!handler) {
    send(res, 404, { error: "not found" });
    return;
  }
  if (!pinOk(req)) {
    send(res, 401, { error: "bad PIN" });
    return;
  }
  if (!config.sessionsBucket) {
    send(res, 500, { error: "SESSIONS_BUCKET not configured" });
    return;
  }

  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES[url.pathname]);
    send(res, 200, await handler(body));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (err?.name === "NoSuchKey") {
      send(res, 404, { error: "session object not found (upload the photo first?)" });
    } else if (msg === EXTRACT_OFF_MSG || msg === ESCALATE_OFF_MSG) {
      send(res, 503, { error: msg });
    } else if (
      msg.startsWith("bad ") || msg === "body too large" ||
      msg === "username and password required" || msg.startsWith("accounts must be") ||
      err instanceof SyntaxError
    ) {
      send(res, 400, { error: msg });
    } else {
      console.error(`${req.method} ${url.pathname} failed:`, err);
      send(res, 500, { error: msg });
    }
  }
});

server.listen(config.appPort, () => {
  console.log(`app v${APP_VERSION} listening on http://localhost:${config.appPort}`);
  console.log(`  bucket=${config.sessionsBucket || "(unset!)"} pin=${config.appPin ? "set" : "OFF"}`);
});
