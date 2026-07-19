// Figma state exporter: drives the real app in headless Chrome (CDP) to every
// UI state, then saves a reference PNG + a frozen self-contained HTML per
// state. The HTMLs are what the designer imports into Figma (html.to.design);
// frame names must match the state ids, so id = filename = frame name.
//
// Run (see out/design/export/for-designer.md it writes for the import side):
//   1. npm run app                      (serves :8080)
//   2. headless Chrome with --remote-debugging-port=9223 (verify skill recipe)
//   3. node.exe src/design/export-states.mjs   [--shots-only] [--only <substr>]
// Must be WINDOWS node — WSL node can't reach Chrome's :9223.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNTS_CONNECTED, ACCOUNTS_EXPIRED, ACCOUNTS_TWO, CODE, CODE_MISREAD,
  SUBMIT_ALLOK_MULTI, SUBMIT_ALLOK_SINGLE, SUBMIT_MIXED, bootstrapScript,
} from "./fixtures.mjs";

const APP = "http://localhost:8080";
const CDP_HTTP = "http://localhost:9223";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "design", "export");
const SHOTS_ONLY = process.argv.includes("--shots-only");
const only = process.argv.indexOf("--only");
const ONLY = only > -1 ? process.argv[only + 1] : "";

// ---- CDP plumbing (same shape as out/uitest.mjs) ----
let ws, msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaljs = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) {
    throw new Error("in-page: " + (r.result.exceptionDetails.exception?.description
      || JSON.stringify(r.result.exceptionDetails)));
  }
  return r.result.result ? r.result.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- state drives ----
// Each entry: { id, page, width, drive } — drive() runs after a fresh navigate
// with the fetch stub + __makeCrop already injected (bootstrapScript).
const seed = (accounts) => `
  localStorage.clear();
  localStorage.setItem("howtoSeen", "1");
  ${accounts ? `localStorage.setItem("aadlAccounts", ${JSON.stringify(JSON.stringify(accounts))});` : ""}
  state = null; home(); ""`;
const freshState = (extra = "") =>
  `state = { t0: Date.now(), verdicts: [], timings: {}, sessionId: "design-fixture",
             storeImages: false, extractMode: "full"${extra} };`;
const withCrop = (extra = "") =>
  freshState(`, cropDataUrl: window.__makeCrop(${JSON.stringify(CODE)})` + extra);

const STATES = [
  { id: "index--v-home--noacct", drive: seed(null) },
  { id: "index--v-home--connected", drive: seed(ACCOUNTS_CONNECTED) },
  { id: "index--v-home--expired", drive: seed(ACCOUNTS_EXPIRED) },
  { id: "index--v-connect--warn", drive: seed(null) + `; openConnect(); ""` },
  { id: "index--v-connect--form", drive: seed(null) + `; openConnect(); $("c-accept").click(); ""` },
  {
    id: "index--v-connect--error",
    drive: seed(null) + `; openConnect(); $("c-accept").click();
      $("c-err").textContent = "AADL login failed. Check your username and password.";
      $("c-err").hidden = false; ""`,
  },
  { id: "index--v-busy--reading", drive: seed(null) + `; busy(MSG.READING); ""` },
  {
    id: "index--v-busy--stall",
    drive: seed(null) + `; busy(MSG.READING);
      $("busy-sub").textContent = MSG.READING_STALL; $("busy-sub").hidden = false; ""`,
  },
  {
    id: "index--v-result",
    drive: seed(null) + `; ${withCrop()} presentResult(${JSON.stringify(CODE)})`,
  },
  { id: "index--v-manual--typed", drive: seed(null) + `; $("btn-manual").click(); ""` },
  {
    id: "index--v-manual--guess-alts",
    drive: seed(ACCOUNTS_CONNECTED) + `; ${withCrop(`,
      tier1: { code: ${JSON.stringify(CODE_MISREAD)} },
      tier2: { code: ${JSON.stringify(CODE)},
               alternatives: ["DAPPERL1AMA", "DAPPERLIANA"] }`)}
      showManual(MSG.NOT_RECOGNIZED(${JSON.stringify(CODE_MISREAD)}))`,
  },
  {
    id: "index--v-submitted--allok-single",
    drive: seed(ACCOUNTS_CONNECTED) + `; ${freshState(`, finalSource: "tier1_auto",
      presented: { tier: 1, code: ${JSON.stringify(CODE)} }`)}
      window.__stubs["/api/submit"] = ${JSON.stringify(SUBMIT_ALLOK_SINGLE)};
      submitToAadl(${JSON.stringify(CODE)})`,
  },
  {
    id: "index--v-submitted--allok-multi",
    drive: seed(ACCOUNTS_TWO) + `; ${freshState(`, finalSource: "tier1_auto",
      presented: { tier: 1, code: ${JSON.stringify(CODE)} }`)}
      window.__stubs["/api/submit"] = ${JSON.stringify(SUBMIT_ALLOK_MULTI)};
      submitToAadl(${JSON.stringify(CODE)})`,
  },
  {
    // presented stays unset so the AADL-rejected oracle branch (which would
    // bounce to escalate/manual) is skipped and the mixed results render.
    id: "index--v-submitted--mixed",
    drive: seed(ACCOUNTS_TWO) + `; ${freshState(`, finalSource: "manual" `)}
      state.verdicts.push({ tier: 3, code: ${JSON.stringify(CODE_MISREAD)}, action: "manual_entry" });
      window.__stubs["/api/submit"] = ${JSON.stringify(SUBMIT_MIXED)};
      submitToAadl(${JSON.stringify(CODE_MISREAD)})`,
  },
  {
    id: "index--v-done--opened",
    drive: seed(null) + `; $("d-code").textContent = ${JSON.stringify(CODE)};
      $("d-link").href = handoffUrl(${JSON.stringify(CODE)});
      $("d-status").textContent = MSG.HANDOFF_OPENED; show("v-done"); ""`,
  },
  {
    id: "index--v-done--blocked",
    drive: seed(null) + `; $("d-code").textContent = ${JSON.stringify(CODE)};
      $("d-link").href = handoffUrl(${JSON.stringify(CODE)});
      $("d-status").textContent = MSG.HANDOFF_BLOCKED; show("v-done"); ""`,
  },
  {
    id: "index--v-error",
    drive: seed(null) + `; fail(new Error("Something went wrong talking to aadl.org. Try again in a minute.")); ""`,
  },
  {
    id: "index--v-howto--android",
    drive: seed(null) + `; show("v-howto");
      $("install-android").hidden = false; $("install-ios").hidden = true; ""`,
  },
  {
    id: "index--v-howto--ios",
    drive: seed(null) + `; show("v-howto");
      $("install-android").hidden = true; $("install-ios").hidden = false; ""`,
  },
  { id: "index--v-about", drive: seed(null) + `; show("v-about"); ""` },
  { id: "dash--full", page: "/dash", width: 760, drive: `""` },
];

