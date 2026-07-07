import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config";

/**
 * Minimal local labeling helper. Serves each unlabeled image from IMAGES_DIR
 * one at a time; you type the code and it appends `filename,code` to
 * data/labels.csv. You must see the image to label it, so a bare CSV stub would
 * be high-friction — this keeps it minimal without being "an app".
 */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Subfolders (e.g. "extra hard/") are part of the corpus: entries are relative
// paths, normalized to forward slashes so labels.csv rows are stable across
// Windows/WSL runs (sanitize() maps "/" for cache/prepped filenames).
function listImages(): string[] {
  if (!fs.existsSync(config.imagesDir)) return [];
  return fs
    .readdirSync(config.imagesDir, { recursive: true })
    .map((f) => String(f).replaceAll("\\", "/"))
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
}

function labeledMap(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(config.labelsPath)) return map;
  for (const line of fs.readFileSync(config.labelsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const name = line.slice(0, comma).trim();
    const code = line.slice(comma + 1).trim();
    if (name.toLowerCase() === "filename") continue;
    if (code) map.set(name, code);
  }
  return map;
}

// Once everything is labeled, the server walks through existing labels for
// re-verification (e.g. after swapping the underlying image files). Session
// state only — restarting the server restarts the verify pass.
const verified = new Set<string>();

function appendLabel(name: string, code: string): void {
  fs.mkdirSync(path.dirname(config.labelsPath), { recursive: true });
  if (!fs.existsSync(config.labelsPath)) fs.writeFileSync(config.labelsPath, "filename,code\n");
  fs.appendFileSync(config.labelsPath, `${name},${code}\n`);
}

function updateLabel(name: string, code: string): void {
  const lines = fs.readFileSync(config.labelsPath, "utf8").split(/\r?\n/);
  const out = lines.map((line) =>
    line.slice(0, line.indexOf(",")).trim() === name ? `${name},${code}` : line,
  );
  fs.writeFileSync(config.labelsPath, out.join("\n"));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const STYLE = `<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
img{max-width:100%;max-height:70vh;border:1px solid #ccc}
input[type=text]{font-size:1.4rem;text-transform:uppercase;padding:.4rem;width:16rem}
button{font-size:1.2rem;padding:.4rem 1rem}</style>`;

function page(): string {
  const all = listImages();
  const done = labeledMap();
  const remaining = all.filter((f) => !done.has(f));
  const labeled = all.length - remaining.length;

  if (all.length === 0) {
    return `<h2>No images found in ${esc(config.imagesDir)}</h2>`;
  }

  if (remaining.length > 0) {
    const name = remaining[0];
    return `<!doctype html><meta charset="utf-8">
<title>Label ${esc(name)}</title>${STYLE}
<p><b>${labeled}</b> labeled &middot; <b>${remaining.length}</b> remaining</p>
<h3>${esc(name)}</h3>
<img src="/image?name=${encodeURIComponent(name)}" alt="${esc(name)}">
<form method="POST" action="/label">
  <input type="hidden" name="name" value="${esc(name)}">
  <p><input type="text" name="code" autofocus autocomplete="off" autocapitalize="characters"
     placeholder="type the handwritten code"> <button type="submit">Save &rarr;</button></p>
  <p><small>Charset A–Z 0–9. Spaces/case are ignored at scoring time.</small></p>
</form>`;
  }

  // Verify pass: everything is labeled; walk through existing labels.
  const toVerify = all.filter((f) => done.has(f) && !verified.has(f));
  if (toVerify.length === 0) {
    return `<h2>All ${all.length} images labeled &amp; verified 🎉</h2><p>Labels: ${esc(config.labelsPath)}</p>`;
  }
  const name = toVerify[0];
  const current = done.get(name)!;
  return `<!doctype html><meta charset="utf-8">
<title>Verify ${esc(name)}</title>${STYLE}
<p>Verify pass: <b>${verified.size}</b> verified &middot; <b>${toVerify.length}</b> remaining</p>
<h3>${esc(name)}</h3>
<img src="/image?name=${encodeURIComponent(name)}" alt="${esc(name)}">
<form method="POST" action="/label">
  <input type="hidden" name="name" value="${esc(name)}">
  <p><input type="text" name="code" autofocus autocomplete="off" autocapitalize="characters"
     value="${esc(current)}">
     <button type="submit" name="action" value="confirm">Correct ✓</button>
     <button type="submit" name="action" value="save">Save correction</button></p>
  <p><small>"Correct ✓" keeps the label as shown (ignores edits); "Save correction" writes the edited value.</small></p>
</form>`;
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }

  if (req.method === "GET" && url.pathname === "/image") {
    const name = url.searchParams.get("name") ?? "";
    if (!listImages().includes(name)) {
      res.writeHead(404).end("not found");
      return;
    }
    const full = path.join(config.imagesDir, name);
    res.writeHead(200, { "content-type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/label") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = parseForm(body);
      const name = form.name ?? "";
      const code = (form.code ?? "").toUpperCase().replace(/\s+/g, "");
      const action = form.action ?? "";
      if (name && listImages().includes(name)) {
        const existing = labeledMap().get(name);
        if (existing === undefined) {
          if (code) appendLabel(name, code);
        } else if (action === "confirm") {
          verified.add(name);
        } else if (action === "save" && code) {
          if (code !== existing) updateLabel(name, code);
          verified.add(name);
        }
      }
      res.writeHead(302, { location: "/" }).end();
    });
    return;
  }

  res.writeHead(404).end("not found");
});

// Loopback only: this serves the private photo set with no auth — keep it off
// the LAN. (npm runs Windows node, so the Windows browser still reaches it.)
server.listen(config.labelPort, "127.0.0.1", () => {
  console.log(`Labeler running: http://localhost:${config.labelPort}`);
  console.log(`Images: ${config.imagesDir}`);
  console.log(`Labels: ${config.labelsPath}`);
  console.log("Ctrl-C to stop.");
});
