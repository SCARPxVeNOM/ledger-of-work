import type { Page } from "playwright";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";

/**
 * Capture a claim from a named source document.
 *
 * ── Why this capability exists ──────────────────────────────────────────────────
 * Every other capability here sells data from a site we chose. This one sells the thing
 * a buyer actually has a budget for: settling a dispute about what a source said.
 *
 * The buyer is a prediction market, or an oracle resolving one. When such a market
 * resolves, someone posts a link and a screenshot, and everyone else is asked to trust
 * it. Polymarket's 2025 oracle dispute — roughly $7M turning on which document was
 * authoritative — ended with a post-mortem asking for a cryptographically verified
 * source document rather than a screenshot. That is exactly the artifact this produces:
 * the extracted value, the rendered page, a screenshot, and a receipt on a public ledger
 * committing to the hash of all three, published before the outcome was contested.
 *
 * ── Why it takes the source as a parameter ──────────────────────────────────────
 * A market names its own resolution source; we do not get to pick it. So unlike the
 * other adapters, the URL, the wait, and the extraction rule are all buyer-supplied.
 *
 * ── Why there is nevertheless an allowlist ──────────────────────────────────────
 * A paid endpoint that will point a real browser at any URL a stranger names is an open
 * proxy, and worse: it will happily fetch a cloud metadata endpoint or an intranet host
 * that only our server can reach. Blocking private addresses by pattern does not fix
 * that, because a hostname can resolve to a private address after the check passes.
 * Until the browser runs somewhere that cannot reach anything private, the honest control
 * is an allowlist of sources whose robots.txt has actually been read. It is published in
 * the spec so a buyer knows before paying, and it is the one thing standing between this
 * capability and being abused.
 */

/** Politeness pause after an interaction, so a capture costs the source about what a reader does. */
const CLICK_DELAY_MS = 400;

/** Longest value we will return per match. Guards the receipt and the result file alike. */
const MAX_VALUE_CHARS = 400;

/**
 * How much of the captured value the attestor is asked to confirm.
 *
 * Long enough that a match is distinctive rather than incidental — `"start"` would be
 * true of half the web — and short enough that revealing it stays cheap.
 */
const PROOF_MATCH_CHARS = 48;

interface AllowedSource {
  host: string;
  /** Path prefixes the site's robots.txt disallows. Checked before we navigate. */
  disallowed: string[];
  /** What it is, and why a market might name it. Published in the manifest. */
  note: string;
}

/**
 * Sources whose robots.txt was read by hand, on the dates recorded here.
 *
 * Adding a host to this list is a deliberate act that requires reading its rules first.
 * That is the point: it cannot grow by accident.
 */
export const ALLOWED_SOURCES: AllowedSource[] = [
  {
    host: "www.whitehouse.gov",
    // robots.txt read 2026-09-10: `User-agent: *` followed by a bare `Disallow:`, which
    // permits everything.
    disallowed: [],
    note: "Presidential Actions — executive orders and proclamations, a primary source markets resolve on.",
  },
  {
    host: "www.federalregister.gov",
    // robots.txt read 2026-09-10. Its search paths are disallowed; document pages are not.
    disallowed: [
      "/documents/current",
      "/documents/email-a-friend",
      "/articles/search",
      "/documents/search",
      "/public-inspection/search",
      "/regulations/search",
      "/my/",
      "/auth/",
    ],
    note: "The official daily journal — the authoritative text of a rule, once published.",
  },
  {
    host: "www.govinfo.gov",
    // Same rules the govinfo adapter already honours.
    disallowed: ["/search/", "/index.php/search/"],
    note: "GPO's archive of official federal documents.",
  },
];

export interface OracleParams {
  /** The source document to capture. Must be an allowed host over https. */
  url: string;
  /** CSS selector to wait for before capturing. Null means wait for the load event only. */
  waitFor: string | null;
  /** Optional control to click first — a consent banner, a "show more", a tab. */
  click: string | null;
  /** CSS selector for the value(s) to extract. */
  select: string;
  /** Attribute to read instead of the visible text, e.g. "datetime" or "href". */
  attribute: string | null;
  /** How many matches to return. */
  max: number;
}

