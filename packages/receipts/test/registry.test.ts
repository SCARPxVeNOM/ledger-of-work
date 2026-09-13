import { describe, expect, it } from "vitest";
import { canonicalByteLength, HCS_CHUNK_BYTES } from "@low/protocol";
import {
  buildListing,
  formatDirectory,
  readDirectory,
  resolveSigner,
  type DirectoryEntry,
} from "../src/registry.js";

const BASE = {
  uaid: "uaid:aid:4Qsy3gHWJbC7GChe8WhWnmFXNLkTpuucn36TW4HgtaQyDU1MgAnEiWhpYsohHGwJ7B;uid=0;registry=ledger-of-work;proto=a2a;nativeId=hedera:testnet:0.0.10410493",
  name: "Ledger of Work",
  url: "https://seller.example",
  skills: [
    { id: "quotes.search_and_extract", from: "204000" },
    { id: "oracle.capture_claim", from: "204000" },
  ],
  receipts: "0.0.10413059",
  network: "hedera:testnet",
};

describe("building a listing", () => {
  it("keeps what a buyer needs to act on it", () => {
    const l = buildListing(BASE);
    expect(l.kind).toBe("listing");
    expect(l.uaid).toBe(BASE.uaid);
    expect(l.receipts).toBe("0.0.10413059");
    expect(l.skills).toHaveLength(2);
    expect(Date.parse(l.at)).not.toBeNaN();
  });

  it("insists on an HCS-14 identifier rather than a URL", () => {
    // A directory keyed by URL cannot survive a service moving host, which is the exact
    // thing HCS-14 exists to stop.
    expect(() => buildListing({ ...BASE, uaid: "https://seller.example" })).toThrow(/uaid/);
    expect(() => buildListing({ ...BASE, uaid: "" })).toThrow(/uaid/);
  });

  it("rejects a url that is not absolute", () => {
    expect(() => buildListing({ ...BASE, url: "/jobs" })).toThrow(/url/);
    expect(() => buildListing({ ...BASE, url: "seller.example" })).toThrow(/url/);
  });

  it("fits one HCS chunk with a full complement of skills", () => {
    // Over 1024 bytes the message is split, and the mirror REST API does not reassemble
    // chunks — so an oversized listing is not a large listing, it is an unreadable one.
    const l = buildListing({
      ...BASE,
      skills: Array.from({ length: 8 }, (_, i) => ({
        id: `some.fairly_long_capability_name_${i}`,
        from: "9999000",
      })),
    });
    expect(canonicalByteLength(l)).toBeLessThanOrEqual(HCS_CHUNK_BYTES);
  });

  it("caps the skill list rather than publishing something unreadable", () => {
    const l = buildListing({
      ...BASE,
      skills: Array.from({ length: 40 }, (_, i) => ({ id: `cap${i}`, from: "1" })),
    });
    expect(l.skills).toHaveLength(8);
  });

  it("throws when it still will not fit", () => {
    expect(() =>
      buildListing({ ...BASE, uaid: `uaid:aid:${"x".repeat(1200)}` }),
    ).toThrow(/HCS chunks/);
  });

  it("trims an over-long name instead of failing the publish", () => {
    expect(buildListing({ ...BASE, name: "n".repeat(200) }).name).toHaveLength(60);
  });
});

describe("rendering the directory", () => {
  const entry = (over: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
    listing: buildListing(BASE),
    submitter: "0.0.10410493",
    sequenceNumber: 1,
    at: "1789116561.255075192",
    ...over,
  });

  it("says who posted each listing, which is the only unforgeable fact in it", () => {
    const out = formatDirectory([entry()]);
    expect(out).toContain("0.0.10410493");
    expect(out).toContain("https://seller.example");
    expect(out).toContain("oracle.capture_claim");
  });

  it("shows the receipts topic, which is what makes a listing checkable", () => {
    expect(formatDirectory([entry()])).toContain("0.0.10413059");
  });

  it("says so plainly when the directory is empty", () => {
    expect(formatDirectory([])).toContain("no services listed");
  });
});

