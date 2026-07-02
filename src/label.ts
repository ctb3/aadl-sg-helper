import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

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

function listImages(): string[] {
  if (!fs.existsSync(config.imagesDir)) return [];
  return fs
    .readdirSync(config.imagesDir)
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
}

function labeledSet(): Set<string> {
  const set = new Set<string>();
  if (!fs.existsSync(config.labelsPath)) return set;
  for (const line of fs.readFileSync(config.labelsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const name = line.slice(0, comma).trim();
    const code = line.slice(comma + 1).trim();
    if (name.toLowerCase() === "filename") continue;
    if (code) set.add(name);
  }
  return set;
}

function appendLabel(name: string, code: string): void {
  fs.mkdirSync(path.dirname(config.labelsPath), { recursive: true });
  if (!fs.existsSync(config.labelsPath)) fs.writeFileSync(config.labelsPath, "filename,code\n");
  fs.appendFileSync(config.labelsPath, `${name},${code}\n`);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(): string {
  const all = listImages();
  const done = labeledSet();
  const remaining = all.filter((f) => !done.has(f));
  const labeled = all.length - remaining.length;

  if (all.length === 0) {
    return `<h2>No images found in ${esc(config.imagesDir)}</h2>`;
  }
  if (remaining.length === 0) {
    return `<h2>All ${all.length} images labeled 🎉</h2><p>Labels: ${esc(config.labelsPath)}</p>`;
  }
  const name = remaining[0];
  return `<!doctype html><meta charset="utf-8">
<title>Label ${esc(name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
img{max-width:100%;max-height:70vh;border:1px solid #ccc}
input[type=text]{font-size:1.4rem;text-transform:uppercase;padding:.4rem;width:16rem}
button{font-size:1.2rem;padding:.4rem 1rem}</style>
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
      if (name && listImages().includes(name) && code) appendLabel(name, code);
      res.writeHead(302, { location: "/" }).end();
    });
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(config.labelPort, () => {
  console.log(`Labeler running: http://localhost:${config.labelPort}`);
  console.log(`Images: ${config.imagesDir}`);
  console.log(`Labels: ${config.labelsPath}`);
  console.log("Ctrl-C to stop.");
});
