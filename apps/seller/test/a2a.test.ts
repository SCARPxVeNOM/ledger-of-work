import { describe, expect, it, vi } from "vitest";
import { A2AServer, type A2ADeps } from "../src/a2a.js";

/**
 * The negotiation endpoint.
 *
 * Two things are being protected here. One is the protocol shape — an agent that speaks
 * A2A should not have to guess how this server spells things. The other, and the reason
 * the accept path is tested hardest, is that this is where an agreed number turns into a
 * payable one: everything before it is conversation, and everything after it is money.
 */

const HBAR = "0.0.0";

function server(over: Partial<A2ADeps> = {}) {
  const quote = vi.fn(async (_c: string, _p: unknown, _a: string) => ({
    jobId: "job-1",
    run: "https://seller.example/jobs/job-1/run",
    amount: "312000",
    expiresAt: "2026-01-01T00:00:00Z",
  }));
  return { quote, srv: new A2AServer({ assets: [HBAR], quote, ...over }) };
}

const send = (data: Record<string, unknown>, contextId?: string) => ({
  jsonrpc: "2.0",
  id: "1",
  method: "message/send",
  params: {
    message: {
      role: "user",
      messageId: "m1",
      ...(contextId ? { contextId } : {}),
      parts: [{ kind: "data", data }],
    },
  },
});

/** The structured half of an agent reply — what a machine acts on. */
function dataOf(res: Record<string, unknown>): Record<string, unknown> {
  const parts = (res.result as { parts?: Array<Record<string, unknown>> })?.parts ?? [];
  return (parts.find((p) => p.data)?.data ?? {}) as Record<string, unknown>;
}

describe("opening terms", () => {
  it("accepts a job the budget covers", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 }, budgetTinybar: "999999" }),
    );

    expect(dataOf(res).outcome).toBe("accepted");
  });

  it("counter-offers a smaller job when the budget is short", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 100 }, budgetTinybar: "500000" }),
    );
    const data = dataOf(res);

    expect(data.outcome).toBe("counter-offer");
    // What it costs and what it would have cost, so the buyer can judge the trade.
    const offer = data.offer as { priceTinybar: string; params: { max: number } };
    const asked = data.asked as { priceTinybar: string; params: { max: number } };
    expect(BigInt(offer.priceTinybar)).toBeLessThanOrEqual(500000n);
    expect(BigInt(asked.priceTinybar)).toBeGreaterThan(500000n);
    expect(offer.params.max).toBeLessThan(asked.params.max);
    // And it says, in a field rather than in prose, that the rate did not move.
    expect(data.negotiated).toBe("scope");
  });

  it("refuses with the floor price when nothing fits", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 100 }, budgetTinybar: "1" }),
    );
    const data = dataOf(res);

    expect(data.outcome).toBe("rejected");
    // "No" alone is useless; the floor tells the buyer what budget would work.
    expect(BigInt((data.floor as { priceTinybar: string }).priceTinybar)).toBeGreaterThan(1n);
  });

  it("quotes without negotiating when no budget is given", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 } }),
    );

    expect(dataOf(res).outcome).toBe("quoted");
  });

  it("never charges anything while terms are still being discussed", async () => {
    const { srv, quote } = server();
    await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 100 }, budgetTinybar: "500000" }),
    );

    expect(quote).not.toHaveBeenCalled();
  });
});