// Freeze pass: strip scripts + everything invisible, kill animations, then
// serialize. What's left is exactly what the screenshot shows.
const freeze = (id) => `(() => {
  document.querySelectorAll("script, link").forEach((n) => n.remove());
  document.querySelectorAll(".view:not(.active)").forEach((n) => n.remove());
  document.querySelectorAll("[hidden]").forEach((n) => n.remove());
  const st = document.createElement("style");
  st.textContent = ".view.active{animation:none}.spin{animation:none}";
  document.head.append(st);
  document.title = ${JSON.stringify(id)};
  const m = document.createElement("meta");
  m.name = "figma-state"; m.content = ${JSON.stringify(id)};
  document.head.append(m);
  return "<!doctype html>\\n" + document.documentElement.outerHTML;
})()`;

async function main() {
  let targets;
  try {
    targets = await (await fetch(CDP_HTTP + "/json/list")).json();
  } catch {
    throw new Error("no Chrome on :9223 — launch headless Chrome per the verify skill first");
  }
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP ws failed")); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapScript() });

  mkdirSync(join(OUT, "shots"), { recursive: true });
  mkdirSync(join(OUT, "states"), { recursive: true });

  const done = [];
  for (const s of STATES) {
    if (ONLY && !s.id.includes(ONLY)) continue;
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: s.width || 420, height: 900, deviceScaleFactor: 1, mobile: !s.width,
    });
    await cdp("Page.navigate", { url: APP + (s.page || "/") });
    await sleep(s.page ? 1200 : 800); // page script boot (+ dash fetch/render)
    await evaljs(s.drive);
    await sleep(600); // .view fade + async renders settle
    const active = s.page ? "(dash)" : await evaljs(`document.querySelector(".view.active").id`);
    const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(OUT, "shots", s.id + ".png"), Buffer.from(shot.result.data, "base64"));
    if (!SHOTS_ONLY) {
      writeFileSync(join(OUT, "states", s.id + ".html"), await evaljs(freeze(s.id)));
    }
    done.push(s.id);
    console.log(`${s.id}  [active: ${active}]`);
  }

  if (!SHOTS_ONLY) {
    writeFileSync(join(OUT, "for-designer.md"), forDesigner(done));
    console.log("wrote for-designer.md");
  }
  ws.close();
  console.log(`DONE — ${done.length} states → ${OUT}`);
}

function forDesigner(ids) {
  return `# AADL Code Helper — Figma import kit

This folder is every screen (and important variant) of the app, frozen:

- \`states/<id>.html\` — the screen itself, one self-contained file each
  (no scripts, no network). **These are what you import into Figma.**
- \`shots/<id>.png\` — a reference screenshot of the exact same screen.
  Where the Figma import looks slightly off (fonts, emoji, shadows), the
  PNG is the ground truth for how the app really renders it.

## Importing

1. In Figma, run the **html.to.design** plugin (by ‹div›RIOTS).
2. Import each \`states/*.html\` file (upload-file mode; on the free plan
   they go one at a time). Viewport: **mobile, 420px wide** —
   \`dash--full\` is the one exception: desktop, **760px**.
3. Put every imported frame on one page named **States**, and rename each
   frame to exactly its filename without \`.html\` (e.g.
   \`index--v-submitted--mixed\`). The name is how changes find their way
   back into the code, so this step matters.

## While designing

Please **restyle in place**: change colors, type, spacing, radii, shadows,
imagery freely — but don't rename, detach, regroup, or reorder layers, and
keep each screen inside its original frame. Renamed/moved layers can't be
matched back to the code automatically and end up in a manual-review pile.

Adding new elements is fine — they'll be reviewed by hand. If you use a
custom font, note its name somewhere visible (a comment on the frame works).

## The screens

${ids.map((i) => `- \`${i}\``).join("\n")}
`;
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
