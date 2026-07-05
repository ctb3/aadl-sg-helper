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
import { runTier1, runTier2 } from "./pipeline";

/**
 * Field-test app server. Plain node:http (pattern: label.ts); runs unchanged
 * locally (`npm run app`) and on Lambda behind the Web Adapter.
 *
 * Session flow (client drives it, S3 is the only state):
 *   POST /api/session   → { sessionId, uploadUrl }  presigned PUT for photo.jpg
 *   POST /api/extract   → tier 1; auto-runs tier 2 when the gate fails
 *   POST /api/escalate  → tier 2 on the stored crop (user rejected tier 1)
 *   POST /api/verdict   → writes the user's approve/reject trail + final code
 *
 * Every session leaves photo.jpg / crop.jpg / extract.json / verdict.json
 * under sessions/<id>/ — raw material for future labels.csv entries.
 */

const s3 = new S3Client({ region: config.awsRegion });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// CI stamps package.json at image build (test) or ships it as tagged (prod);
// the version tags the page (so a stale cached client is visible at a
// glance), the S3 prefix, and extract.json.
const APP_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

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

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
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
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.sessionsBucket,
      Key: sessionKey(sessionId, "photo.jpg"),
      ContentType: "image/jpeg",
    }),
    { expiresIn: 600 },
  );
  return { sessionId, uploadUrl };
}

async function handleExtract(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  const photo = await s3GetBuffer(sessionKey(sessionId, "photo.jpg"));

  const { tier1, cropJpeg } = await runTier1(photo);
  await s3Put(sessionKey(sessionId, "crop.jpg"), cropJpeg, "image/jpeg");

  // Gate failure auto-escalates server-side: the user should never be shown a
  // result the bake-off proved unreliable.
  const tier2 = tier1.gatePassed ? null : await runTier2(cropJpeg);

  await s3PutJson(sessionKey(sessionId, "extract.json"), {
    at: new Date().toISOString(),
    version: APP_VERSION,
    photo: { ...(await dims(photo)), bytes: photo.length },
    tier1, // includes raw GCV words/geometry for later analysis
    tier2,
  });

  const { raw: _raw, ...tier1Public } = tier1;
  return {
    tier1: tier1Public,
    tier2,
    cropDataUrl: `data:image/jpeg;base64,${cropJpeg.toString("base64")}`,
  };
}

async function handleEscalate(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  const crop = await s3GetBuffer(sessionKey(sessionId, "crop.jpg"));
  const tier2 = await runTier2(crop);
  await s3PutJson(sessionKey(sessionId, "tier2.json"), { at: new Date().toISOString(), tier2 });
  return { tier2 };
}

async function handleVerdict(body: Record<string, unknown>): Promise<unknown> {
  const sessionId = requireSessionId(body);
  await s3PutJson(sessionKey(sessionId, "verdict.json"), {
    at: new Date().toISOString(),
    ...(typeof body.record === "object" && body.record !== null ? body.record : {}),
  });
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
    const body = await readJsonBody(req);
    send(res, 200, await handler(body));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (err?.name === "NoSuchKey") {
      send(res, 404, { error: "session object not found (upload the photo first?)" });
    } else if (
      msg === "bad sessionId" || msg === "body too large" || msg === "bad code" ||
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