describe("accepting", () => {
  it("turns the agreed offer into a payable run URL", async () => {
    const { srv, quote } = server();
    const opened = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 }, budgetTinybar: "999999" }),
    );
    const contextId = (opened.result as { contextId: string }).contextId;

    const agreed = await srv.handle(send({ accept: true }, contextId));
    const data = dataOf(agreed);

    expect(data.outcome).toBe("agreed");
    expect(data.run).toContain("/run");
    expect(data.settlement).toBe("x402");
    expect(quote).toHaveBeenCalledOnce();
  });

  it("buys the counter-offer, not the job that was too expensive", async () => {
    // The failure this prevents: negotiating down to 40 records and being quoted for 100.
    const { srv, quote } = server();
    const opened = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 100 }, budgetTinybar: "500000" }),
    );
    const offered = (dataOf(opened).offer as { params: { max: number } }).params.max;
    const contextId = (opened.result as { contextId: string }).contextId;

    await srv.handle(send({ accept: true }, contextId));

    const [, params] = quote.mock.calls[0]!;
    expect((params as { max: number }).max).toBe(offered);
    expect((params as { max: number }).max).toBeLessThan(100);
  });

  it("refuses to settle if the quote disagrees with what was agreed", async () => {
    // A quote that comes back at a different number than the one negotiated is a bug, and
    // the buyer is the one who would pay for it. Fail loudly instead.
    const { srv } = server({
      quote: async () => ({
        jobId: "job-1",
        run: "https://seller.example/jobs/job-1/run",
        amount: "999999999",
        expiresAt: "2026-01-01T00:00:00Z",
      }),
    });
    const opened = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 }, budgetTinybar: "999999" }),
    );
    const contextId = (opened.result as { contextId: string }).contextId;

    const res = await srv.handle(send({ accept: true }, contextId));

    expect(res.error).toBeDefined();
    expect(String((res.error as { message: string }).message)).toMatch(/nothing was charged/);
  });

  it("cannot accept an offer twice", async () => {
    const { srv, quote } = server();
    const opened = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 }, budgetTinybar: "999999" }),
    );
    const contextId = (opened.result as { contextId: string }).contextId;

    await srv.handle(send({ accept: true }, contextId));
    const again = await srv.handle(send({ accept: true }, contextId));

    expect(again.error).toBeDefined();
    expect(quote).toHaveBeenCalledOnce();
  });

  it("rejects an acceptance with no conversation behind it", async () => {
    const { srv, quote } = server();
    const res = await srv.handle(send({ accept: true }, "not-a-real-context"));

    expect(res.error).toBeDefined();
    expect(quote).not.toHaveBeenCalled();
  });
});

describe("speaking the protocol", () => {
  it("answers the REST spelling of the method as well as the JSON-RPC one", async () => {
    const { srv } = server();
    const req = send({ capability: "quotes.search_and_extract", params: { max: 3 } });
    const res = await srv.handle({ ...req, method: "SendMessage" });

    expect(res.error).toBeUndefined();
  });

  it("reads a bare data part as well as a tagged one", async () => {
    const { srv } = server();
    const res = await srv.handle({
      jsonrpc: "2.0",
      id: "1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ data: { capability: "quotes.search_and_extract", params: { max: 3 } } }],
        },
      },
    });

    expect(dataOf(res).outcome).toBe("quoted");
  });

  it("replies as an agent message carrying both prose and data", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 } }),
    );
    const result = res.result as { role: string; parts: Array<Record<string, unknown>> };

    expect(res.jsonrpc).toBe("2.0");
    expect(result.role).toBe("agent");
    expect(result.parts.some((p) => p.text)).toBe(true);
    expect(result.parts.some((p) => p.data)).toBe(true);
  });

  it("returns method-not-found rather than guessing", async () => {
    const { srv } = server();
    const res = await srv.handle({ jsonrpc: "2.0", id: "1", method: "tasks/get", params: {} });

    expect((res.error as { code: number }).code).toBe(-32601);
  });

  it("names an unknown capability instead of failing vaguely", async () => {
    const { srv } = server();
    const res = await srv.handle(send({ capability: "nope.not_real", params: {} }));

    expect(String((res.error as { message: string }).message)).toMatch(/unknown capability/);
  });

  it("refuses an asset it does not settle in", async () => {
    const { srv } = server();
    const res = await srv.handle(
      send({ capability: "quotes.search_and_extract", params: { max: 3 }, asset: "0.0.999" }),
    );

    expect(String((res.error as { message: string }).message)).toMatch(/cannot settle/);
  });
});