describe("folding the topic into a directory", () => {
  /** A mirror node that answers newest-first, which is what the real one does. */
  function mirrorReturning(messages: Array<{ seq: number; body: unknown; payer: string }>) {
    return async (url: string | URL) => {
      if (!String(url).includes("/messages")) throw new Error(`unexpected fetch: ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [...messages]
            .sort((a, b) => b.seq - a.seq)
            .map((m) => ({
              message: Buffer.from(JSON.stringify(m.body), "utf8").toString("base64"),
              sequence_number: m.seq,
              payer_account_id: m.payer,
              consensus_timestamp: `${1789116561 + m.seq}.0`,
              topic_id: "0.0.1",
            })),
        }),
      } as Response;
    };
  }

  const withMirror = async <T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("keeps the newest listing when a service moves host", async () => {
    // The regression: the mirror returns newest-first, so folding in arrival order kept
    // the *oldest* entry and the directory went on advertising an address the service
    // had already left.
    const entries = await withMirror(
      mirrorReturning([
        { seq: 1, payer: "0.0.1", body: buildListing({ ...BASE, url: "http://localhost:8402" }) },
        { seq: 2, payer: "0.0.1", body: buildListing({ ...BASE, url: "https://hosted.example" }) },
      ]) as unknown as typeof fetch,
      () => readDirectory("0.0.1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.listing.url).toBe("https://hosted.example");
    expect(entries[0]?.sequenceNumber).toBe(2);
  });

  it("keeps two publishers of the same agent apart", async () => {
    // Same uaid, different accounts. One account must not be able to overwrite another's
    // claim by reposting it — so both survive and the reader can see who said what.
    const entries = await withMirror(
      mirrorReturning([
        { seq: 1, payer: "0.0.1", body: buildListing(BASE) },
        { seq: 2, payer: "0.0.2", body: buildListing({ ...BASE, url: "https://impostor.example" }) },
      ]) as unknown as typeof fetch,
      () => readDirectory("0.0.1"),
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.submitter).sort()).toEqual(["0.0.1", "0.0.2"]);
  });

  it("skips junk rather than letting one bad message break the directory", async () => {
    const entries = await withMirror(
      mirrorReturning([
        { seq: 1, payer: "0.0.1", body: "not a listing" },
        { seq: 2, payer: "0.0.1", body: { kind: "something-else" } },
        { seq: 3, payer: "0.0.2", body: buildListing(BASE) },
      ]) as unknown as typeof fetch,
      () => readDirectory("0.0.1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.submitter).toBe("0.0.2");
  });
});

describe("resolving a signer from the directory", () => {
  /**
   * A relayed receipt is checked on its signature, so a buyer who has never heard of the
   * seller needs somewhere public to learn which key that should be. The directory
   * already carries the topic; this is the rest of what a verifier needs.
   */
  const listing = {
    v: 1 as const,
    kind: "listing" as const,
    uaid: "uaid:aid:abc",
    name: "Someone Else",
    url: "https://elsewhere.example",
    skills: [{ id: "text.summarise", from: "1000" }],
    receipts: "0.0.777",
    network: "hedera:testnet",
    at: "2026-09-12T00:00:00.000Z",
    publicKey: "302a300506032b6570032100aa",
    book: {
      base: "1000",
      perStep: "0",
      perPage: "0",
      perSecond: "0",
      ceiling: "9999",
      per: { tokens: "5" },
    },
  };
  const entry = (over: Partial<DirectoryEntry> = {}): DirectoryEntry =>
    ({ listing, submitter: "0.0.1", sequenceNumber: 1, at: listing.at, ...over }) as DirectoryEntry;

  it("returns the topic, key and book a verifier needs", () => {
    expect(resolveSigner([entry()], "uaid:aid:abc")).toEqual({
      topic: "0.0.777",
      publicKey: "302a300506032b6570032100aa",
      book: listing.book,
    });
  });

  it("returns null for an identity nobody listed", () => {
    expect(resolveSigner([entry()], "uaid:aid:nobody")).toBeNull();
  });

  it("returns null when the listing names no key, rather than a half-answer", () => {
    // A topic without a key invites a caller to check everything except who wrote it,
    // which for a relayed receipt is the check that matters most.
    const { publicKey: _none, ...noKey } = listing;
    expect(resolveSigner([entry({ listing: noKey as never })], "uaid:aid:abc")).toBeNull();
  });

  it("returns null when the listing names no receipts topic", () => {
    const { receipts: _none, ...noTopic } = listing;
    expect(resolveSigner([entry({ listing: noTopic as never })], "uaid:aid:abc")).toBeNull();
  });

  it("takes the newest listing when an identity was listed twice", () => {
    // An identity that re-lists has moved. The fold takes the highest sequence number
    // rather than the first seen, because the mirror returns messages newest-first.
    const older = { ...listing, receipts: "0.0.111" };
    const entries = [
      entry({ listing: older as never, sequenceNumber: 1 }),
      entry({ sequenceNumber: 9 }),
    ];

    expect(resolveSigner(entries, "uaid:aid:abc")?.topic).toBe("0.0.777");
    expect(resolveSigner(entries.reverse(), "uaid:aid:abc")?.topic).toBe("0.0.777");
  });
});
