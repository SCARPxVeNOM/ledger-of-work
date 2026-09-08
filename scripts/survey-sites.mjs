/**
 * Survey candidate target sites for the two properties the pitch depends on.
 *
 * The claim "most of the web has no API" is easy to assert and hard to check, so this
 * checks it. For each site it reports:
 *
 *   fetchable  — does a plain GET of the data view return the data, or an app shell?
 *   crawlable  — does robots.txt permit the path the flow would need?
 *   apiless    — is there no obvious first-party API for the same data?
 *
 * A site has to be *not fetchable*, *crawlable*, and *apiless* to satisfy the whole
 * pitch on its own. The interesting result is how few are.
 *
 * Read-only, one request per check, and it identifies itself.
 */

import { execFileSync } from "node:child_process";

const UA = "LedgerOfWork-survey/0.1 (+https://github.com/SCARPxVeNOM/ledger-of-work)";

/**
 * Some hosts (api.govinfo.gov among them) refuse Node's fetch while answering curl
 * perfectly, which looks like a TLS or HTTP/2 negotiation difference in undici.
 *
 * This matters more than a transport detail: the first version of this survey recorded
 * that connection failure as "this site has no API", which is a false negative in the
 * evidence itself. A survey that cannot tell "checked and absent" from "could not check"
 * is worse than no survey.
 */
function curlGet(url) {
  try {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "--max-time",
        "20",
        "-H",
        `user-agent: ${UA}`,
        "-w",
        "\n__STATUS__%{http_code}__%{content_type}",
        url,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const marker = out.lastIndexOf("\n__STATUS__");
    if (marker < 0) return null;
    const [, status, type = ""] = out.slice(marker + 11).split("__");
    return { status: Number(status), type, body: out.slice(0, marker) };
  } catch {
    return null;
  }
}

/** `probe` is a URL whose response should contain data if the site is fetchable. */
const SITES = [
  {
    name: "quotes.toscrape.com",
    probe: "https://quotes.toscrape.com/tag/love/",
    expect: /quote/i,
    searchPath: "/tag/love/",
    apis: ["https://quotes.toscrape.com/api/quotes"],
  },
  {
    name: "books.toscrape.com",
    probe: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
    expect: /product_pod/i,
    searchPath: "/catalogue/",
    apis: ["https://books.toscrape.com/api/books"],
  },
  {
    name: "govinfo.gov",
    probe: "https://www.govinfo.gov/app/collection/FR",
    expect: /accordion-button/i,
    searchPath: "/app/collection/FR",
    apis: ["https://api.govinfo.gov/collections?api_key=DEMO_KEY"],
  },
  {
    name: "search.lib.virginia.edu",
    probe: "https://search.lib.virginia.edu/search?q=climate",
    expect: /climate/i,
    searchPath: "/search",
    apis: ["https://search.lib.virginia.edu/search.json?q=climate"],
  },
  {
    name: "congress.gov",
    probe: "https://www.congress.gov/search?q=climate",
    expect: /climate/i,
    searchPath: "/search",
    apis: ["https://api.congress.gov/v3/bill"],
  },
  {
    name: "leginfo.legislature.ca.gov",
    probe: "https://leginfo.legislature.ca.gov/faces/billSearchClient.xhtml",
    expect: /bill/i,
    searchPath: "/faces/billSearchClient.xhtml",
    apis: [],
  },
  {
    name: "www.gutenberg.org",
    probe: "https://www.gutenberg.org/ebooks/search/?query=climate",
    expect: /climate/i,
    searchPath: "/ebooks/search",
    apis: ["https://gutendex.com/books"],
  },
];

