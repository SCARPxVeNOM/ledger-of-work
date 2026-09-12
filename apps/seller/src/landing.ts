/**
 * The seller, rendered for a person.
 *
 * `/` is the service manifest, and its audience is software: an agent reads it to learn
 * the capabilities, the price books and how to pay. That is the right thing to return and
 * it is not changing. But the same URL is printed on the landing page, in the agent card
 * and in every receipt explorer link, so people open it too — and a wall of JSON is a poor
 * answer to "what is this service and can I trust it".
 *
 * So the manifest is content-negotiated. A browser asks for `text/html` and gets this; an
 * agent asks for `application/json`, or sends no preference at all, and gets exactly the
 * bytes it got before. One resource, two representations — which is what Accept is for,
 * and why this does not need a second URL that can drift from the first.
 *
 * Deliberately one file with inlined CSS and no scripts: this process runs the paid jobs,
 * and giving it a front end to build and serve assets for would be a second thing to keep
 * alive for no benefit. The palette is the one the other two pages use.
 */

export interface LandingInput {
  name: string;
  description: string;
  uaid: string;
  account: string;
  network: string;
  topicId: string;
  facilitator: string;
  baseUrl: string;
  capabilities: Array<{
    name: string;
    description: string;
    site: string;
    fromTinybar: string;
    /** The most this capability can cost, however much work it turns out to need. */
    ceilingTinybar: string;
  }>;
  /**
   * The rate card, when every capability shares one.
   *
   * They currently do — the four price books differ only in their ceiling — so printing a
   * "from" price on each row put four identical numbers in a column, which reads as a
   * comparison and offers none. Stated once when it is shared, per row when it is not.
   */
  sharedRates?: { base: string; perStep: string; perPage: string; perSecond: string } | undefined;
}

/** HTML-escape. Every value below is ours, but a manifest is data and data gets printed. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Tinybar as HBAR, which is the unit a buyer thinks in.
 *
 * Eight decimal places exactly, then trailing zeros trimmed. Not fewer: a floor price
 * here is around 0.003 ℏ, so rounding to four decimals turned 0.00312 into 0.0031 and
 * quietly published a different number than the one being charged. On a page whose whole
 * argument is that the figures can be checked, a rounded price is a wrong price.
 */
