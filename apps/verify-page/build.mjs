/**
 * Bundle the verifier for a browser.
 *
 * The point of bundling rather than rewriting is that this page runs the *same*
 * `verifyReceipt` as the CLI. Two independent verifiers would eventually disagree, and a
 * disagreement between two things that both claim to prove delivery is worse than having
 * one of them.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, "public"), out, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(out, "verify.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  // The worker package pulls Playwright in for its adapters, but this page only reads
  // their published price books. Marking it external keeps a browser bundle from trying
  // to include a browser automation driver.
  external: ["playwright"],
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`built dist/verify.js  ${(bytes / 1024).toFixed(1)} KB`);
console.log(`static output in      ${out}`);
