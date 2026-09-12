import { lookup } from "node:dns/promises";
import { asLiteralAddress, blockedReason } from "./addresses.js";
import { isAllowed, parseRobots, rulesForStatus, type RobotsRules } from "./robots.js";

/**
 * May we fetch this, for money, on a stranger's instruction?
 *
 * This replaces a hand-maintained allowlist of three hosts. The allowlist was defensible
 * and did not scale: every new source meant a person reading a robots.txt, editing code
 * and redeploying, which is not a product. robots.txt is machine-readable, so a machine
 * can read it.
 *
 * ── The default flipped, and one thing did not ──────────────────────────────────
 * What changed is the *robots* decision: from "nothing unless a human approved it" to
 * "anything the site permits". What did not change is the *address* decision, which is
 * now stricter rather than looser — before, the allowlist happened to prevent private
 * addresses as a side effect of being three public hostnames. That protection is now
 * explicit and tested in its own right, because it is the one that stops this endpoint
 * being a paid tool for reading private networks.
 *
 * ── Two checks, at two times ────────────────────────────────────────────────────
 * `checkShape` is synchronous and runs while the parameters are validated: it needs no
 * network, so a nonsense URL is refused before anyone is quoted.
 *
 * `checkLive` resolves DNS and reads robots.txt, and runs before the browser navigates.
 * It is also run again on the URL the browser actually landed on, because a redirect is
 * the obvious way to get past a check performed only on the URL that was submitted.
 */

/** Hosts we refuse regardless of what their robots.txt says. Empty, and here to be used. */
export const DENYLIST: Array<{ host: string; why: string }> = [
  // Populated as needed: a site that complains, a host that is abused, a domain whose
  // terms forbid automation even though its robots.txt permits crawling. The point of a
  // denylist is that it starts empty and stays short.
];

/** How we identify ourselves, to robots.txt and in the request. */
export const USER_AGENT =
  "LedgerOfWork/0.1 (+https://github.com/SCARPxVeNOM/ledger-of-work; x402 paid capture)";

export type SourceVerdict = { ok: true; url: URL } | { ok: false; error: string };

/**
 * The checks that need no network.
 *
 * Deliberately includes the literal-address case: `https://127.0.0.1/` needs no DNS to be
 * obviously wrong, and refusing it here means it never reaches a quote.
 */
export function checkShape(raw: string): SourceVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "`url` is not a valid absolute URL" };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "`url` must use https — a captured claim from a tamperable transport proves nothing",
    };
  }

  if (url.username || url.password) {
    // Credentials in a URL are both a smell and a way to confuse a host check.
    return { ok: false, error: "`url` must not carry credentials" };
  }

  const denied = DENYLIST.find((d) => d.host === url.hostname);
  if (denied) return { ok: false, error: `${url.hostname} is not available: ${denied.why}` };

  const literal = asLiteralAddress(url.hostname);
  if (literal) {
    const why = blockedReason(literal);
    if (why) return { ok: false, error: `${literal} is a ${why} and cannot be captured` };
  }

  return { ok: true, url };
}

/** Cached robots.txt decisions, so a site is asked once rather than once per job. */
const robotsCache = new Map<string, { rules: RobotsRules | null; refuse?: string; at: number }>();
const ROBOTS_TTL_MS = 60 * 60_000;

export interface LiveOptions {
  /** Injected so the tests never touch DNS or the network. */
  resolve?: (hostname: string) => Promise<string[]>;
  fetchRobots?: (origin: string) => Promise<{ status: number; body: string }>;
  now?: () => number;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((f) => f.address);
}

async function defaultFetchRobots(origin: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}/robots.txt`, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: res.status < 300 ? await res.text() : "" };
}

/**
 * The checks that need the network: where the name points, and what the site permits.
 *
 * Address resolution comes first and is applied to *every* address a name resolves to.
 * A name with one public and one private address is refused: allowing it would let an
 * attacker publish both and rely on whichever the resolver happens to pick.
 */
export async function checkLive(url: URL, opts: LiveOptions = {}): Promise<SourceVerdict> {
  const shape = checkShape(url.toString());
  if (!shape.ok) return shape;

  const resolve = opts.resolve ?? defaultResolve;
  const now = opts.now ?? Date.now;

  if (!asLiteralAddress(url.hostname)) {
    let addresses: string[];
    try {
      addresses = await resolve(url.hostname);
    } catch {
      return { ok: false, error: `${url.hostname} does not resolve` };
    }
    if (addresses.length === 0) return { ok: false, error: `${url.hostname} does not resolve` };

    for (const address of addresses) {
      const why = blockedReason(address);
      if (why) {
        return {
          ok: false,
          error: `${url.hostname} resolves to ${address}, a ${why} — refusing`,
        };
      }
    }
  }

  const origin = url.origin;
  let entry = robotsCache.get(origin);
  if (!entry || now() - entry.at > ROBOTS_TTL_MS) {
    const fetchRobots = opts.fetchRobots ?? defaultFetchRobots;
    try {
      const { status, body } = await fetchRobots(origin);
      const decision = rulesForStatus(status);
      entry =
        "refuse" in decision
          ? { rules: null, refuse: decision.refuse, at: now() }
          : { rules: parseRobots(body, USER_AGENT), at: now() };
    } catch {
      // Unreachable is not consent. A site we cannot ask is a site we do not read.
      entry = { rules: null, refuse: "could not read robots.txt", at: now() };
    }
    robotsCache.set(origin, entry);
  }

  if (entry.refuse || !entry.rules) {
    return { ok: false, error: `${url.hostname}: ${entry.refuse ?? "no robots.txt decision"}` };
  }

  const verdict = isAllowed(entry.rules, `${url.pathname}${url.search}`);
  if (!verdict.allowed) {
    return { ok: false, error: `${url.hostname} disallows ${url.pathname} in robots.txt (${verdict.rule})` };
  }

  return { ok: true, url };
}

/** Forget cached robots decisions. For tests, and for an operator who needs a re-read. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}