async function get(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: ac.signal });
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      body: await res.text(),
    };
  } catch (err) {
    return { status: 0, type: "", body: "", error: (err?.message ?? "failed").split("\n")[0] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this endpoint actually serve an API?
 *
 * A status code alone is wrong in both directions. A site that answers unknown paths
 * with a styled 200 HTML page would be recorded as having an API it does not have, and
 * an API that requires a key answers 401 or 403 with a JSON body while very much
 * existing. So the test is whether the body parses as JSON and carries anything.
 */
function looksLikeApi(res) {
  if (!res.body) return false;
  const jsonish = res.type.includes("json") || /^\s*[[{]/.test(res.body);
  if (!jsonish) return false;
  try {
    const parsed = JSON.parse(res.body);
    if (parsed === null || typeof parsed !== "object") return false;
    return Array.isArray(parsed) ? parsed.length > 0 : Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/**
 * Minimal robots.txt check for the `*` agent.
 *
 * Prefix matching from the root, per the standard: `Disallow: /search/` does not match
 * `/app/search`. Getting that wrong in either direction would misreport a site.
 */
function robotsAllows(robotsBody, path) {
  if (!robotsBody || /^\s*<!?[a-z]/i.test(robotsBody.trim())) return true; // no robots.txt served
  let inStar = false;
  const rules = [];
  for (const line of robotsBody.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;
    const [rawKey, ...rest] = clean.split(":");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") inStar = value === "*";
    else if (inStar && (key === "disallow" || key === "allow")) rules.push({ key, value });
  }
  // Longest match wins, Allow beats Disallow at equal length.
  let best = null;
  for (const r of rules) {
    if (!r.value) continue;
    if (path.startsWith(r.value) && (!best || r.value.length > best.value.length)) best = r;
  }
  return !best || best.key === "allow";
}

const rows = [];

for (const site of SITES) {
  const probe = await get(site.probe);
  const fetchable = probe.status === 200 && site.expect.test(probe.body);

  const robots = await get(new URL("/robots.txt", site.probe).href);
  const crawlable = robotsAllows(robots.body, site.searchPath);

  // Tri-state: found / checked-and-absent / could-not-check. Collapsing the last two
  // into "absent" is how the first run of this survey reported govinfo as API-less.
  let apiFound = null;
  let apiUnknown = false;
  for (const api of site.apis) {
    let r = await get(api);
    if (r.status === 0) {
      const viaCurl = curlGet(api);
      if (viaCurl) r = viaCurl;
      else {
        apiUnknown = true;
        continue;
      }
    }
    // 401/403 with a JSON body still means an API exists — it just wants a key.
    if (looksLikeApi(r)) {
      apiFound = api;
      break;
    }
  }

  rows.push({
    name: site.name,
    fetchable,
    crawlable,
    apiless: apiFound ? false : apiUnknown ? null : true,
    bytes: probe.body.length,
    note: apiFound ? new URL(apiFound).host : apiUnknown ? "api check inconclusive" : (probe.error ?? ""),
  });
}

const yn = (b) => (b === null ? "?  " : b ? "yes" : "no ");
console.log("\nsite                          fetchable  crawlable  apiless   bytes  note");
console.log("-".repeat(88));
for (const r of rows) {
  console.log(
    `${r.name.padEnd(30)}${yn(r.fetchable)}        ${yn(r.crawlable)}        ${yn(r.apiless)}   ${String(r.bytes).padStart(6)}  ${r.note}`,
  );
}

// `apiless === true` only, never null: an inconclusive check is not evidence of absence.
const ideal = rows.filter((r) => !r.fetchable && r.crawlable && r.apiless === true);
const apiless = rows.filter((r) => r.apiless === true && r.crawlable);
const notFetchable = rows.filter((r) => !r.fetchable && r.crawlable);

console.log(`\ncrawlable and API-less              ${apiless.map((r) => r.name).join(", ") || "none"}`);
console.log(`crawlable and not fetchable         ${notFetchable.map((r) => r.name).join(", ") || "none"}`);
console.log(`both (satisfies the pitch alone)    ${ideal.map((r) => r.name).join(", ") || "none"}`);
