/**
 * Bundle the browser half of the demo: the React app, its stylesheet, and the wallet
 * connector.
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
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "public", "connect.js");
mkdirSync(dirname(out), { recursive: true });

/** The connector, kept as its own bundle so the app does not pay for it up front. */
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

/**
 * The app itself.
 *
 * Split from the connector deliberately: this is what every visitor downloads, and the
 * connector is several megabytes that only somebody connecting a wallet should pay for.
 * `connect.js` is marked external so the dynamic import in the app resolves to the
 * separate bundle at runtime rather than being inlined into this one.
 */
const app = await esbuild.build({
  entryPoints: [join(here, "src", "ui", "main.tsx")],
  outfile: join(here, "public", "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["../connect.js"],
  metafile: true,
  logLevel: "error",
});

const appBytes = Object.values(app.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`built public/app.js      ${(appBytes / 1024).toFixed(1)} KB`);

/**
 * Tailwind scans the sources for the classes actually used and emits only those, so the
 * stylesheet is a few kilobytes rather than the whole framework.
 *
 * Resolved to its JS entry and run with this same Node, rather than shelling out to
 * `npx`. On Windows `npx` is a `.cmd` shim that Node 20+ refuses to spawn without a
 * shell, and the failure looks like a missing dependency rather than a spawn rule.
 */
const require_ = createRequire(import.meta.url);
const tailwindBin = join(
  dirname(require_.resolve("@tailwindcss/cli/package.json")),
  "dist",
  "index.mjs",
);
execFileSync(
  process.execPath,
  [tailwindBin, "-i", join(here, "src", "ui", "app.css"), "-o", join(here, "public", "app.css"), "--minify"],
  { stdio: ["ignore", "ignore", "inherit"], cwd: here },
);
console.log(`built public/app.css     ${(statSync(join(here, "public", "app.css")).size / 1024).toFixed(1)} KB`);
