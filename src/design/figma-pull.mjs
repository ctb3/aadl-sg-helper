// Figma read-back: pulls the designer's file, normalizes every state frame
// into a style spec, and diffs against the committed baseline so only the
// designer's actual changes surface (both sides went through the same lossy
// HTML→Figma import, so the lossiness cancels in the diff).
//
//   node src/design/figma-pull.mjs --baseline   # right AFTER import, before
//                                               # any edits; commit the result
//   node src/design/figma-pull.mjs              # later: spec + renders + diff.md
//
// Env (or .env): FIGMA_TOKEN (personal access token), FIGMA_FILE_KEY (the id
// in figma.com/design/<key>/...). Flags: --no-renders skips PNG downloads.
// Works under either WSL or Windows node (plain fetch, no CDP).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BASELINE_DIR = join(HERE, "baseline");
const IS_BASELINE = process.argv.includes("--baseline");
const NO_RENDERS = process.argv.includes("--no-renders");

// .env fallback for the two settings (same parse as out/uitest.mjs)
const env = { ...process.env };
try {
  for (const l of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && !l.startsWith("#") && !(l.slice(0, i).trim() in env)) {
      env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }
} catch { /* no .env is fine when the vars are exported */ }
const TOKEN = env.FIGMA_TOKEN;
const KEY = env.FIGMA_FILE_KEY;
if (!TOKEN || !KEY) {
  console.error("Set FIGMA_TOKEN and FIGMA_FILE_KEY (env or .env).");
  process.exit(1);
}

