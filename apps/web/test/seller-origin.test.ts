import { describe, expect, it } from "vitest";
import { belongsToSeller, sellerOrigins } from "../src/main.js";

/**
 * Which run URLs this server will fetch on a buyer's behalf.
 *
 * Two failure modes, and the project has now hit one of them in production. Too strict and
 * every real payment is rejected — `SELLER_URL` on Railway is the private-network address
 * the server dials, while a run URL is minted with the seller's public address, so
 * comparing them turned every "Pay and run" into a 400. Too loose and this becomes an open
 * proxy that will fetch anything a stranger names.
 *
 * This exercises the real function. It used to test a copy, because importing `main.ts`
 * seized a port — which meant the check the server actually runs was never the check under
 * test. The server now only listens when it is the program being run, and the allowed set
 * is a parameter, so the copy is gone.
 */
const ALLOWED = sellerOrigins([
  "http://seller.railway.internal:8402",
  "https://seller-production-d5ab.up.railway.app",
]);
const check = (u: string) => belongsToSeller(u, ALLOWED);

describe("run urls this server will fetch", () => {
  it("accepts the public address a run url is actually minted with", () => {
    // The regression: this is what the browser sends, and it was being rejected.
    expect(check("https://seller-production-d5ab.up.railway.app/jobs/abc/run")).toBe(true);
  });

  it("accepts the private address the server dials the seller on", () => {
    expect(check("http://seller.railway.internal:8402/jobs/abc/run")).toBe(true);
  });

  it("refuses a host that merely begins with the seller's", () => {
    // The reason this compares origins rather than prefixes. A startsWith check accepts
    // this, and it is precisely the open proxy the guard exists to prevent.
    expect(check("https://seller-production-d5ab.up.railway.app.evil.example/x")).toBe(false);
  });

  it("refuses a different host entirely", () => {
    expect(check("https://evil.example/jobs/abc/run")).toBe(false);
    expect(check("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("refuses the right host on the wrong port or scheme", () => {
    expect(check("http://seller.railway.internal:9999/jobs/abc/run")).toBe(false);
    expect(check("https://seller.railway.internal:8402/jobs/abc/run")).toBe(false);
  });

  it("refuses something that is not a url at all", () => {
    expect(check("not a url")).toBe(false);
    expect(check("")).toBe(false);
  });
});
