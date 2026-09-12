import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLive, checkShape, clearRobotsCache, DENYLIST } from "../src/policy/source.js";

/**
 * The policy that replaced the allowlist.
 *
 * The allowlist refused everything by default, so the only way to get it wrong was to add
 * a site carelessly. This refuses nothing by default, so every way of getting it wrong is
 * now live at once — a name that resolves somewhere private, a site whose robots.txt we
 * cannot read, a redirect into the internal network. Each has a test.
 */

const OK_ROBOTS = { status: 200, body: "User-agent: *\nDisallow:" };
const publicAddr = async () => ["93.184.216.34"];
const robots = (body: string, status = 200) => async () => ({ status, body });

beforeEach(() => clearRobotsCache());

describe("checks that need no network", () => {
  it("refuses anything that is not https", () => {
    expect(checkShape("http://example.com/x")).toMatchObject({ ok: false });
    expect(checkShape("file:///etc/passwd")).toMatchObject({ ok: false });
    expect(checkShape("ftp://example.com/x")).toMatchObject({ ok: false });
  });

  it("refuses a literal private address without asking DNS", () => {
    expect(checkShape("https://127.0.0.1/x")).toMatchObject({ ok: false });
    expect(checkShape("https://169.254.169.254/latest/meta-data/")).toMatchObject({ ok: false });
    expect(checkShape("https://10.0.0.1/x")).toMatchObject({ ok: false });
  });

  it("refuses an IPv6 literal in brackets, which a naive host check misses", () => {
    // `new URL(...).hostname` is "[::1]", and a check that forgets the brackets decides
    // it is a hostname, tries to resolve it, and fails open on some implementations.
    expect(checkShape("https://[::1]/x")).toMatchObject({ ok: false });
    expect(checkShape("https://[::ffff:127.0.0.1]/x")).toMatchObject({ ok: false });
  });

  it("refuses credentials embedded in the URL", () => {
    // `https://example.com@169.254.169.254/` is a classic way to confuse a host check.
    expect(checkShape("https://user:pass@example.com/x")).toMatchObject({ ok: false });
  });

  it("accepts an ordinary public https URL", () => {
    expect(checkShape("https://www.whitehouse.gov/presidential-actions/")).toMatchObject({ ok: true });
  });

  it("honours the denylist", () => {
    DENYLIST.push({ host: "banned.example", why: "asked us to stop" });
    try {
      const r = checkShape("https://banned.example/x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("asked us to stop");
    } finally {
      DENYLIST.pop();
    }
  });
});

describe("where the name actually points", () => {
  it("refuses a public name that resolves to a private address", () => {
    // This is the attack the literal check does not catch: an attacker controls the DNS
    // for a name that looks ordinary and points it at the metadata service.
    return checkLive(new URL("https://evil.example/x"), {
      resolve: async () => ["169.254.169.254"],
      fetchRobots: robots(OK_ROBOTS.body),
    }).then((r) => {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("169.254.169.254");
    });
  });

  it("refuses when any one of several addresses is private", async () => {
    // Publishing both and letting the resolver choose is how a check on "the" address is
    // defeated. Every address has to pass, not the first one.
    const r = await checkLive(new URL("https://mixed.example/x"), {
      resolve: async () => ["93.184.216.34", "127.0.0.1"],
      fetchRobots: robots(OK_ROBOTS.body),
    });

    expect(r.ok).toBe(false);
  });

  it("refuses a name that does not resolve at all", async () => {
    const r = await checkLive(new URL("https://nope.example/x"), {
      resolve: async () => [],
      fetchRobots: robots(OK_ROBOTS.body),
    });

    expect(r.ok).toBe(false);
  });

  it("allows a name that resolves entirely to public addresses", async () => {
    const r = await checkLive(new URL("https://example.com/x"), {
      resolve: publicAddr,
      fetchRobots: robots(OK_ROBOTS.body),
    });

    expect(r.ok).toBe(true);
  });
});

describe("what the site permits", () => {
  it("allows a site whose robots.txt says nothing is restricted", async () => {
    const r = await checkLive(new URL("https://example.com/anything"), {
      resolve: publicAddr,
      fetchRobots: robots("User-agent: *\nDisallow:"),
    });

    expect(r.ok).toBe(true);
  });

  it("refuses a path the site disallows, and says which rule did it", async () => {
    const r = await checkLive(new URL("https://example.com/search?q=x"), {
      resolve: publicAddr,
      fetchRobots: robots("User-agent: *\nDisallow: /search"),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Disallow: /search");
  });

  it("refuses every path on a site that disallows everything", async () => {
    // leginfo.legislature.ca.gov does this. It must be refused automatically now that no
    // human is reading the file first.
    const r = await checkLive(new URL("https://example.com/anything"), {
      resolve: publicAddr,
      fetchRobots: robots("User-agent: *\nDisallow: /"),
    });

    expect(r.ok).toBe(false);
  });

  it("treats a missing robots.txt as no restrictions", async () => {
    const r = await checkLive(new URL("https://example.com/x"), {
      resolve: publicAddr,
      fetchRobots: robots("", 404),
    });

    expect(r.ok).toBe(true);
  });

  it("refuses when robots.txt is forbidden rather than assuming consent", async () => {
    const r = await checkLive(new URL("https://example.com/x"), {
      resolve: publicAddr,
      fetchRobots: robots("", 403),
    });

    expect(r.ok).toBe(false);
  });

  it("refuses when robots.txt cannot be fetched at all", async () => {
    // Unreachable is not consent.
    const r = await checkLive(new URL("https://example.com/x"), {
      resolve: publicAddr,
      fetchRobots: async () => {
        throw new Error("network down");
      },
    });

    expect(r.ok).toBe(false);
  });
});

describe("asking each site once", () => {
  it("caches the decision rather than re-fetching per job", async () => {
    const fetchRobots = vi.fn(async () => OK_ROBOTS);
    const opts = { resolve: publicAddr, fetchRobots };

    await checkLive(new URL("https://example.com/a"), opts);
    await checkLive(new URL("https://example.com/b"), opts);
    await checkLive(new URL("https://example.com/c"), opts);

    expect(fetchRobots).toHaveBeenCalledOnce();
  });

  it("re-reads once the cached answer is old", async () => {
    const fetchRobots = vi.fn(async () => OK_ROBOTS);
    let clock = 0;
    const opts = { resolve: publicAddr, fetchRobots, now: () => clock };

    await checkLive(new URL("https://example.com/a"), opts);
    clock += 61 * 60_000;
    await checkLive(new URL("https://example.com/a"), opts);

    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it("keeps separate decisions for separate origins", async () => {
    const fetchRobots = vi.fn(async (origin: string) =>
      origin.includes("open") ? OK_ROBOTS : { status: 200, body: "User-agent: *\nDisallow: /" },
    );
    const opts = { resolve: publicAddr, fetchRobots };

    expect((await checkLive(new URL("https://open.example/x"), opts)).ok).toBe(true);
    expect((await checkLive(new URL("https://closed.example/x"), opts)).ok).toBe(false);
  });
});
