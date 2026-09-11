/**
 * Bundle the wallet connector for the browser.
 *
 * The demo page was plain HTML with no build step, which was the right trade while the
 * only buyer was a local process the server talked to. Reaching the visitor's *own*
 * wallet has to happen in their browser, and the connector is an npm ESM package, so
 * there has to be a bundler now.
 *
 * Kept deliberately separate from the page itself: `index.html` still works with no
 * JavaScript build for everything except connecting a wallet, so a bundling failure
 * degrades the demo rather than blanking it.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "public", "connect.js");
mkdirSync(dirname(out), { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(here, "src", "connect.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  // The connector reaches for Node globals through its dependency chain. Browsers have
  // neither, and the shims are small enough that pulling in a polyfill library would be
  // the heavier choice.
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  // Playwright arrives through @low/worker, which this page touches only for the
  // published price books. A browser bundle must not contain a browser automation driver.
  external: ["playwright"],
  metafile: true,
  logLevel: "error",
});

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`built public/connect.js  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