export interface CapturedClaim {
  /** Position in document order, so a buyer can say "the first one" unambiguously. */
  rank: number;
  value: string;
}

/**
 * Pure. Decides whether a URL may be captured, and says why not when it may not.
 *
 * Separated from the adapter and exported because this is the security boundary, and a
 * security boundary that can only be exercised by starting a browser will not be tested
 * against the cases that matter.
 */
export function checkSource(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "`url` is not a valid absolute URL" };
  }

  if (url.protocol !== "https:") {
    return { error: "`url` must use https — a captured claim from a tamperable transport proves nothing" };
  }

  const source = ALLOWED_SOURCES.find((s) => s.host === url.hostname);
  if (!source) {
    return {
      error:
        `${url.hostname} is not an allowed source. Allowed: ` +
        `${ALLOWED_SOURCES.map((s) => s.host).join(", ")}. ` +
        "Sources are added only after their robots.txt has been read.",
    };
  }

  const path = url.pathname;
  const blocked = source.disallowed.find((prefix) => path.startsWith(prefix));
  if (blocked) {
    return { error: `${url.hostname} disallows ${blocked} in robots.txt` };
  }

  return { url };
}

/**
 * Pure. Cleans and truncates extracted values, and drops empty ones.
 *
 * A selector that matches decorative markup yields runs of whitespace; returning those as
 * "the claim" would be worse than returning nothing, because the receipt would commit to
 * them just as faithfully.
 */
export function tidyValues(raw: string[], max: number): CapturedClaim[] {
  const out: CapturedClaim[] = [];
  for (const value of raw) {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ rank: out.length + 1, value: text.slice(0, MAX_VALUE_CHARS) });
    if (out.length >= max) break;
  }
  return out;
}

