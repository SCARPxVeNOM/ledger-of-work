import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveAsset } from "../src/assets.js";

/**
 * The bundles must never outlive a deploy.
 *
 * This is the regression from the wallet-button fix: `/connect.js` was served with an
 * hour of `max-age` and no validator, so the corrected bundle shipped, the live site
 * served it, and the browser kept running the old one anyway — with no way to tell from
 * the page that the code being executed was not the code that was deployed.
 */

/** Just enough of the two halves of a request for `serveAsset` to be exercised. */
function exchange(ifNoneMatch?: string) {
  const req = { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} } as IncomingMessage;
  const sent: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return this;
    },
    end(body?: Buffer) {
      sent.body = body;
    },
  } as unknown as ServerResponse;
  return { req, res, sent };
}

describe("serveAsset", () => {
  it("tells the browser to revalidate a bundle rather than assume it is current", () => {
    const { req, res, sent } = exchange();
    serveAsset(req, res, Buffer.from("console.log(1)"), "text/javascript", false);

    expect(sent.status).toBe(200);
    expect(sent.headers?.["cache-control"]).toBe("no-cache");
    expect(sent.headers?.etag).toMatch(/^"[\w-]{27}"$/);
  });

  it("still caches fonts and artwork for a year, because their names change with them", () => {
    const { req, res, sent } = exchange();
    serveAsset(req, res, Buffer.from("webp"), "image/webp", true);

    expect(sent.headers?.["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("answers an unchanged file with a bodiless 304", () => {
    const body = Buffer.from("console.log(1)");
    const first = exchange();
    serveAsset(first.req, first.res, body, "text/javascript", false);
    const etag = first.sent.headers!.etag;

    const second = exchange(etag);
    serveAsset(second.req, second.res, body, "text/javascript", false);

    expect(second.sent.status).toBe(304);
    expect(second.sent.body).toBeUndefined();
  });

  it("sends the new bytes when the file has changed under the same name", () => {
    const old = exchange();
    serveAsset(old.req, old.res, Buffer.from("the old bundle"), "text/javascript", false);

    // The deploy the browser missed: same URL, different contents.
    const next = exchange(old.sent.headers!.etag);
    serveAsset(next.req, next.res, Buffer.from("the fixed bundle"), "text/javascript", false);

    expect(next.sent.status).toBe(200);
    expect(next.sent.body?.toString()).toBe("the fixed bundle");
  });

  it("honours a weak validator and a list, which is what real caches send", () => {
    const body = Buffer.from("console.log(1)");
    const first = exchange();
    serveAsset(first.req, first.res, body, "text/javascript", false);
    const etag = first.sent.headers!.etag;

    const second = exchange(`"something-else", W/${etag}`);
    serveAsset(second.req, second.res, body, "text/javascript", false);

    expect(second.sent.status).toBe(304);
  });
});