function hbar(tinybar: string): string {
  const whole = BigInt(tinybar) / 100_000_000n;
  const frac = (BigInt(tinybar) % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ℏ`;
}

export function renderLanding(m: LandingInput): string {
  const rows = m.capabilities
    .map(
      (c) => `
      <tr>
        <td class="mono strong">${esc(c.name)}</td>
        <td>${esc(c.description)}<div class="site mono">${esc(c.site)}</div></td>
        <td class="mono num">${
          m.sharedRates ? `max ${hbar(c.ceilingTinybar)}` : `from ${hbar(c.fromTinybar)}`
        }</td>
      </tr>`,
    )
    .join("");

  // The rate card, printed once, because it is the thing that actually sets the price.
  const rates = m.sharedRates
    ? `<div class="card">
  <h2>What you are charged</h2>
  <dl>
    <dt>Per job</dt><dd>${hbar(m.sharedRates.base)}</dd>
    <dt>Per step</dt><dd>${hbar(m.sharedRates.perStep)}</dd>
    <dt>Per page</dt><dd>${hbar(m.sharedRates.perPage)}</dd>
    <dt>Per second</dt><dd>${hbar(m.sharedRates.perSecond)}</dd>
  </dl>
  <p class="site mono" style="margin-top:16px">
    The same rates apply to every capability; they differ only in the ceiling above. You
    are quoted before you pay, and charged for the work actually performed — which is
    usually less than the quote, and never more than the ceiling.
  </p>
</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(m.name)} — service manifest</title>
<meta name="description" content="${esc(m.description)}" />
<style>
:root {
  --ground:#fafafa; --surface:#fff; --surface-sunk:#f4f4f5; --ink:#272727;
  --ink-soft:#5c5c5f; --ink-faint:#8e8e93; --line:#e8e8ea; --accent:#1d4ed8;
  --accent-wash:#eff4ff; --pass:#15803d;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --shadow-soft:0 1px 2px 0 rgb(59 59 59/.09),0 2px 4px 0 rgb(59 59 59/.05);
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.notice{border-bottom:1px solid var(--line);background:var(--accent-wash)}
.notice-inner{max-width:900px;margin:0 auto;padding:9px 24px;text-align:center;font-size:12px;color:var(--ink-soft)}
.sheet{max-width:900px;margin:0 auto;padding:0 24px 90px}
header{padding:56px 0 4px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px}
.eyebrow::after{content:"";width:34px;border-bottom:1px solid var(--line)}
h1{font-weight:600;font-size:clamp(32px,5vw,50px);margin:0;line-height:1.04;letter-spacing:-.035em}
h1 em{font-style:normal;color:var(--pass);font-family:var(--mono);letter-spacing:-.02em}
.tagline{margin:20px 0 0;max-width:64ch;color:var(--ink-soft)}
h2{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px;font-weight:500;display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;border-bottom:1px solid var(--line)}
.card{margin-top:28px;padding:26px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-soft)}
table{width:100%;border-collapse:collapse}
td{padding:13px 0;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
tr:last-child td{border-bottom:0}
td:first-child{width:31%;padding-right:16px}
td:last-child{text-align:right;white-space:nowrap;color:var(--ink-soft);font-size:13px}
.strong{font-weight:500}
.site{color:var(--ink-faint);font-size:11.5px;margin-top:3px}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:11px 22px;font-size:13px}
dt{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);padding-top:2px}
dd{margin:0;font-family:var(--mono);word-break:break-all}
a{color:var(--accent);text-underline-offset:3px}
.links{display:flex;flex-wrap:wrap;gap:9px;margin-top:8px}
.links a{display:inline-block;font-family:var(--mono);font-size:11.5px;text-decoration:none;color:var(--ink-soft);border:1px solid var(--line);background:var(--surface-sunk);border-radius:999px;padding:7px 14px}
.links a:hover{border-color:var(--ink-faint);color:var(--ink)}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
@media(max-width:640px){dl{grid-template-columns:1fr;gap:4px 0}dt{margin-top:10px}td:first-child{width:auto}table,tbody,tr,td{display:block}td:last-child{text-align:left}}
</style>
</head>
<body>
<div class="notice"><div class="notice-inner">
  This page is the human view. The same URL returns the JSON manifest to anything asking for it.
</div></div>
<div class="sheet">

<header>
  <p class="eyebrow">Service manifest</p>
  <h1>${esc(m.name)} <em>· seller</em></h1>
  <p class="tagline">${esc(m.description)}</p>
</header>

<div class="card">
  <h2>Capabilities</h2>
  <table><tbody>${rows}</tbody></table>
</div>

${rates}

<div class="card">
  <h2>Identity</h2>
  <dl>
    <dt>Agent id</dt><dd>${esc(m.uaid)}</dd>
    <dt>Account</dt><dd>${esc(m.account)}</dd>
    <dt>Network</dt><dd>${esc(m.network)}</dd>
    <dt>Receipts</dt><dd>${esc(m.topicId)}</dd>
    <dt>Facilitator</dt><dd>${esc(m.facilitator)}</dd>
  </dl>
</div>

<div class="card">
  <h2>Read it yourself</h2>
  <div class="links">
    <a href="${esc(m.baseUrl)}/.well-known/agent-card.json">A2A agent card</a>
    <a href="${esc(m.baseUrl)}/.well-known/x402">x402 manifest</a>
    <a href="${esc(m.baseUrl)}/health">Health</a>
    <a href="https://hashscan.io/testnet/topic/${esc(m.topicId)}" target="_blank" rel="noopener">Receipts on HashScan</a>
    <a href="https://hashscan.io/testnet/account/${esc(m.account)}" target="_blank" rel="noopener">Account on HashScan</a>
  </div>
</div>

<footer>
  Ledger of Work ·
  <a href="https://github.com/SCARPxVeNOM/ledger-of-work" target="_blank" rel="noopener">source</a> ·
  every job listed here writes a receipt anyone can check without asking us
</footer>
</div>
</body>
</html>`;
}
