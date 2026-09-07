import { describe, expect, it, vi } from "vitest";
import { MIRROR_URLS, MirrorClient, MirrorNotFoundError } from "../src/mirror.js";

/** Builds a fetch stub that returns the given sequence of responses. */
function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: string[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)] as { status: number; body?: unknown };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const MESSAGE = {
  consensus_timestamp: "1788820764.094188030",
  message: "eyJ2IjoxfQ==",
  payer_account_id: "0.0.10410493",
  running_hash: "abc",
  running_hash_version: 3,
  sequence_number: 1,
  topic_id: "0.0.10413059",
};

describe("MirrorClient", () => {
  it("defaults to the public testnet mirror and needs no credentials", () => {
    expect(new MirrorClient().baseUrl).toBe(MIRROR_URLS.testnet);
  });

  it("strips a trailing slash so URLs do not double up", () => {
    expect(new MirrorClient({ baseUrl: "https://x.example/api/v1/" }).baseUrl).toBe(
      "https://x.example/api/v1",
    );
  });

  it("returns a topic message", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: MESSAGE }]);
    const client = new MirrorClient({ fetchImpl: impl });
    await expect(client.topicMessage("0.0.10413059", 1)).resolves.toEqual(MESSAGE);
    expect(calls[0]).toContain("/topics/0.0.10413059/messages/1");
  });

  it("waits out mirror lag rather than declaring a good receipt forged", async () => {
    // Measured lag on testnet was ~1.9s, so a read immediately after a write really does
    // 404. Treating that as "message does not exist" would fail valid receipts.
    const { impl } = stubFetch([
      { status: 404 },
      { status: 404 },
      { status: 200, body: MESSAGE },
    ]);
    const client = new MirrorClient({ fetchImpl: impl, retryDelayMs: 0 });
    await expect(client.topicMessage("0.0.1", 1)).resolves.toEqual(MESSAGE);
  });

  it("gives up on a persistent 404 with a clear error", async () => {
    const { impl } = stubFetch([{ status: 404 }]);
    const client = new MirrorClient({ fetchImpl: impl, retries: 2, retryDelayMs: 0 });
    await expect(client.topicMessage("0.0.1", 99)).rejects.toBeInstanceOf(MirrorNotFoundError);
  });

  it("does not retry a 400 — a malformed id will never become valid", async () => {
    const { impl, calls } = stubFetch([{ status: 400 }]);
    const client = new MirrorClient({ fetchImpl: impl, retries: 5, retryDelayMs: 0 });
    await expect(client.topicMessage("0.0.1", 1)).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it("converts an SDK transaction id to the REST spelling", async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: { transactions: [{ nonce: 0, result: "SUCCESS", transfers: [] }] } },
    ]);
    const client = new MirrorClient({ fetchImpl: impl });
    await client.transaction("0.0.7162784@1788820818.951978891");
    // The @-form returns HTTP 400 from the real API; this is the conversion that matters.
    expect(calls[0]).toContain("/transactions/0.0.7162784-1788820818-951978891");
    expect(calls[0]).not.toContain("@");
  });

  it("accepts an id already in REST form", async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: { transactions: [{ nonce: 0, result: "SUCCESS", transfers: [] }] } },
    ]);
    await new MirrorClient({ fetchImpl: impl }).transaction("0.0.7162784-1788820818-951978891");
    expect(calls[0]).toContain("0.0.7162784-1788820818-951978891");
  });

  it("picks the nonce-0 record when one id returns several", async () => {
    // A scheduled or child transaction shares the parent's id; taking the wrong record
    // would check the wrong transfers.
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          transactions: [
            { nonce: 1, result: "SUCCESS", transfers: [{ account: "0.0.1", amount: 1 }] },
            { nonce: 0, result: "SUCCESS", transfers: [{ account: "0.0.2", amount: 2 }] },
          ],
        },
      },
    ]);
    const tx = await new MirrorClient({ fetchImpl: impl }).transaction("0.0.1-1-1");
    expect(tx.transfers[0]!.account).toBe("0.0.2");
  });

  it("errors rather than inventing a transaction when the list is empty", async () => {
    const { impl } = stubFetch([{ status: 200, body: { transactions: [] } }]);
    await expect(
      new MirrorClient({ fetchImpl: impl }).transaction("0.0.1-1-1"),
    ).rejects.toBeInstanceOf(MirrorNotFoundError);
  });

  it("rejects an unparseable transaction id before making a request", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: {} }]);
    await expect(new MirrorClient({ fetchImpl: impl }).transaction("garbage")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
