import type { Page } from "playwright";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";
import { checkLive, checkShape } from "../policy/source.js";

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
 * ── What stops this being an open proxy ─────────────────────────────────────────
 * A paid endpoint that points a real browser at any URL a stranger names will happily
 * fetch a cloud metadata endpoint or an intranet host only our server can reach, and hand
 * back the contents with a receipt attesting to them. This used to be prevented by an
 * allowlist of three hosts — safe, and not a product, since every new source meant a
 * person editing code.
 *
 * The control is now `policy/source.ts`, and it is two separate things:
 *
 *   - **Addresses.** Every address a hostname resolves to is checked against the private,
 *     loopback, link-local and reserved ranges, and the URL the browser actually lands on
 *     is checked again — a redirect being the obvious way past a check done once, up front.
 *   - **Permission.** The site's own robots.txt is fetched, parsed and obeyed per request.
 *
 * So the default flipped from "nothing unless a human approved it" to "anything the site
 * permits", while the protection that matters got stricter rather than looser.
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
  /** What it is, and why a market might name it. Published in the manifest. */
  note: string;
}

/**
 * Sources this capability was built against, kept as worked examples.
 *
 * These were the allowlist. They are no longer a gate — any public page whose robots.txt
 * permits it can be captured now, and the gate lives in `policy/source.ts`. They stay
 * because a capability that takes "any URL" tells a buying agent nothing about what it is
 * *for*, and these three say it: primary sources that disputes actually turn on.
 */
export const EXAMPLE_SOURCES: AllowedSource[] = [
  {
    host: "www.whitehouse.gov",
    note: "Presidential Actions — executive orders and proclamations, a primary source markets resolve on.",
  },
  {
    host: "www.federalregister.gov",
    note: "The official daily journal — the authoritative text of a rule, once published.",
  },
  {
    host: "www.govinfo.gov",
    note: "GPO's archive of official federal documents.",
  },
];

export interface OracleParams {
  /** The source document to capture. Any https page whose robots.txt permits it. */
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
    // `site` is one URL by contract and the manifest's consumers parse it as one, so it
    // names a representative source rather than pretending to name them all.
    site: `https://${(EXAMPLE_SOURCES[0] as AllowedSource).host}`,
    description:
      "Capture what a source document says, with tamper-evident evidence: the extracted value, " +
      "the rendered page, a screenshot, and a receipt on Hedera committing to the hash of each. " +
      "The buyer supplies the URL, an optional interaction, and a CSS extraction rule. " +
      "Any public https page may be captured if its robots.txt permits it — the site's own " +
      "rules are fetched and obeyed per request, and a refusal quotes the rule that caused it. " +
      "Built for resolving claims about primary sources, for example: " +
      `${EXAMPLE_SOURCES.map((s) => `${s.host} (${s.note})`).join("; ")}.`,
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
    // The cheap half of the policy: shape, scheme, denylist, literal private addresses.
    // The half that needs the network — where the name points and what robots.txt says —
    // runs in `run`, immediately before the browser is pointed at anything.
    const checked = checkShape(p.url);
    if (!checked.ok) throw new BadParamsError(checked.error);

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
  /**
   * Resolve the host and read the site's rules before quoting.
   *
   * The same check runs again in `run`, on the URL the browser actually lands on. This
   * one exists so a buyer is told "that site disallows this path" before they sign
   * anything, rather than after.
   */
  async precheck(params: OracleParams): Promise<void> {
    const verdict = await checkLive(new URL(params.url));
    if (!verdict.ok) throw new BadParamsError(verdict.error);
  },

  /**
   * A capture that matched nothing did not capture anything.
   *
   * Found the hard way: a bot-protected site served a challenge page, the browser loaded
   * it happily, the selector matched nothing, and the job settled at full price with a
   * receipt recording `status: "ok"` and zero items. The receipt was honest — it faithfully
   * attested that we had delivered nothing — and the buyer had paid 321,000 tinybar for it.
   *
   * The cause does not matter and cannot reliably be told apart anyway: a challenge page,
   * a redesign, a selector that was always wrong. What matters is that nothing was
   * delivered, so nothing is charged.
   */
  delivered(items: CapturedClaim[], params: OracleParams) {
    if (items.length > 0) return { ok: true as const };
    return {
      ok: false as const,
      why:
        `nothing on the page matched \`${params.select}\` — the source may have served a ` +
        `bot challenge or an error page, or the selector may not match its markup. ` +
        `Nothing was charged.`,
    };
  },

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

    // Resolve the name and read the site's robots.txt before the browser opens anything.
    // Not billed as a step: it is our own diligence, not work the buyer asked for.
    const permitted = await checkLive(new URL(params.url));
    if (!permitted.ok) throw new BadParamsError(permitted.error);

    await meter.step(`open ${host}`, async () => {
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    });

    // Check again on where we actually landed. A redirect is the obvious way past a check
    // performed only on the URL that was submitted: a public host that 302s to
    // 169.254.169.254 passes everything above and still ends up reading cloud credentials.
    const landed = page.url();
    if (landed !== params.url) {
      const after = await checkLive(new URL(landed));
      if (!after.ok) {
        throw new BadParamsError(`${params.url} redirected to ${landed}, which is refused: ${after.error}`);
      }
    }

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
