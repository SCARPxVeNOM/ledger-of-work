import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentId, agentUaid, buildAgentCard } from "../src/index.js";
import { base58Decode, base58Encode } from "../src/base58.js";
import { agentIdFromDigest, canonicalIdentity, formatUaid, parseUaid } from "../src/hcs14.js";

describe("base58", () => {
  /**
   * Vectors from the Bitcoin base58 test suite. Written out rather than round-tripped,
   * because a symmetric encoder/decoder pair agrees with itself perfectly while both
   * halves use the wrong alphabet.
   */
  const VECTORS: Array<[string, string]> = [
    ["", ""],
    ["61", "2g"],
    ["626262", "a3gV"],
    ["636363", "aPEr"],
    ["73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"],
    ["00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"],
  ];

  for (const [hex, expected] of VECTORS) {
    it(`encodes ${hex || "(empty)"}`, () => {
      expect(base58Encode(Uint8Array.from(Buffer.from(hex, "hex")))).toBe(expected);
    });
  }

  it("keeps leading zero bytes, which the arithmetic alone would lose", () => {
    // Each leading zero byte is one leading '1'. Treating the input as a single number
    // discards them, and the result looks entirely plausible.
    expect(base58Encode(Uint8Array.from([0, 0, 0, 1]))).toBe("1112");
    expect([...base58Decode("1112")]).toEqual([0, 0, 0, 1]);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(64).map((_, i) => (i * 37 + 11) % 256);
    expect([...base58Decode(base58Encode(bytes))]).toEqual([...bytes]);
  });

  it("refuses characters outside the alphabet", () => {
    // 0, O, I and l are excluded precisely because they are confusable.
    for (const bad of ["0", "O", "I", "l"]) {
      expect(() => base58Decode(`abc${bad}`), `${bad} was accepted`).toThrow(/base58/);
    }
  });
});

describe("HCS-14 canonical form", () => {
  const BASE = {
    registry: "hol",
    name: "Support Agent",
    version: "1.0.0",
    protocol: "hcs-10",
    nativeId: "hedera:testnet:0.0.123456",
    skills: [0, 17],
  };

  it("matches the shape the standard specifies", () => {
    // Keys alphabetical, and exactly six of them.
    expect(canonicalIdentity(BASE)).toBe(
      '{"name":"Support Agent","nativeId":"hedera:testnet:0.0.123456","protocol":"hcs-10","registry":"hol","skills":[0,17],"version":"1.0.0"}',
    );
  });

  it("is unchanged by skill order", () => {
    expect(agentId({ ...BASE, skills: [17, 0] })).toBe(agentId(BASE));
  });

  it("is unchanged by registry or protocol casing, or by surrounding whitespace", () => {
    expect(agentId({ ...BASE, registry: "HOL", protocol: "HCS-10" })).toBe(agentId(BASE));
    expect(agentId({ ...BASE, name: "  Support Agent  " })).toBe(agentId(BASE));
  });

  it("changes when any of the six fields changes", () => {
    const id = agentId(BASE);
    expect(agentId({ ...BASE, name: "Support Agent 2" })).not.toBe(id);
    expect(agentId({ ...BASE, version: "1.0.1" })).not.toBe(id);
    expect(agentId({ ...BASE, nativeId: "hedera:testnet:0.0.999" })).not.toBe(id);
    expect(agentId({ ...BASE, skills: [0] })).not.toBe(id);
  });

  it("is a base58 SHA-384, which is what makes it reproducible without a registry", () => {
    // Recomputed the long way. The point of HCS-14 is that two parties who have never
    // spoken derive the same id, so this asserts the algorithm rather than our output.
    const expected = base58Encode(
      new Uint8Array(createHash("sha384").update(canonicalIdentity(BASE), "utf8").digest()),
    );
    expect(agentId(BASE)).toBe(expected);
    expect(Buffer.from(base58Decode(agentId(BASE)))).toHaveLength(48);
  });

  it("refuses a digest that is not SHA-384", () => {
    // A SHA-256 digest base58-encodes to something indistinguishable from a real id at a
    // glance, so the length check is the only thing standing between a typo and an
    // identifier nobody else will ever compute.
    const sha256 = new Uint8Array(createHash("sha256").update("x").digest());
    expect(() => agentIdFromDigest(sha256)).toThrow(/48-byte/);
    expect(() => agentIdFromDigest(new Uint8Array(48))).not.toThrow();
  });
});