async function figma(path) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://api.figma.com" + path, { headers: { "X-Figma-Token": TOKEN } });
    if (r.status === 429 && attempt < 4) {
      const wait = Number(r.headers.get("retry-after") || 10) * 1000;
      console.log(`rate limited, waiting ${wait / 1000}s…`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw new Error(`figma ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
}

// ---- normalizer ----
const round = (n) => Math.round(n * 2) / 2;
const hex = (c, opacity) => {
  const b = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const a = opacity === undefined || opacity >= 1 ? "" : b(opacity);
  return "#" + b(c.r) + b(c.g) + b(c.b) + a;
};
const paints = (list) => (list || [])
  .filter((p) => p.visible !== false)
  .map((p) => p.type === "SOLID" ? hex(p.color, p.opacity) : p.type);

function normalize(node, origin, path, out) {
  const box = node.absoluteBoundingBox;
  const spec = { path, type: node.type };
  if (box && origin) {
    spec.box = [round(box.x - origin.x), round(box.y - origin.y), round(box.width), round(box.height)];
  }
  const fills = paints(node.fills);
  const strokes = paints(node.strokes);
  if (fills.length) spec.fills = fills;
  if (strokes.length) { spec.strokes = strokes; spec.strokeWeight = node.strokeWeight; }
  if (node.cornerRadius) spec.cornerRadius = node.cornerRadius;
  if (node.rectangleCornerRadii) spec.cornerRadius = node.rectangleCornerRadii;
  if (node.opacity !== undefined && node.opacity < 1) spec.opacity = round(node.opacity * 100) / 100;
  const effects = (node.effects || []).filter((e) => e.visible !== false)
    .map((e) => ({ type: e.type, color: e.color && hex(e.color, e.color.a), offset: e.offset, radius: e.radius }));
  if (effects.length) spec.effects = effects;
  if (node.layoutMode && node.layoutMode !== "NONE") {
    spec.layout = {
      mode: node.layoutMode,
      padding: [node.paddingTop || 0, node.paddingRight || 0, node.paddingBottom || 0, node.paddingLeft || 0],
      gap: node.itemSpacing || 0,
      align: [node.primaryAxisAlignItems || "MIN", node.counterAxisAlignItems || "MIN"],
    };
  }
  if (node.type === "TEXT") {
    const s = node.style || {};
    spec.text = {
      characters: node.characters,
      fontFamily: s.fontFamily,
      fontWeight: s.fontWeight,
      fontSize: s.fontSize,
      lineHeight: s.lineHeightPx && round(s.lineHeightPx),
      letterSpacing: s.letterSpacing && round(s.letterSpacing * 100) / 100,
      align: s.textAlignHorizontal,
    };
  }
  out.push(spec);
  const seen = new Map(); // dedup sibling names so paths stay unique
  for (const child of node.children || []) {
    if (child.visible === false) continue;
    const n = seen.get(child.name) || 0;
    seen.set(child.name, n + 1);
    normalize(child, origin, path + "/" + child.name + (n ? `#${n}` : ""), out);
  }
}

const specFrame = (frame) => {
  const out = [];
  normalize(frame, frame.absoluteBoundingBox, frame.name, out);
  return out;
};

// ---- diff ----
const flat = (spec) => new Map(spec.map((s) => [s.path, s]));
const fmt = (v) => JSON.stringify(v);

function diffFrame(name, base, cur, globals) {
  const b = flat(base), c = flat(cur);
  const lines = [];
  // Fallback for renamed TEXT nodes: match leftover paths by identical characters.
  const bLeft = [...b.keys()].filter((p) => !c.has(p));
  const cLeft = [...c.keys()].filter((p) => !b.has(p));
  const renames = new Map();
  for (const bp of bLeft) {
    const bs = b.get(bp);
    if (bs.type !== "TEXT") continue;
    const hit = cLeft.filter((cp) => c.get(cp).type === "TEXT" && c.get(cp).text?.characters === bs.text?.characters);
    if (hit.length === 1) renames.set(bp, hit[0]);
  }
  for (const [path, bs] of b) {
    const cPath = c.has(path) ? path : renames.get(path);
    if (!cPath) { lines.push(`- removed \`${path}\` (${bs.type})`); continue; }
    const cs = c.get(cPath);
    if (cPath !== path) lines.push(`- renamed \`${path}\` → \`${cPath}\` (matched by text)`);
    for (const k of new Set([...Object.keys(bs), ...Object.keys(cs)])) {
      if (k === "path" || k === "box") continue; // box deltas are usually layout fallout — reported via layout/text/fills
      const bv = fmt(bs[k]), cv = fmt(cs[k]);
      if (bv === cv) continue;
      lines.push(`- \`${cPath}\` ${k}: ${bv ?? "∅"} → ${cv ?? "∅"}`);
      globals.push({ key: `${k}: ${bv} → ${cv}`, frame: name });
    }
    // geometry as a soft signal: only sizeable moves/resizes
    if (bs.box && cs.box && bs.box.some((v, i) => Math.abs(v - cs.box[i]) >= 4)) {
      lines.push(`- \`${cPath}\` box: [${bs.box}] → [${cs.box}]`);
    }
  }
  for (const path of cLeft.filter((p) => ![...renames.values()].includes(p))) {
    const cs = c.get(path);
    lines.push(`+ added \`${path}\` (${cs.type}${cs.text ? ` "${cs.text.characters?.slice(0, 40)}"` : ""})`);
  }
  return lines;
}

// ---- main ----
async function main() {
  console.log("enumerating frames…");
  const doc = await figma(`/v1/files/${KEY}?depth=2`);
  const frames = [];
  for (const pg of doc.document.children || []) {
    for (const child of pg.children || []) {
      if (child.type === "FRAME" || child.type === "SECTION" || child.type === "COMPONENT") {
        frames.push({ id: child.id, name: child.name, page: pg.name });
      }
    }
  }
  if (!frames.length) throw new Error("no top-level frames found in the file");
  console.log(`${frames.length} frames: ${frames.map((f) => f.name).join(", ")}`);

  const specs = new Map();
  const raw = new Map();
  for (let i = 0; i < frames.length; i += 5) {
    const batch = frames.slice(i, i + 5);
    const res = await figma(`/v1/files/${KEY}/nodes?ids=${batch.map((f) => encodeURIComponent(f.id)).join(",")}`);
    for (const f of batch) {
      const node = res.nodes[f.id]?.document;
      if (!node) { console.warn(`missing node for ${f.name}`); continue; }
      specs.set(f.name, specFrame(node));
      raw.set(f.name, node);
    }
    console.log(`nodes ${Math.min(i + 5, frames.length)}/${frames.length}`);
  }

  if (IS_BASELINE) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    for (const [name, spec] of specs) {
      writeFileSync(join(BASELINE_DIR, name + ".json"), JSON.stringify(spec, null, 1));
    }
    console.log(`baseline: ${specs.size} frames → ${BASELINE_DIR} — commit this directory.`);
    return;
  }

  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "").replace(/(\d{8})/, "$1-");
  const outDir = join(ROOT, "out", "design", `pull-${ts}`);
  mkdirSync(join(outDir, "spec"), { recursive: true });
  mkdirSync(join(outDir, "raw"), { recursive: true });
  for (const [name, spec] of specs) {
    writeFileSync(join(outDir, "spec", name + ".json"), JSON.stringify(spec, null, 1));
    writeFileSync(join(outDir, "raw", name + ".json"), JSON.stringify(raw.get(name)));
  }

  // diff vs baseline
  const md = [`# Figma pull ${ts}`, ""];
  const globals = [];
  if (!existsSync(BASELINE_DIR)) {
    md.push("**No baseline found** (src/design/baseline/) — run with --baseline first; spec only, no diff.");
  } else {
    const baseNames = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    for (const name of baseNames) {
      if (!specs.has(name)) { md.push(`## ${name}`, "", "- **frame missing from the file** (renamed or deleted?)", ""); continue; }
      const base = JSON.parse(readFileSync(join(BASELINE_DIR, name + ".json"), "utf8"));
      const lines = diffFrame(name, base, specs.get(name), globals);
      if (lines.length) md.push(`## ${name}`, "", ...lines, "");
    }
    for (const name of specs.keys()) {
      if (!baseNames.includes(name)) md.push(`## ${name}`, "", "+ **new frame** (not in baseline)", "");
    }
    // same property delta across many nodes ⇒ probably a :root token change
    const counts = new Map();
    for (const g of globals) {
      const e = counts.get(g.key) || { n: 0, frames: new Set() };
      e.n++; e.frames.add(g.frame);
      counts.set(g.key, e);
    }
    const cand = [...counts].filter(([, e]) => e.n >= 5).sort((a, b) => b[1].n - a[1].n);
    if (cand.length) {
      md.push("## Global candidates (likely token changes)", "");
      for (const [key, e] of cand) md.push(`- ${key} — ${e.n} nodes across ${e.frames.size} frames`);
      md.push("");
    }
    if (md.length === 2) md.push("No changes vs baseline.");
  }
  writeFileSync(join(outDir, "diff.md"), md.join("\n"));
  console.log(`spec + diff → ${outDir}`);

  if (!NO_RENDERS) {
    mkdirSync(join(outDir, "renders"), { recursive: true });
    const ids = frames.map((f) => f.id).join(",");
    const imgs = await figma(`/v1/images/${KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=1`);
    for (const f of frames) {
      const url = imgs.images[f.id];
      if (!url) { console.warn(`no render for ${f.name}`); continue; }
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(url);
        if (!r.ok) { await new Promise((res) => setTimeout(res, 2000)); continue; }
        writeFileSync(join(outDir, "renders", f.name + ".png"), Buffer.from(await r.arrayBuffer()));
        break;
      }
    }
    console.log(`renders → ${outDir}/renders`);
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
