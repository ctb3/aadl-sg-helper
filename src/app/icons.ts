import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * PWA icons + web app manifest, rendered from the AADL Summer Game sign
 * (assets/sign.png, 322x322 opaque-white bg) at request time and memoized —
 * sharp already ships in the Lambda image. The blue-circle favicon is gone;
 * the browser tab and the home-screen icon are both the sign now.
 *
 * `safe` < 1 shrinks the sign into the center and pads with white so the
 * Android adaptive-icon circular mask can't clip the rainbow ring (maskable
 * safe zone). Full-bleed (safe=1) is used everywhere the platform doesn't
 * mask to a circle (favicon, iOS apple-touch — iOS rounds the corners itself).
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets/sign.png");
const WHITE = "#ffffff";

interface Spec {
  size: number;
  safe: number;
}

const SPECS: Record<string, Spec> = {
  "favicon.png": { size: 48, safe: 1 },
  "icon-192.png": { size: 192, safe: 1 },
  "icon-512.png": { size: 512, safe: 1 },
  "icon-maskable-512.png": { size: 512, safe: 0.8 },
  "apple-touch-icon.png": { size: 180, safe: 1 },
};

export const MANIFEST_JSON = JSON.stringify({
  name: "AADL Summer Game Code Helper",
  short_name: "AADL Codes",
  display: "standalone",
  start_url: "/",
  scope: "/",
  theme_color: "#f6f5f2",
  background_color: "#f6f5f2",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

const cache = new Map<string, Promise<Buffer>>();

async function render({ size, safe }: Spec): Promise<Buffer> {
  const content = Math.round(size * safe);
  const inner = await sharp(SRC)
    .resize(content, content, { fit: "contain", background: WHITE })
    .toBuffer();
  if (content === size) return sharp(inner).png().toBuffer();
  const off = Math.floor((size - content) / 2);
  return sharp({ create: { width: size, height: size, channels: 3, background: WHITE } })
    .composite([{ input: inner, left: off, top: off }])
    .png()
    .toBuffer();
}

export function isIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECS, name);
}

export function icon(name: string): Promise<Buffer> {
  let p = cache.get(name);
  if (!p) {
    p = render(SPECS[name]);
    cache.set(name, p);
  }
  return p;
}

// Fail fast at import if the asset went missing from the image build.
if (!fs.existsSync(SRC)) throw new Error(`icon source missing: ${SRC}`);
