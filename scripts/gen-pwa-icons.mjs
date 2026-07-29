#!/usr/bin/env node
// One-shot PWA icon rasteriser
// =====================================================================
// Renders public/icon.svg to the three PNG sizes the PWA install flow
// asks for on Android + iOS:
//
//   • icon-192.png         Android home-screen (Chrome minimum requirement)
//   • icon-512.png         Android splash-screen + higher-DPI launchers
//   • apple-touch-icon.png Safari/iOS home-screen (fixed 180x180)
//
// Uses `sharp` on-demand via `npx --yes -p sharp` so this stays out of
// package.json — the app itself has no PNG-generation dep and only pays
// for sharp when someone actually reruns this generator (which should
// be roughly never after initial deploy). If you want to tweak the
// icon design, edit public/icon.svg and rerun:
//
//   node scripts/gen-pwa-icons.mjs
//
// (or `npx --yes -p sharp node scripts/gen-pwa-icons.mjs` if you don't
// have sharp installed globally; the shebang line assumes system Node
// >= 20 which ships in the repo already).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const svgPath = join(publicDir, "icon.svg");

const svgBuf = await readFile(svgPath);

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

for (const t of targets) {
  const outPath = join(publicDir, t.file);
  const png = await sharp(svgBuf, { density: 384 })
    .resize(t.size, t.size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(outPath, png);
  console.log(`  ✓ ${t.file}  (${png.length.toLocaleString()} bytes)`);
}

console.log("\nDone. Commit the three PNGs alongside icon.svg.");
