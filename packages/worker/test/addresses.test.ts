import { describe, expect, it } from "vitest";
import { asLiteralAddress, blockedReason } from "../src/policy/addresses.js";

/**
 * The address guard.
 *
 * This is the check that stops a paid capture becoming a rented tool for reading private
 * networks. Every test below is a real bypass technique rather than an invented one, and
 * the cloud metadata cases are first because that is the address an attacker actually
 * wants: it returns credentials.
 */

const blocked = (ip: string) => expect(blockedReason(ip), ip).not.toBeNull();
const allowed = (ip: string) => expect(blockedReason(ip), ip).toBeNull();

describe("cloud metadata, which is the whole point", () => {
  it("refuses the metadata address every major cloud uses", () => {
    // AWS, GCP and Azure all serve instance credentials here.
    blocked("169.254.169.254");
  });

  it("refuses the rest of link-local with it", () => {
    blocked("169.254.0.1");
    blocked("169.254.255.255");
  });

  it("refuses it when dressed as IPv6", () => {
    blocked("::ffff:169.254.169.254");
  });
});

describe("private and local IPv4", () => {
  it("refuses loopback in all its spellings", () => {
    blocked("127.0.0.1");
    blocked("127.0.0.2"); // also loopback, and more often forgotten
    blocked("127.255.255.254");
  });

  it("refuses the RFC 1918 ranges", () => {
    blocked("10.0.0.1");
    blocked("172.16.0.1");
    blocked("172.31.255.255");
    blocked("192.168.1.1");
  });

  it("refuses carrier-grade NAT, multicast, reserved and broadcast", () => {
    blocked("100.64.0.1");
    blocked("224.0.0.1");
    blocked("240.0.0.1");
    blocked("255.255.255.255");
    blocked("0.0.0.0");
  });

  it("allows ordinary public addresses", () => {
    allowed("8.8.8.8");
    allowed("1.1.1.1");
    allowed("93.184.216.34");
    // Deliberately adjacent to blocked ranges, to catch an off-by-one in a boundary.
    allowed("172.32.0.1");
    allowed("11.0.0.1");
    allowed("169.253.255.255");
    allowed("100.63.255.255");
  });
});

describe("parser tricks that defeat a naive check", () => {
  it("refuses zero-padded octets rather than reading them as decimal", () => {
    // The OS reads 0177.0.0.1 as octal — loopback. A checker that parses it as 177 sees
    // a public address and waves it through. Refusing to parse it at all is the safe answer.
    blocked("0177.0.0.1");
    blocked("010.0.0.1");
  });

  it("refuses octets that are not plain integers", () => {
    blocked("1e2.0.0.1");
    blocked("127.0.0.0x1");
    blocked("127..0.1");
    blocked("127.0.0.256");
  });

  it("refuses things that are not addresses at all", () => {
    blocked("example.com");
    blocked("");
    blocked("...");
  });
});

describe("IPv6", () => {
  it("refuses loopback, unspecified, unique-local, link-local and multicast", () => {
    blocked("::1");
    blocked("::");
    blocked("fc00::1");
    blocked("fd12:3456::1");
    blocked("fe80::1");
    blocked("ff02::1");
  });

  it("allows public IPv6", () => {
    allowed("2001:4860:4860::8888");
    allowed("2606:4700:4700::1111");
  });

  it("refuses IPv4 loopback smuggled through a mapped address", () => {
    // ::ffff:127.0.0.1 reaches loopback on every OS. Judging it as "some IPv6 address"
    // is the bypass; it has to be judged by the IPv4 rules.
    blocked("::ffff:127.0.0.1");
    blocked("::ffff:10.0.0.1");
    blocked("::ffff:192.168.0.1");
  });

  it("still allows a mapped address that points somewhere public", () => {
    allowed("::ffff:8.8.8.8");
  });

  it("refuses private space reached through NAT64 and 6to4", () => {
    blocked("64:ff9b::127.0.0.1");
    blocked("2002:7f00:0001::"); // 6to4 wrapping 127.0.0.1
  });

  it("ignores a zone index rather than being confused by it", () => {
    blocked("fe80::1%eth0");
  });
});

describe("recognising a literal address", () => {
  it("sees a bare IPv4 or IPv6 literal", () => {
    expect(asLiteralAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(asLiteralAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  it("unwraps the brackets a URL puts around IPv6", () => {
    // `new URL("https://[::1]/")` gives a hostname of "[::1]", which `isIP` rejects — so
    // an unwrapped check would decide it is a hostname, resolve it, and find nothing.
    expect(asLiteralAddress("[::1]")).toBe("::1");
    expect(blockedReason(asLiteralAddress("[::1]")!)).not.toBeNull();
  });

  it("says a hostname is not a literal", () => {
    expect(asLiteralAddress("example.com")).toBeNull();
  });
});
