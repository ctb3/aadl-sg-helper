import { config } from "../core/config";

/**
 * AADL (aadl.org, Drupal 10) site client for Summer Game code submission.
 * Contract derived from the open-source module (github.com/aadl/summergame,
 * SummerGamePlayerRedeemForm + summergame_redeem_code()):
 *
 *   login:  POST /user/login  {name, pass, form_build_id, form_id, op,
 *           persistent_login} → session cookies (SSESS… + persistent-login)
 *   redeem: GET /summergame/player/0/gamecode → 302 to /player/{pid}/gamecode;
 *           parse form_build_id/form_token (per-render) + pids[] checkboxes
 *           (present only when the account has >1 player), then POST code_text.
 *           Outcome arrives as Drupal messenger text on the post-redirect GET.
 *
 * Credentials pass through connect() once and are never stored server-side;
 * the caller (the phone) holds the serialized cookie jar.
 */

const BASE = config.aadlBaseUrl;
const UA = "aadl-sg-helper (personal Summer Game assistant)";
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export class AuthExpiredError extends Error {
  constructor() {
    super("AADL session expired — reconnect the account");
  }
}

// ---------- cookie jar ----------

export type CookieJar = Map<string, string>;

export const serializeJar = (jar: CookieJar): string =>
  JSON.stringify(Object.fromEntries(jar));

export function loadJar(cookies: string): CookieJar {
  const obj: unknown = JSON.parse(cookies);
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("bad cookie blob");
  const jar: CookieJar = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") jar.set(k, v);
  }
  return jar;
}

function absorbSetCookies(jar: CookieJar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An expired/emptied cookie is a deletion (Drupal clears the anon session
    // cookie this way on login).
    if (value === "" || /expires=Thu, 01[- ]Jan[- ]1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

// ---------- fetch with manual redirects ----------

interface Page {
  url: string;
  status: number;
  html: string;
}

async function request(jar: CookieJar, method: "GET" | "POST", url: string, form?: URLSearchParams): Promise<Page> {
  let currentUrl = url;
  let currentMethod = method;
  let body = form;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { "user-agent": UA };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(currentUrl, {
      method: currentMethod,
      headers,
      body: body?.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    absorbSetCookies(jar, res);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      currentMethod = "GET"; // Drupal form POSTs 303 to the message-bearing page
      body = undefined;
      continue;
    }
    return { url: currentUrl, status: res.status, html: await res.text() };
  }
  throw new Error(`too many redirects fetching ${url}`);
}

// ---------- HTML scraping ----------

const attr = (html: string, re: RegExp): string | null => re.exec(html)?.[1] ?? null;

const formBuildId = (html: string): string | null =>
  attr(html, /name="form_build_id"\s+value="([^"]+)"/);

/** Strip tags/entities and collapse whitespace — message matching runs on text. */
function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const isLoginPage = (page: Page): boolean =>
  page.url.includes("/user/login") || /name="form_id"\s+value="user_login_form"/.test(page.html);

// ---------- login / connect ----------

export async function aadlLogin(username: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  const loginPage = await request(jar, "GET", `${BASE}/user/login`);
  const buildId = formBuildId(loginPage.html);
  if (!buildId) throw new Error("could not parse the AADL login form");

  const res = await request(
    jar,
    "POST",
    `${BASE}/user/login`,
    new URLSearchParams({
      name: username,
      pass: password,
      form_build_id: buildId,
      form_id: "user_login_form",
      persistent_login: "1",
      op: "Log in",
    }),
  );
  if (isLoginPage(res)) {
    const text = pageText(res.html);
    if (/Unrecognized username or password/i.test(text)) throw new Error("AADL rejected the username or password");
    if (/too many failed login attempts/i.test(text)) throw new Error("AADL login temporarily blocked (too many attempts) — try later");
    if (/antibot/i.test(res.html)) throw new Error("AADL login blocked by an anti-bot check");
    throw new Error("AADL login failed (unexpected response)");
  }
  return jar;
}

export interface AadlPlayer {
  pid: number;
  name: string;
}

export interface RedeemForm {
  pid: number;
  actionUrl: string;
  formBuildId: string;
  formToken: string | null;
  players: AadlPlayer[];
}

export async function fetchRedeemForm(jar: CookieJar): Promise<RedeemForm> {
  const page = await request(jar, "GET", `${BASE}/summergame/player/0/gamecode`);
  if (isLoginPage(page)) throw new AuthExpiredError();

  const pid = Number(attr(page.url, /\/summergame\/player\/(\d+)\/gamecode/));
  if (!pid) throw new Error(`unexpected redeem page: ${page.url} (add a player to the account at aadl.org first?)`);
  const buildId = formBuildId(page.html);
  if (!buildId) throw new Error("could not parse the redeem form");

  // pids[] checkboxes exist only when the account has >1 player; each input's
  // <label for=…> carries the player name.
  const players: AadlPlayer[] = [];
  for (const m of page.html.matchAll(/<input[^>]*name="pids\[(\d+)\]"[^>]*id="([^"]+)"[^>]*>|<input[^>]*id="([^"]+)"[^>]*name="pids\[(\d+)\]"[^>]*>/g)) {
    const cbPid = Number(m[1] ?? m[4]);
    const id = m[2] ?? m[3];
    const label = attr(page.html, new RegExp(`<label[^>]*for="${id}"[^>]*>([^<]*)</label>`));
    players.push({ pid: cbPid, name: (label ?? "").trim() || `Player ${cbPid}` });
  }
  if (!players.length) {
    const name = attr(page.html, /<h3>Enter a code for ([^<]*)<\/h3>/);
    players.push({ pid, name: (name ?? "").trim() || `Player ${pid}` });
  }

  return {
    pid,
    actionUrl: page.url,
    formBuildId: buildId,
    formToken: attr(page.html, /name="form_token"\s+value="([^"]+)"/),
    players,
  };
}

export interface ConnectResult {
  cookies: string;
  players: AadlPlayer[];
}

export async function connect(username: string, password: string): Promise<ConnectResult> {
  const jar = await aadlLogin(username, password);
  const form = await fetchRedeemForm(jar);
  return { cookies: serializeJar(jar), players: form.players };
}

// ---------- code submission ----------

export type SubmitOutcome =
  | "success"
  | "already_redeemed"
  | "not_recognized"
  | "close_match"
  | "expired"
  | "not_yet_valid"
  | "max_redemptions"
  | "rate_limited"
  | "unknown";

/** Message strings from summergame_redeem_code() / SummerGamePlayerRedeemForm. */
const OUTCOME_PATTERNS: [SubmitOutcome, RegExp][] = [
  ["success", /redeemed code "[A-Z0-9]+" for -?\d+/],
  ["already_redeemed", /Code "[A-Z0-9]+" already redeemed on/],
  ["not_recognized", /Code is not recognized/],
  ["close_match", /close to an Explorer code/],
  ["expired", /Code "[A-Z0-9]+" is no longer valid/],
  ["not_yet_valid", /Code "[A-Z0-9]+" is not yet valid/],
  ["max_redemptions", /Code "[A-Z0-9]+" has reached maximum number of redemptions/],
  ["rate_limited", /Too many codes redeemed recently/],
];

const classify = (text: string): SubmitOutcome =>
  OUTCOME_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? "unknown";

/**
 * aadl.org serves messenger output through BigPipe: each message is a JSON
 * command `{"command":"message","message":"…"}` inside a placeholder <script>
 * block, so it never appears as rendered markup in the initial HTML.
 */
function extractMessages(html: string): SubmitMessage[] {
  const out: SubmitMessage[] = [];
  for (const m of html.matchAll(/"command":"message","message":"((?:[^"\\]|\\.)*)"/g)) {
    const text = pageText(JSON.parse(`"${m[1]}"`)).trim();
    if (text) out.push({ outcome: classify(text), text });
  }
  if (out.length) return out;
  // Non-BigPipe fallback (e.g. markup changes or server-rendered messages):
  // scan the visible page text for the known strings.
  const text = pageText(html);
  for (const [outcome, re] of OUTCOME_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push({ outcome, text: text.slice(m.index, m.index + 160).trim() });
  }
  return out;
}

