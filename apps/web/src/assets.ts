import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serve a static file, with an ETag so a stale copy cannot outlive a deploy.
 *
 * The bundles keep the same names — `/app.js`, `/connect.js` — across every deploy, so a
 * plain `max-age` tells the browser it already has the current file when it does not.
 * `/connect.js` had an hour of that and no validator at all, which meant a fix to the
 * wallet button reached a returning visitor an hour after it shipped, with nothing to
 * hurry it along: a reload re-fetches the page, not its subresources.
 *
 * `no-cache` is not "do not store" — it stores the file and asks before reusing it. The
 * question costs one round trip and is answered with a 304 carrying no body, so the
 * three megabytes of connector are still only downloaded when they actually change.
 */
export function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  type: string,
  immutable: boolean,
): void {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = {
    "content-type": type,
    etag,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };

  // `if-none-match` may list several; a match on any of them means what they hold is
  // current. Weak-comparison prefixes are stripped because we never issue weak tags.
  const offered = (req.headers["if-none-match"] ?? "")
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""));
  if (offered.includes(etag)) {
    res.writeHead(304, headers).end();
    return;
  }

  res.writeHead(200, headers);
  res.end(body);
}