export const oracleAdapter: SiteAdapter<OracleParams, CapturedClaim> = {
  spec: {
    name: "oracle.capture_claim",
    // `site` is one URL by contract, and the manifest's consumers parse it as one. This
    // capability spans several, so it names the primary source and the description
    // carries the full allowed set.
    site: `https://${(ALLOWED_SOURCES[0] as AllowedSource).host}`,
    description:
      "Capture what a named source document says, with tamper-evident evidence: the extracted value, " +
      "the rendered page, a screenshot, and a receipt on Hedera committing to the hash of each. " +
      "Built for resolving a claim about a primary source — the buyer supplies the URL, an optional " +
      "interaction, and a CSS extraction rule. Allowed sources: " +
      `${ALLOWED_SOURCES.map((s) => `${s.host} (${s.note})`).join("; ")}.`,
    priceBook: {
      base: "60000",
      perStep: "45000",
      perPage: "90000",
      perSecond: "9000",
      ceiling: "6000000",
    },
    // Shallow by construction: open, optionally click, read. A capture that needs more
    // than that is a flow, and belongs in an adapter of its own.
    limits: { maxSteps: 8, maxPages: 2, maxSessionMs: 120_000 },
  },

  normalise(params: unknown): OracleParams {
    const p = (params ?? {}) as Record<string, unknown>;

    if (typeof p.url !== "string" || !p.url) {
      throw new BadParamsError("`url` is required — the source document to capture");
    }
    const checked = checkSource(p.url);
    if ("error" in checked) throw new BadParamsError(checked.error);

    if (typeof p.select !== "string" || !p.select.trim()) {
      throw new BadParamsError("`select` is required — a CSS selector for the value to capture");
    }

    const optionalSelector = (key: "waitFor" | "click"): string | null => {
      const v = p[key];
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string") throw new BadParamsError(`\`${key}\` must be a CSS selector string`);
      return v;
    };

    const attribute =
      p.attribute === undefined || p.attribute === null || p.attribute === ""
        ? null
        : String(p.attribute);
    // Attribute names are put straight into a DOM call, so keep them to the shape a real
    // attribute has rather than trusting the buyer's string.
    if (attribute !== null && !/^[a-zA-Z][\w:.-]*$/.test(attribute)) {
      throw new BadParamsError("`attribute` must be an attribute name, e.g. \"href\" or \"datetime\"");
    }

    const max = p.max === undefined ? 1 : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 50) {
      throw new BadParamsError("`max` must be an integer between 1 and 50");
    }

    return {
      url: checked.url.toString(),
      waitFor: optionalSelector("waitFor"),
      click: optionalSelector("click"),
      select: p.select.trim(),
      attribute,
      max,
    };
  },

  /**
   * Pure. The work is a fixed shape, so the quote varies only by whether an interaction
   * was asked for — which is the honest amount of variation a single capture contains.
   */
  plan(params: OracleParams): Plan {
    const steps = params.click ? 3 : 2;
    return {
      steps,
      pages: 1,
      estimatedMs: params.click ? 12_000 : 9_000,
      outline: [
        `open ${new URL(params.url).hostname}`,
        ...(params.click ? [`click ${params.click}`] : []),
        ...(params.waitFor ? [`wait for ${params.waitFor}`] : []),
        `capture ${params.max === 1 ? "the value" : `up to ${params.max} values`} at ${params.select}`,
        "hash the rendered page and a screenshot into the receipt",
      ],
    };
  },

  /**
   * Pure over the extracted values, joined by blank lines.
   *
   * Not over raw HTML: extraction here is a buyer-supplied CSS selector, which needs a
   * live DOM to evaluate. `govinfo` splits the same way for the same reason. What is
   * genuinely worth testing without a browser is `checkSource` and `tidyValues`, and both
   * are exported for that.
   */
  parse(valuesBlock: string): CapturedClaim[] {
    return tidyValues(valuesBlock.split("\n\n"), Number.MAX_SAFE_INTEGER);
  },

  /**
   * This capability is the one worth proving, and the one that is cheap to prove.
   *
   * A capture is a single GET of a public document — no credentials to hide, so the
   * whole TLS transcript can be revealed and no ZK proving is needed. Measured at 2.1s
   * for a 263KB page, against 28s for a 40KB response behind a bearer token where eight
   * ZK proofs were required to keep the token secret.
   *
   * Only the first value is witnessed. Each extra one costs another revealed slice, and
   * a dispute turns on a specific claim rather than on a list.
   */
  provable(
    _params: OracleParams,
    items: CapturedClaim[],
    context: { finalUrl: string; html: string },
  ): { url: string; mustContain: string } | null {
    const first = items[0]?.value;
    if (!first) return null;

    // The attestor matches against the raw response body, while `value` was read from
    // the rendered DOM. On a client-rendered page the two differ and the attestor would
    // refuse; say so by returning null rather than making it find out the slow way.
    const needle = first.slice(0, PROOF_MATCH_CHARS);
    if (!context.html.includes(needle)) return null;

    return { url: context.finalUrl, mustContain: needle };
  },

  async run(ctx: JobContext<Page>, params: OracleParams): Promise<CapturedClaim[]> {
    const { page, meter } = ctx;
    const host = new URL(params.url).hostname;

    await meter.step(`open ${host}`, async () => {
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    });
    meter.countPage(params.url);
    ctx.assertWithinLimits();

    if (params.click) {
      await meter.step(`click ${params.click}`, async () => {
        // A control the buyer named may legitimately not be there — a consent banner that
        // did not appear this time. That is not a failed capture.
        const target = await page.$(params.click as string);
        if (target && (await target.isVisible())) {
          await target.click();
          await page.waitForTimeout(CLICK_DELAY_MS);
        }
      });
      ctx.assertWithinLimits();
    }

    await meter.step(`capture ${params.select}`, async () => {
      if (params.waitFor) {
        await page.waitForSelector(params.waitFor, { timeout: 40_000 });
      }
      // Wait for the selector we are about to read, so a slow render does not get
      // recorded as "the source does not say that".
      await page.waitForSelector(params.select, { timeout: 40_000 }).catch(() => {
        /* zero matches is a real answer; the empty result and the screenshot say so */
      });
    });

    const raw = await page.$$eval(
      params.select,
      (nodes, attribute) =>
        nodes.map((n) =>
          attribute
            ? ((n as Element).getAttribute(attribute as string) ?? "")
            : ((n as HTMLElement).innerText ?? n.textContent ?? ""),
        ),
      params.attribute,
    );

    return tidyValues(raw, params.max);
  },
};
