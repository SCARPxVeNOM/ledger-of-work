/**
 * Turn the source artwork into something a page can afford to load.
 *
 * The originals are 1.5–2.4MB PNGs at roughly 1200px. Shipping them as-is would cost more
 * than the entire rest of the page put together, for pictures that are decoration. WebP at
 * the sizes they are actually displayed brings that to a few tens of kilobytes each.
 *
 * Two widths per image, for 1x and 2x displays. `hed1` keeps its alpha channel — it is the
 * hero collage and has to sit on the page background rather than in a white box.
 *
 * Run when the artwork changes:
 *   node apps/web/optimise-art.mjs [source-dir]
 *
 * Only the optimised output is committed. The sources live wherever they were made; this
 * script records the sizes and settings so the same output can be produced again.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? "C:/Users/aryan/Downloads";
const out = join(here, "public", "art");
mkdirSync(out, { recursive: true });

/** Displayed width, doubled for retina. Anything larger is detail nobody sees. */
const ART = [
  { file: "hed1", name: "collage", widths: [640, 1280], alpha: true },
  { file: "hed2", name: "livejob", widths: [760, 1520], alpha: false },
  { file: "hed3", name: "paper", widths: [560, 1120], alpha: false },
  { file: "hed4", name: "decision", widths: [760, 1520], alpha: false },
];

let total = 0;
for (const a of ART) {
  for (const w of a.widths) {
    const target = join(out, `${a.name}-${w}.webp`);
    await sharp(join(src, `${a.file}.png`))
      .resize({ width: w, withoutEnlargement: true })
      // Quality 82 is where these stop getting visibly better. `effort: 6` spends longer
      // compressing at build time so the visitor spends less time downloading.
      .webp({ quality: 82, effort: 6, alphaQuality: a.alpha ? 90 : 100 })
      .toFile(target);
    const bytes = statSync(target).size;
    total += bytes;
    console.log(`  ${a.name}-${w}.webp`.padEnd(26), `${(bytes / 1024).toFixed(1)} KB`);
  }
}
console.log(`\n${ART.length * 2} files, ${(total / 1024).toFixed(1)} KB total`);
