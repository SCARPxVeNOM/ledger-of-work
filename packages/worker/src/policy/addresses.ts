import { isIP } from "node:net";

/**
 * Which addresses a paid capture is never allowed to reach.
 *
 * ── Why this file is the serious one ────────────────────────────────────────────
 * `oracle.capture_claim` takes a URL from whoever paid, opens a real browser on it from
 * inside our network, and returns the contents with a signed receipt attesting to them.
 * Without this check, that is a rented tool for reading private networks: a buyer sends
 * `https://169.254.169.254/latest/meta-data/iam/security-credentials/` and gets our cloud
 * credentials back, notarised. Two tenths of a cent for a server-side request forgery,
 * with a receipt.
 *
 * The static allowlist used to prevent this as a side effect of being short. Replacing it
 * with a robots.txt policy means the address check has to stand on its own, and be the
 * thing that is actually load-bearing rather than a consequence of something else.
 *
 * Everything here is pure and synchronous. Resolution happens in `source.ts`; this file
 * only answers "is this address one we may talk to", which is the part worth testing
 * exhaustively.
 */

/** IPv4 ranges that must never be fetched, as [first, last] inclusive, and why. */
const V4_BLOCKED: Array<[string, string, string]> = [
  ["0.0.0.0", "0.255.255.255", "this host, this network"],
  ["10.0.0.0", "10.255.255.255", "private"],
  ["100.64.0.0", "100.127.255.255", "carrier-grade NAT"],
  ["127.0.0.0", "127.255.255.255", "loopback"],
  // The one that matters most on a cloud host: AWS, GCP and Azure all serve instance
  // credentials from 169.254.169.254, which is inside link-local.
  ["169.254.0.0", "169.254.255.255", "link-local, including cloud metadata"],
  ["172.16.0.0", "172.31.255.255", "private"],
  ["192.0.0.0", "192.0.0.255", "IETF protocol assignments"],
  ["192.0.2.0", "192.0.2.255", "documentation"],
  ["192.168.0.0", "192.168.255.255", "private"],
  ["198.18.0.0", "198.19.255.255", "benchmarking"],
  ["198.51.100.0", "198.51.100.255", "documentation"],
  ["203.0.113.0", "203.0.113.255", "documentation"],
  ["224.0.0.0", "239.255.255.255", "multicast"],
  ["240.0.0.0", "255.255.255.255", "reserved, and broadcast"],
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Reject `010` and `1e2` and empty octets: a permissive parser here is a bypass,
    // because `0177.0.0.1` is loopback to the OS and "not a number" to a naive check.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null if it is not one. */
function v6Groups(ip: string): number[] | null {
  let text = ip;
  // A zone index (`fe80::1%eth0`) is not part of the address for our purposes.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // An IPv4 tail, as in `::ffff:127.0.0.1`, becomes two groups.
  const tail = text.lastIndexOf(":");
  const maybeV4 = text.slice(tail + 1);
  if (maybeV4.includes(".")) {
    const n = v4ToInt(maybeV4);
    if (n === null) return null;
    text = `${text.slice(0, tail + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) =>
    s === "" ? [] : s.split(":").map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));

  const head = parse(halves[0] ?? "");
  const tailGroups = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...tailGroups].some(Number.isNaN)) return null;

  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill(0), ...tailGroups];
  }
  return head.length === 8 ? head : null;
}

/** An address we refuse, and the reason, or null when it is fine to fetch. */
export function blockedReason(address: string): string | null {
  const family = isIP(address);

  if (family === 4) {
    const n = v4ToInt(address);
    if (n === null) return "not a usable IPv4 address";
    for (const [first, last, why] of V4_BLOCKED) {
      const lo = v4ToInt(first)!;
      const hi = v4ToInt(last)!;
      if (n >= lo && n <= hi) return `${why} address range`;
    }
    return null;
  }

  if (family === 6) {
    const g = v6Groups(address);
    if (!g) return "not a usable IPv6 address";

    if (g.every((x) => x === 0)) return "unspecified address";
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";

    // IPv4 inside IPv6. `::ffff:127.0.0.1` reaches loopback on every OS, so the embedded
    // address has to be judged by the IPv4 rules rather than waved through as "some v6".
    const embedded = embeddedV4(g);
    if (embedded) {
      const why = blockedReason(embedded);
      return why ? `${why} (reached through IPv6)` : null;
    }

    if ((g[0]! & 0xfe00) === 0xfc00) return "unique local address";
    if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
    if ((g[0]! & 0xff00) === 0xff00) return "multicast";
    return null;
  }

  return "not an IP address";
}

/** The IPv4 address inside a mapped, translated or 6to4 IPv6 address, if there is one. */
function embeddedV4(g: number[]): string | null {
  const asV4 = (hi: number, lo: number) =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // ::ffff:a.b.c.d — IPv4-mapped
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return asV4(g[6]!, g[7]!);
  // ::a.b.c.d — deprecated IPv4-compatible, still routed by some stacks
  if (g.slice(0, 6).every((x) => x === 0) && (g[6]! !== 0 || g[7]! > 1)) return asV4(g[6]!, g[7]!);
  // 64:ff9b::a.b.c.d — NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return asV4(g[6]!, g[7]!);
  // 2002:a.b.c.d:: — 6to4
  if (g[0] === 0x2002) return asV4(g[1]!, g[2]!);
  return null;
}

/**
 * Is this hostname a literal address rather than a name?
 *
 * Worth answering separately because a literal needs no DNS lookup, and because
 * `http://[::1]/` arrives with brackets that `isIP` will not accept.
 */
export function asLiteralAddress(hostname: string): string | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) ? bare : null;
}
