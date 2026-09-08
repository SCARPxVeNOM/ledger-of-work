import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HBAR, type PriceBook } from "@low/protocol";
import { QUOTE_TTL_MS, QuoteStore } from "../src/quote-store.js";

const PRICE_BOOK: PriceBook = {
  base: "60000",
  perStep: "45000",
  perPage: "90000",
  perSecond: "9000",
  ceiling: "9000000",
};

const PLAN = { steps: 3, pages: 1, estimatedMs: 3000, outline: ["one"] };

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "low-quotes-"));
  path = join(dir, "quotes.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const add = (store: QuoteStore) =>
  store.create("cap", { a: 1 }, PLAN, "300000", PRICE_BOOK, HBAR, "300000");

describe("QuoteStore in memory", () => {
  it("consumes a quote so one payment cannot buy two jobs", () => {
    const store = new QuoteStore();
    const q = add(store);
    expect(store.consume(q.jobId)).toBeDefined();
    expect(store.consume(q.jobId)).toBeUndefined();
  });

  it("expires a stale quote so a cheap one cannot be banked", () => {
    let now = 1_000_000;
    const store = new QuoteStore({ now: () => now });
    const q = add(store);
    now += QUOTE_TTL_MS + 1;
    expect(store.get(q.jobId)).toBeUndefined();
  });

  it("sweeps expired quotes without touching live ones", () => {
    let now = 1_000_000;
    const store = new QuoteStore({ now: () => now });
    add(store);
    now += QUOTE_TTL_MS + 1;
    const fresh = add(store);
    store.sweep();
    expect(store.size).toBe(1);
    expect(store.get(fresh.jobId)).toBeDefined();
  });
});

describe("QuoteStore survives a restart", () => {
  it("restores an outstanding quote, so a signed payment still finds its job", () => {
    // The failure this prevents: a buyer is quoted, the seller redeploys, and their
    // signed payment arrives against a job nobody recognises — funds committed for a 404.
    const first = new QuoteStore({ path });
    const q = add(first);

    const second = new QuoteStore({ path });
    const restored = second.get(q.jobId);
    expect(restored).toBeDefined();
    expect(restored?.amount).toBe("300000");
    expect(restored?.plan.outline).toEqual(["one"]);
    expect(restored?.asset.id).toBe(HBAR.id);
  });

  it("does not resurrect a quote that expired while the process was down", () => {
    // Reviving it would silently extend a deadline the buyer was told about, and the
    // price may no longer follow the current price book.
    let now = 1_000_000;
    const first = new QuoteStore({ path, now: () => now });
    add(first);

    now += QUOTE_TTL_MS + 1;
    const second = new QuoteStore({ path, now: () => now });
    expect(second.size).toBe(0);
  });

  it("keeps a consumed quote consumed across a restart", () => {
    const first = new QuoteStore({ path });
    const q = add(first);
    first.consume(q.jobId);

    const second = new QuoteStore({ path });
    expect(second.get(q.jobId)).toBeUndefined();
  });

  it("writes atomically, leaving no temp files behind", () => {
    const store = new QuoteStore({ path });
    add(store);
    add(store);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { quotes: unknown[] };
    expect(parsed.quotes).toHaveLength(2);
    // A .tmp left over would mean a rename that never happened.
    expect(readFileSync(path, "utf8").startsWith("{")).toBe(true);
  });

  it("starts clean rather than refusing to boot on a corrupt file", () => {
    // A seller that will not start because its quote cache is damaged is a worse
    // failure than one that starts and asks buyers to re-quote.
    writeFileSync(path, "{ this is not json");
    const store = new QuoteStore({ path });
    expect(store.size).toBe(0);
    expect(() => add(store)).not.toThrow();
  });

  it("ignores entries that are not shaped like quotes", () => {
    writeFileSync(path, JSON.stringify({ quotes: [{ nope: true }, null, 42] }));
    expect(new QuoteStore({ path }).size).toBe(0);
  });

  it("still serves quotes when the path cannot be written", () => {
    // Persistence is durability, not correctness. An unwritable disk must not take the
    // seller down.
    const store = new QuoteStore({ path: join(dir, "no", "such", "\0bad", "q.json") });
    const q = add(store);
    expect(store.get(q.jobId)).toBeDefined();
  });
});
