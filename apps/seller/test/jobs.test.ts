import { describe, expect, it, vi } from "vitest";
import { HBAR, type PriceBook, type Receipt } from "@low/protocol";
import { executeJob } from "../src/jobs.js";
import { QuoteStore, type Quote } from "../src/quote-store.js";

/**
 * These exercise the lifecycle's failure paths without a browser or a network.
 *
 * They matter because the failure paths are the ones that decide whether a buyer is
 * charged for work they did not receive, and they are exactly the paths a happy-path
 * demo never touches.
 */

const PRICE_BOOK: PriceBook = {
  base: "60000",
  perStep: "45000",
  perPage: "90000",
  perSecond: "9000",
  ceiling: "9000000",
};

function makeQuote(): Quote {
  return {
    jobId: "job-1",
    capability: "test.capability",
    params: { a: 1 },
    plan: { steps: 3, pages: 1, estimatedMs: 3000, outline: ["one", "two"] },
    amount: "300000",
    asset: HBAR,
    assetAmount: "300000",
    priceBook: PRICE_BOOK,
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** Records what was published without touching Hedera. */
function fakePublisher() {
  const published: Receipt[] = [];
  let failures = 0;
  return {
    published,
    setFailures: (n: number) => {
      failures = n;
    },
    publisher: {
      topicId: "0.0.1",
      accountId: "0.0.2",
      publish: vi.fn(async (r: Receipt) => {
        if (failures > 0) {
          failures--;
          throw new Error("consensus node unavailable");
        }
        published.push(structuredClone(r));
        return { topicId: "0.0.1", sequenceNumber: published.length };
      }),
      close: vi.fn(),
    },
  };
}

function fakeFacilitator(over: { valid?: boolean; settles?: boolean } = {}) {
  return {
    feePayer: "0.0.7162784",
    verify: vi.fn(async () => ({ isValid: over.valid ?? true, payer: "0.0.999" })),
    settle: vi.fn(async () =>
      over.settles === false
        ? { success: false, errorReason: "transaction_failed", errorMessage: "INSUFFICIENT_PAYER_BALANCE" }
        : { success: true, transaction: "0.0.7162784@1788820818.951978891", payer: "0.0.999" },
    ),
  };
}

/**
 * The smallest thing runJob will accept as a browser.
 *
 * Passing a bare {} made every job fail inside runJob on `newContext is not a function`,
 * which made the "settles nothing" test pass for entirely the wrong reason — the job was
 * failing on the fake, not on the adapter. A fake has to be real enough that the code
 * under test reaches the branch being tested.
 */
function fakeBrowser() {
  const page = { close: async () => {} };
  return {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {},
    }),
    close: async () => {},
  };
}

/** An adapter whose run() always throws, standing in for a site that broke mid-job. */
const failingAdapter = {
  spec: {
    name: "test.capability",
    site: "https://example.test",
    description: "",
    priceBook: PRICE_BOOK,
    limits: { maxSteps: 5, maxPages: 3, maxSessionMs: 10_000 },
  },
  normalise: (p: unknown) => p,
  plan: () => ({ steps: 3, pages: 1, estimatedMs: 3000, outline: [] }),
  parse: () => [],
  run: async () => {
    throw new Error("the site stopped responding");
  },
};

const deps = (publisher: ReturnType<typeof fakePublisher>, facilitator: ReturnType<typeof fakeFacilitator>) =>
  ({
    adapter: failingAdapter,
    facilitator,
    publisher: publisher.publisher,
    browser: fakeBrowser(),
    sellerAccountId: "0.0.10410493",
    network: "hedera:testnet",
    // biome-ignore lint/suspicious/noExplicitAny: fakes stand in for real collaborators
  }) as any;

describe("a job that fails", () => {
  it("settles nothing", async () => {
    const pub = fakePublisher();
    const fac = fakeFacilitator();
    const out = await executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, deps(pub, fac));

    expect(out.ok).toBe(false);
    expect(fac.settle).not.toHaveBeenCalled();
    expect(out.charged).toBe("0");
  });

  it("still publishes a receipt — a log of only successes proves nothing", async () => {
    const pub = fakePublisher();
    const out = await executeJob(
      makeQuote(),
      {} as never,
      { asset: "0.0.0" } as never,
      deps(pub, fakeFacilitator()),
    );

    expect(pub.published).toHaveLength(1);
    const receipt = pub.published[0] as Receipt;
    expect(receipt.status).toBe("failed");
    expect(receipt.price.charged).toBe("0");
    expect(receipt.payment.txId).toBeUndefined();
    expect(out.error).toMatch(/stopped responding/);
  });

  it("records the work performed even though nothing was charged", async () => {
    const pub = fakePublisher();
    await executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, deps(pub, fakeFacilitator()));
    // The quote's plan is preserved so the abandoned job is still priceable in hindsight.
    expect((pub.published[0] as Receipt).plan.steps).toBe(3);
  });
});

describe("a settlement that fails", () => {
  it("charges zero and records the failure", async () => {
    const pub = fakePublisher();
    const fac = fakeFacilitator({ settles: false });
    const okAdapter = { ...failingAdapter, run: async () => [{ ok: true }] };

    const out = await executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, {
      ...deps(pub, fac),
      adapter: okAdapter,
    });

    expect(fac.settle).toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.charged).toBe("0");
    expect((pub.published[0] as Receipt).status).toBe("failed");
    expect(out.error).toMatch(/INSUFFICIENT_PAYER_BALANCE/);
  });
});

describe("a payment that does not verify", () => {
  it("throws before any work is done, so a bad payer costs nothing", async () => {
    const pub = fakePublisher();
    const fac = fakeFacilitator({ valid: false });
    await expect(
      executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, deps(pub, fac)),
    ).rejects.toThrow(/payment rejected/);
    expect(pub.published).toHaveLength(0);
    expect(fac.settle).not.toHaveBeenCalled();
  });
});

describe("publishing a receipt", () => {
  it("retries a transient failure rather than losing the record", async () => {
    const pub = fakePublisher();
    pub.setFailures(2);
    const okAdapter = { ...failingAdapter, run: async () => [{ ok: true }] };

    const out = await executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, {
      ...deps(pub, fakeFacilitator()),
      adapter: okAdapter,
    });

    expect(pub.publisher.publish).toHaveBeenCalledTimes(3);
    expect(out.ok).toBe(true);
    expect(pub.published).toHaveLength(1);
  });

  it("fails loudly when the receipt can never be published", async () => {
    // Money has moved and no record exists — the caller must not report success.
    const pub = fakePublisher();
    pub.setFailures(99);
    const okAdapter = { ...failingAdapter, run: async () => [{ ok: true }] };

    await expect(
      executeJob(makeQuote(), {} as never, { asset: "0.0.0" } as never, {
        ...deps(pub, fakeFacilitator()),
        adapter: okAdapter,
      }),
    ).rejects.toThrow(/could not be published/);
  });
});
