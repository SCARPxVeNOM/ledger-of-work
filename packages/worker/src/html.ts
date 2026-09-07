/** Shared HTML helpers. Pure — no browser, no DOM. */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ldquo: '"',
  rdquo: '"',
  lsquo: "'",
  rsquo: "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

/**
 * Decode HTML text to plain text: strip tags, then resolve entities in a **single pass**.
 *
 * Single pass matters. Chained `.replace()` calls decode their own output, so
 * `&amp;lt;` becomes `&lt;` and then `<` — turning escaped markup back into markup. One
 * regex over the source string cannot do that.
 *
 * Smart quotes are normalised to ASCII so a buyer diffing our output against the page
 * does not trip over typography, and so hashes stay stable if the site changes its
 * curly-quote rendering.
 */
export function decodeHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return safeCodePoint(Number.parseInt(body.slice(2), 16), whole);
      }
      if (body.startsWith("#")) {
        return safeCodePoint(Number.parseInt(body.slice(1), 10), whole);
      }
      return NAMED[body.toLowerCase()] ?? whole;
    })
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Both toscrape sites mark pagination the same way. */
export function hasNextPage(html: string): boolean {
  return /<li class="next">/.test(html);
}