describe("the uaid string", () => {
  const BASE = {
    registry: "ledger-of-work",
    name: "Ledger of Work",
    version: "0.1.0",
    protocol: "a2a",
    nativeId: "hedera:testnet:0.0.10410493",
    skills: [0, 17],
  };

  it("puts parameters in the order the standard fixes", () => {
    // Compared verbatim by anyone resolving it, so a different order is a different id.
    const uaid = agentUaid(BASE);
    expect(uaid.startsWith("uaid:aid:")).toBe(true);
    const tail = uaid.slice(uaid.indexOf(";") + 1);
    expect(tail.split(";").map((p) => p.split("=")[0])).toEqual([
      "uid",
      "registry",
      "proto",
      "nativeId",
    ]);
  });

  it("round-trips through the parser", () => {
    const parsed = parseUaid(agentUaid(BASE));
    expect(parsed?.method).toBe("aid");
    expect(parsed?.params.registry).toBe("ledger-of-work");
    expect(parsed?.params.nativeId).toBe("hedera:testnet:0.0.10410493");
    expect(parsed?.params.uid).toBe("0");
  });

  it("returns null rather than guessing at something that is not a uaid", () => {
    for (const bad of ["", "did:web:example.com", "uaid", "0.0.123"]) {
      expect(parseUaid(bad), bad).toBeNull();
    }
  });

  it("omits parameters it has no value for", () => {
    expect(formatUaid("abc")).toBe("uaid:aid:abc;uid=0");
  });
});

describe("the A2A agent card", () => {
  const card = buildAgentCard({
    baseUrl: "https://seller.example",
    uaid: "uaid:aid:abc;uid=0",
    account: "0.0.10410493",
    receiptsTopic: "0.0.10413059",
    network: "hedera:testnet",
    version: "0.1.0",
    capabilities: [
      {
        name: "oracle.capture_claim",
        description: "Capture what a source document says.",
        site: "https://www.whitehouse.gov",
        fromTinybar: "321000",
      },
    ],
  });

  it("names the agent by its uaid, not by its URL", () => {
    // The URL is where it lives; the uaid is what it is. An agent that meets this
    // service twice over different transports has to be able to tell.
    expect(card.id).toBe("uaid:aid:abc;uid=0");
  });

  it("turns each capability into a skill with a price", () => {
    const skills = card.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("oracle.capture_claim");
    expect(skills[0]?.pricing).toEqual({
      from: "321000",
      unit: "tinybar",
      model: "metered-by-work",
    });
    expect(skills[0]?.tags).toContain("www.whitehouse.gov");
  });

  it("points at both the negotiation endpoint and the way to pay", () => {
    // This test used to assert the opposite — that no jsonrpc interface was advertised,
    // because none was served. Now one is, and the card must say so or an agent with a
    // budget has no way to find it. The x402 interface stays: negotiating settles the
    // terms, x402 settles the money.
    const interfaces = card.interfaces as Array<Record<string, string>>;
    const types = interfaces.map((i) => i.type);

    expect(types).toContain("x402");
    expect(types).toContain("jsonrpc");
    expect(interfaces.find((i) => i.type === "jsonrpc")?.url).toMatch(/\/a2a$/);
    expect(Object.keys(card.securitySchemes as object)).toEqual(["x402"]);
  });

  it("says what is negotiable, and that the rate is not", () => {
    // An agent comparing sellers should not have to open a conversation to learn that
    // haggling is off the table here — the price is checked against a published book.
    const n = card["x-negotiation"] as Record<string, unknown>;

    expect(n.negotiable).toContain("scope");
    expect(n.fixed).toContain("rate");
    expect(n.method).toBe("message/send");
  });

  it("carries enough Hedera detail to check a receipt before trusting an answer", () => {
    const hedera = card["x-hedera"] as Record<string, string>;
    expect(hedera.receiptsTopic).toBe("0.0.10413059");
    expect(hedera.account).toBe("0.0.10410493");
  });
});
