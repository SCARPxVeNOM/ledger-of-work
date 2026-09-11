/**
 * Serve the built verifier, with the same headers `vercel.json` declares.
 *
 * Small on purpose. This page is the trust anchor — the thing a sceptic runs when they
 * assume we are lying — so what stands between them and the files should be short enough
 * to read in full rather than a framework they have to take on faith.
 *
 * The headers are not decoration. The CSP is what stops a compromised or injected script
 * from turning a verifier into something that reports PASS on anything.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.VERIFY_PORT ?? 8405);
const ROOT = "dist";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
  // Every source is 'self' except the mirror node. The fonts used to require naming two
  // Google origins here; vendoring them removed both, which is the real reason to
  // self-host — the policy got shorter and strictly stricter.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data:; connect-src https:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

createServer((req, res) => {
  const requested = (req.url ?? "/").split("?")[0];
  // `normalize` collapses `..` before it is joined, so a request for
  // /../../etc/passwd cannot escape dist. The leading-slash check catches what is left.
  const rel = normalize(requested === "/" ? "/index.html" : requested).replace(/^[/\\]+/, "");
  if (rel.startsWith("..")) {
    res.writeHead(403).end("no");
    return;
  }

  try {
    const body = readFileSync(join(ROOT, rel));
    res.writeHead(200, {
      "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
      ...HEADERS,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...HEADERS });
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`verifier  http://0.0.0.0:${PORT}  (static, no keys, no backend)`);
});