/** Ranked so the aggregate outcome of a multi-player submit is the most informative one. */
const OUTCOME_RANK: SubmitOutcome[] = [
  "success", "already_redeemed", "close_match", "not_recognized",
  "expired", "not_yet_valid", "max_redemptions", "rate_limited", "unknown",
];

export interface SubmitMessage {
  outcome: SubmitOutcome;
  text: string;
}

export interface SubmitResult {
  outcome: SubmitOutcome;
  /** Points from the first success message, when present. */
  points: number | null;
  messages: SubmitMessage[];
  pid: number;
  players: AadlPlayer[];
  latencyMs: number;
}

export async function submitCode(jar: CookieJar, code: string, pids: number[]): Promise<SubmitResult> {
  const t0 = Date.now();
  const form = await fetchRedeemForm(jar); // tokens are per-render
  const fields = new URLSearchParams({
    code_text: code,
    form_build_id: form.formBuildId,
    form_id: "summergame_player_redeem_form",
    op: "Submit",
  });
  if (form.formToken) fields.set("form_token", form.formToken);
  if (form.players.length > 1) {
    const known = new Set(form.players.map((p) => p.pid));
    const selected = pids.filter((p) => known.has(p));
    for (const pid of selected.length ? selected : [...known]) fields.append(`pids[${pid}]`, String(pid));
  }

  const res = await request(jar, "POST", form.actionUrl, fields);
  if (isLoginPage(res)) throw new AuthExpiredError();

  const messages = extractMessages(res.html);
  const outcome =
    messages.length === 0
      ? "unknown"
      : OUTCOME_RANK[Math.min(...messages.map((m) => OUTCOME_RANK.indexOf(m.outcome)))];
  const points =
    messages.map((m) => /redeemed code "[A-Z0-9]+" for (-?\d+)/.exec(m.text)?.[1]).find(Boolean) ?? null;

  return {
    outcome,
    points: points === null ? null : Number(points),
    messages,
    pid: form.pid,
    players: form.players,
    latencyMs: Date.now() - t0,
  };
}
