import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CTAButton,
  Divider,
  EditorialHeading,
  LedgerCard,
  MetadataRow,
  PaperCard,
  ReceiptCard,
  Reveal,
  SectionLabel,
  cx,
} from "./primitives.js";
import { MeterWidget, type MeterLine } from "./MeterWidget.js";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types, kept structural rather than imported.
 *
 * These describe what the seller's HTTP API returns. Importing the seller's own types
 * would drag its dependency tree — Playwright included — into a browser bundle.
 * ────────────────────────────────────────────────────────────────────────────── */

interface Capability {
  name: string;
  description: string;
  site: string;
  priceBook: Record<string, string>;
  limits: { maxSteps: number; maxPages: number; maxSessionMs: number };
}
interface Manifest {
  name: string;
  uaid?: string;
  payment: {
    network: string;
    facilitator: string;
    assets?: Array<{ asset: string; symbol: string }>;
  };
  receipts: { topicId: string; explorer: string };
  agentCard?: { fileId: string; explorer: string };
  capabilities: Capability[];
}
interface Quote {
  capability: string;
  run: string;
  events: string;
  plan: { steps: number; pages: number; outline: string[] };
  price: {
    amount: string;
    asset?: string;
    assetAmount?: string;
    assetSymbol?: string;
    priceBook: Record<string, string>;
  };
}
interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** The check could not be run — different from having failed, and shown differently. */
  unchecked?: boolean;
}
interface RunBody {
  result: { items?: unknown[] };
  artifacts?: { html: string; screenshotBase64: string };
  retrievalProof?: unknown;
  receipt: { topicId: string; sequenceNumber: number; explorer: string };
  plan: { steps: number; pages: number };
  work: { steps: number; pages: number; sessionMs: number };
  price: { unit?: string; quoted: string; charged: string; meteredTinybar?: string };
  payment: { payer: string; txId?: string };
}

/** Parameter shapes per capability. Declarative, because the manifest publishes no schema. */
const FIELDS: Record<string, Array<{ k: string; label: string; type: string; def: string | number }>> =
  {
    "quotes.search_and_extract": [
      { k: "tag", label: "Tag (blank = all quotes)", type: "text", def: "love" },
      { k: "max", label: "How many", type: "number", def: 3 },
    ],
    "virgo.catalogue_search": [
      { k: "query", label: "Catalogue search", type: "text", def: "climate change" },
      { k: "max", label: "How many records", type: "number", def: 25 },
    ],
    "govinfo.federal_register_issues": [
      { k: "year", label: "Year", type: "number", def: 2025 },
      { k: "month", label: "Month (1-12)", type: "number", def: 1 },
      { k: "max", label: "How many issues", type: "number", def: 8 },
    ],
    "oracle.capture_claim": [
      {
        k: "url",
        label: "Source document",
        type: "text",
        def: "https://www.whitehouse.gov/presidential-actions/",
      },
      { k: "select", label: "CSS selector", type: "text", def: ".wp-block-post-title" },
      { k: "max", label: "How many matches", type: "number", def: 3 },
    ],
  };

const fmt = (n: string | number | undefined) => {
  if (n === undefined || n === null) return "—";
  try {
    return BigInt(n).toLocaleString("en-US");
  } catch {
    return String(n);
  }
};

/* ───────────────────────────── navigation ───────────────────────────── */

const NAV = [
  { href: "#capabilities", label: "Capabilities" },
  { href: "#how", label: "How it works" },
  { href: "#meter", label: "Meter" },
  { href: "#receipts", label: "Receipts" },
  { href: "#trust", label: "Verification" },
];

function Nav({ wallet, onConnect, busy }: { wallet: string; onConnect: () => void; busy: boolean }) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cx(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        solid ? "border-b border-rule bg-paper/85 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <nav className="mx-auto flex h-14 max-w-[1180px] items-center justify-between gap-6 px-6 md:px-10">
        <a href="#top" className="font-serif text-[19px] tracking-tight whitespace-nowrap">
          Ledger of Work
        </a>

        <ul className="hidden items-center gap-7 lg:flex">
          {NAV.map((n) => (
            <li key={n.href}>
              <a
                href={n.href}
                className="group relative font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft transition-colors hover:text-ink"
              >
                {n.label}
                <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-ink transition-transform duration-300 group-hover:scale-x-100" />
              </a>
            </li>
          ))}
        </ul>

        <button
          onClick={onConnect}
          disabled={busy}
          className="border border-rule px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.13em] whitespace-nowrap transition-colors hover:border-ink disabled:opacity-40"
        >
          {wallet}
        </button>
      </nav>
    </header>
  );
}

/* ───────────────────────────── sections ───────────────────────────── */

function Hero({ manifest }: { manifest: Manifest | null }) {
  return (
    <section
      id="top"
      className="mx-auto flex min-h-[92svh] max-w-[1180px] flex-col justify-center px-6 pt-28 pb-16 md:px-10"
    >
      <Reveal>
        <MetadataRow
          className="mb-10"
          items={[
            { k: "Network", v: manifest?.payment.network ?? "hedera:testnet" },
            { k: "Scheme", v: "x402 · exact" },
            { k: "Settlement", v: "sub-second" },
          ]}
        />
      </Reveal>

      <Reveal delay={60}>
        <EditorialHeading as="h1" size="display" className="max-w-[16ch]">
          Metered work,
          <br />
          <span className="text-accent italic">receipted</span> on Hedera.
        </EditorialHeading>
      </Reveal>

      <Reveal delay={130}>
        <p className="mt-9 max-w-[52ch] text-[15.5px] leading-[1.7] text-ink-soft">
          An x402-gated service that sells completed multi-step web work — priced by the work it
          actually performs, not a flat fee per call. Every job leaves a tamper-evident receipt
          anyone can check without trusting us.
        </p>
      </Reveal>

      <Reveal delay={200}>
        <div className="mt-11 flex flex-wrap gap-3">
          <CTAButton onClick={() => document.getElementById("capabilities")?.scrollIntoView()}>
            Buy a job
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </CTAButton>
          <CTAButton
            variant="ghost"
            onClick={() => window.open(manifest?.receipts.explorer ?? "#", "_blank")}
          >
            Read the receipts
          </CTAButton>
        </div>
      </Reveal>

      <Reveal delay={280} className="mt-auto pt-16">
        <Divider />
        <MetadataRow
          className="pt-5"
          items={[
            { k: "Receipts topic", v: manifest?.receipts.topicId ?? "—" },
            { k: "Capabilities", v: manifest?.capabilities.length ?? "—" },
            { k: "Facilitator", v: "Blocky402" },
          ]}
        />
      </Reveal>
    </section>
  );
}

const STEPS = [
  { n: "01", t: "Discover", d: "Read the manifest or the open directory on HCS. No key, no account." },
  { n: "02", t: "Quote", d: "A price computed from a published price book, before you commit." },
  { n: "03", t: "Pay the 402", d: "One signed transfer, settled through the Blocky402 facilitator." },
  { n: "04", t: "Work is metered", d: "Steps, pages and seconds counted as the browser performs them." },
  { n: "05", t: "Receipt on Hedera", d: "Hashes of the answer, the page and a witness, written to HCS." },
];

function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
      <Reveal>
        <SectionLabel n="03">How it works</SectionLabel>
        <EditorialHeading className="mt-6 max-w-[18ch]">
          Five steps, none of which ask you to trust the seller.
        </EditorialHeading>
      </Reveal>

      <ol className="mt-14 grid gap-px border border-rule bg-rule md:grid-cols-5">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 70}>
            <li className="group flex h-full flex-col bg-paper-raised p-6 transition-colors hover:bg-paper-deep">
              <span className="font-mono text-[11px] tracking-[0.14em] text-accent">{s.n}</span>
              <h3 className="mt-4 font-serif text-[1.35rem] leading-tight">{s.t}</h3>
              <p className="mt-3 text-[13px] leading-[1.6] text-ink-soft">{s.d}</p>
              <span
                aria-hidden
                className="mt-auto pt-6 font-mono text-ink-faint transition-transform duration-300 group-hover:translate-x-1"
              >
                {i < STEPS.length - 1 ? "→" : "●"}
              </span>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

const TRUST = [
  {
    k: "Hedera Testnet",
    v: "Receipts are written to Hedera Consensus Service. Ordering and timestamps come from the network, not from us.",
  },
  {
    k: "Consensus receipt",
    v: "Every job — including the ones that fail and charge nothing — commits hashes of the answer, the rendered page and a screenshot.",
  },
  {
    k: "Mirror node",
    v: "The verifier reads the public mirror node directly. It needs no credentials and never asks this server anything.",
  },
  {
    k: "Independent witness",
    v: "Capture jobs carry a zkTLS proof: an attestor we do not control signed that the source really returned the answer.",
  },
];

function Trust() {
  return (
    <section id="trust" className="border-y border-rule bg-paper-deep/40">
      <div className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
        <Reveal>
          <SectionLabel n="06">Verification</SectionLabel>
          <EditorialHeading className="mt-6 max-w-[20ch]">
            Four things you can check yourself.
          </EditorialHeading>
        </Reveal>

        <div className="mt-14 grid gap-px border border-rule bg-rule sm:grid-cols-2">
          {TRUST.map((t, i) => (
            <Reveal key={t.k} delay={i * 70}>
              <div className="h-full bg-paper-raised p-7">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.15em] text-accent">
                  {t.k}
                </h3>
                <p className="mt-4 text-[13.5px] leading-[1.65] text-ink-soft">{t.v}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer({ manifest, usage }: { manifest: Manifest | null; usage: UsageState }) {
  return (
    <footer className="mx-auto max-w-[1180px] px-6 py-16 md:px-10">
      <Divider />
      <div className="flex flex-col gap-8 pt-8 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-serif text-[22px] tracking-tight">Ledger of Work</p>
          <p className="mt-2 max-w-[40ch] text-[12.5px] leading-relaxed text-ink-soft">
            Proof of what a paid agent delivered. Built for the AI &amp; Agentic Payments on Hedera
            track.
          </p>
        </div>
        <MetadataRow
          className="md:max-w-[26rem] md:justify-end"
          items={[
            { k: "Network", v: manifest?.payment.network ?? "—" },
            { k: "Build", v: "0.1.0" },
            { k: "Jobs", v: usage?.jobs !== undefined ? fmt(usage.jobs) : "—" },
            {
              k: "Source",
              v: (
                <a
                  className="underline decoration-rule underline-offset-4 hover:decoration-ink"
                  href="https://github.com/SCARPxVeNOM/ledger-of-work"
                  target="_blank"
                  rel="noopener"
                >
                  GitHub
                </a>
              ),
            },
            {
              k: "Receipts",
              v: (
                <a
                  className="underline decoration-rule underline-offset-4 hover:decoration-ink"
                  href={manifest?.receipts.explorer ?? "#"}
                  target="_blank"
                  rel="noopener"
                >
                  HashScan
                </a>
              ),
            },
          ]}
        />
      </div>
    </footer>
  );
}

/* ───────────────────────────── the app ───────────────────────────── */

interface UsageState {
  jobs?: number;
  succeeded?: number;
  distinctPayers?: number;
  work?: { steps: number };
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<UsageState>({});

  const [cap, setCap] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [asset, setAsset] = useState("0.0.0");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [running, setRunning] = useState(false);

  const [lines, setLines] = useState<MeterLine[]>([]);
  const [meter, setMeter] = useState({ amount: "0", unit: "tinybar", caption: "metered" });
  const [progress, setProgress] = useState<number | null>(null);

  const [run, setRun] = useState<RunBody | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [verdict, setVerdict] = useState<{ text: string; ok: boolean } | null>(null);
  const [tampered, setTampered] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resultHash, setResultHash] = useState("computed at verification");

  // Wallets. `demo` is the seller-side policy-capped process; `connected` is the
  // visitor's own, reached over WalletConnect and never seen by this page.
  const [demoWallet, setDemoWallet] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ accountId: string; disconnect: () => Promise<void> } | null>(
    null,
  );
  const [walletBusy, setWalletBusy] = useState(false);

  const esRef = useRef<EventSource | null>(null);

  /* ── boot ── */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/capabilities");
        const body = await res.json();
        // A seller that is down answers 500 with JSON that parses perfectly well and then
        // throws on the first field that is not there. Check the shape, not just the parse.
        if (!res.ok || !body?.payment || !Array.isArray(body.capabilities)) {
          throw new Error(body?.error ?? `seller returned ${res.status}`);
        }
        setManifest(body);
        const first = body.capabilities[0]?.name ?? "";
        setCap(first);
      } catch (e) {
        setError(
          `Cannot reach the seller (${(e as Error).message}). Everything that needs it is unavailable; wallet connection still works.`,
        );
      }
      try {
        const w = await fetch("/api/wallet").then((r) => r.json());
        setDemoWallet(w.connected ? w.accountId : null);
      } catch {
        setDemoWallet(null);
      }
      try {
        const u = await fetch("/api/usage").then((r) => r.json());
        if (u.available && u.jobs) setUsage(u);
      } catch {
        /* usage is supplementary; its absence must not break the demo */
      }
    })();
  }, []);

  // Default the form whenever the capability changes.
  useEffect(() => {
    const defs = FIELDS[cap] ?? [];
    setParams(Object.fromEntries(defs.map((f) => [f.k, String(f.def)])));
    setQuote(null);
  }, [cap]);

  useEffect(() => () => esRef.current?.close(), []);

  const spec = useMemo(
    () => manifest?.capabilities.find((c) => c.name === cap) ?? null,
    [manifest, cap],
  );

  const walletLabel = connected
    ? `${connected.accountId} · yours`
    : demoWallet
      ? `${demoWallet} · demo`
      : "Connect wallet";

  const onConnect = useCallback(async () => {
    setError("");
    if (connected) {
      await connected.disconnect();
      setConnected(null);
      return;
    }
    setWalletBusy(true);
    try {
      // Loaded on click. The connector carries the Hedera SDK and WalletConnect with it —
      // several megabytes nobody who only wants to read a receipt should download.
      const mod = await import("../connect.js");
      setConnected(await mod.connectWallet());
    } catch (e) {
      setError(`Could not connect: ${(e as Error).message}`);
    } finally {
      setWalletBusy(false);
    }
  }, [connected]);

  const onQuote = useCallback(async () => {
    setError("");
    setQuoting(true);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: cap, params: coerce(params), asset }),
      });
      const q = await res.json();
      if (!res.ok) throw new Error(q.message || q.error || "quote failed");
      setQuote(q);
      setRun(null);
      setChecks(null);
      setVerdict(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQuoting(false);
    }
  }, [cap, params, asset]);

  const onRun = useCallback(async () => {
    if (!quote) return;
    setError("");
    setRunning(true);
    setLines([]);
    setRun(null);
    setChecks(null);
    setVerdict(null);
    setTampered(false);
    setMeter({ amount: "0", unit: "tinybar", caption: "metered" });
    setProgress(0);

    const book = quote.price.priceBook;
    let n = 0;

    // The POST goes first. Subscribing before it would race the job's creation of the
    // stream; the stream replays its history to a late subscriber for exactly this reason.
    const runPromise = payAndRun(quote.run, connected);

    const es = new EventSource(quote.events);
    esRef.current = es;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "step") {
        n += 1;
        const cost =
          BigInt(book.base) +
          BigInt(book.perStep) * BigInt(e.steps) +
          BigInt(book.perPage) * BigInt(e.pages) +
          BigInt(book.perSecond) * BigInt(Math.ceil(e.sessionMs / 1000));
        setLines((prev) => [
          ...prev,
          { n: String(n).padStart(2, "0"), what: e.label, cost: cost.toString() },
        ]);
        setMeter((m) => ({ ...m, amount: cost.toString() }));
        setProgress(Math.min(0.95, e.steps / Math.max(1, quote.plan.steps)));
      }
      if (e.type === "done" || e.type === "failed") es.close();
    };
    es.onerror = () => es.close();

    try {
      const res = await runPromise;
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "job failed");

      const unit = body.price.unit ?? "tinybar";
      const metered = body.price.meteredTinybar;
      // Paid in a token, the metered figure and the settled figure are in different
      // denominations. Showing only one invites the wrong reading.
      setLines((prev) => [
        ...prev,
        ...(metered && metered !== body.price.charged
          ? [{ what: "tinybar metered", cost: metered, total: true }]
          : []),
        { what: `${unit} charged`, cost: body.price.charged, total: true },
      ]);
      setMeter({ amount: body.price.charged, unit, caption: "charged" });
      setProgress(1);
      setRun(body);
      setResultHash("computed at verification");
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    } finally {
      es.close();
      setRunning(false);
    }
  }, [quote, connected]);

  const verify = useCallback(
    async (result: unknown, isTampered: boolean) => {
      if (!run) return;
      setVerifying(true);
      setChecks(null);
      setVerdict(null);
      try {
        const res = await fetch("/api/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            topicId: run.receipt.topicId,
            sequenceNumber: run.receipt.sequenceNumber,
            result,
            capability: quote?.capability,
            // Hand back the page, the screenshot and the attestor's proof. Tampering
            // with the *answer* must fail the result hash while these stay green — that
            // contrast is the whole demonstration, and it needs them to be checked.
            ...(run.artifacts
              ? { pageHtml: run.artifacts.html, screenshotBase64: run.artifacts.screenshotBase64 }
              : {}),
            ...(run.retrievalProof ? { retrievalProof: run.retrievalProof } : {}),
          }),
        });
        const out = await res.json();
        setChecks(out.checks);
        setTampered(isTampered);

        const hash = out.checks.find((c: Check) => c.id === "result");
        if (hash) setResultHash((hash.detail.match(/sha256:[0-9a-f]+/) ?? ["—"])[0]);

        // Let the checks stamp in line by line before the verdict lands.
        // Three verdicts. Stamping VERIFIED when something could not be checked overclaims;
        // stamping VOID accuses the seller of a fault that may only be a missing file.
        const skipped = out.checks.filter((c: Check) => !c.ok && c.unchecked).length;
        const text = !out.ok ? "VOID" : skipped ? "PARTLY" : "VERIFIED";
        setTimeout(
          () => setVerdict({ text, ok: out.ok }),
          out.checks.length * 55 + 120,
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setVerifying(false);
      }
    },
    [run, quote],
  );

  const onTamper = useCallback(() => {
    if (!run) return;
    // Change exactly one character of one field. The payment, the price and the receipt
    // on chain are all untouched.
    const copy = structuredClone(run.result) as { items?: Array<Record<string, unknown>> };
    const first = copy.items?.[0];
    if (first) {
      const key =
        "author" in first ? "author" : "title" in first ? "title" : (Object.keys(first)[0] as string);
      first[key] = `${String(first[key])}x`;
    }
    void verify(copy, true);
  }, [run, verify]);

  const price = quote
    ? quote.price.asset && quote.price.asset !== "0.0.0"
      ? { amount: quote.price.assetAmount ?? "0", unit: quote.price.assetSymbol ?? "TOKEN" }
      : { amount: quote.price.amount, unit: "tinybar" }
    : null;

  return (
    <>
      <Nav wallet={walletLabel} onConnect={onConnect} busy={walletBusy} />

      <main>
        <Hero manifest={manifest} />

        {error && (
          <div className="mx-auto max-w-[1180px] px-6 md:px-10">
            <p className="border border-accent/40 bg-accent/5 px-5 py-3 font-mono text-[12px] text-accent">
              {error}
            </p>
          </div>
        )}

        {/* ── 01 / 02 — order a job ── */}
        <section id="capabilities" className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
          <Reveal>
            <SectionLabel n="01">Capabilities</SectionLabel>
            <EditorialHeading className="mt-6 max-w-[19ch]">
              Pick the work. The price follows it.
            </EditorialHeading>
            <p className="mt-6 max-w-[54ch] text-[15px] leading-[1.7] text-ink-soft">
              Each capability publishes its own price book before you buy — a base, a rate per step,
              per page and per second. A two-step job costs less than a twelve-step one, and you can
              compute either yourself.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="grid gap-px border border-rule bg-rule sm:grid-cols-2">
              {(manifest?.capabilities ?? []).map((c, i) => (
                <PaperCard
                  key={c.name}
                  as="button"
                  interactive
                  selected={c.name === cap}
                  onClick={() => setCap(c.name)}
                  aria-pressed={c.name === cap}
                  className="group h-full border-0 p-6 text-left"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[11px] tracking-[0.14em] text-accent">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                      {hostOf(c.site)}
                    </span>
                  </div>
                  <h3 className="mt-4 font-serif text-[1.3rem] leading-tight">
                    {c.name.split(".")[1]?.replace(/_/g, " ") ?? c.name}
                  </h3>
                  <p className="mt-3 line-clamp-3 text-[12.5px] leading-[1.6] text-ink-soft">
                    {c.description}
                  </p>
                  <div className="mt-5 flex gap-4 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                    <span>≤{c.limits.maxSteps} steps</span>
                    <span>≤{c.limits.maxPages} pages</span>
                  </div>
                </PaperCard>
              ))}
              {!manifest && (
                <div className="bg-paper-raised p-6 font-mono text-[12px] text-ink-faint sm:col-span-2">
                  loading the catalogue…
                </div>
              )}
            </div>

            {/* order panel */}
            <Reveal>
              <PaperCard className="p-7">
                <SectionLabel n="02">Order a job</SectionLabel>

                <div className="mt-7 space-y-6">
                  {(FIELDS[cap] ?? []).map((f) => (
                    <Field
                      key={f.k}
                      id={`f-${f.k}`}
                      label={f.label}
                      type={f.type}
                      value={params[f.k] ?? ""}
                      onChange={(v) => setParams((p) => ({ ...p, [f.k]: v }))}
                    />
                  ))}

                  {(manifest?.payment.assets?.length ?? 0) > 1 && (
                    <div>
                      <label
                        htmlFor="asset"
                        className="block font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint"
                      >
                        Pay in
                      </label>
                      <select
                        id="asset"
                        value={asset}
                        onChange={(e) => setAsset(e.target.value)}
                        className="mt-2 w-full border-0 border-b border-ink bg-transparent py-2 font-mono text-[13px] focus:border-b-2 focus:outline-none"
                      >
                        {manifest?.payment.assets?.map((a) => (
                          <option key={a.asset} value={a.asset}>
                            {a.symbol}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                <CTAButton
                  data-testid="btn-quote"
                  full
                  variant="ghost"
                  className="mt-8"
                  onClick={onQuote}
                  disabled={quoting || !cap}
                >
                  {quoting ? "Pricing…" : "Get a quote"}
                </CTAButton>

                {quote && price && (
                  <div className="mt-7 border-t border-rule pt-6">
                    <div className="flex items-baseline gap-2">
                      <span
                        data-testid="quote-amount"
                        className="font-serif text-[2.6rem] leading-none tabular-nums"
                      >
                        {fmt(price.amount)}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-soft">
                        {price.unit}
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">
                      {quote.plan.steps} steps · {quote.plan.pages} pages
                    </p>
                    <ul className="mt-4 space-y-1.5 text-[12.5px] leading-snug text-ink-soft">
                      {quote.plan.outline.map((l, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-ink-faint">·</span>
                          {l}
                        </li>
                      ))}
                    </ul>
                    <CTAButton data-testid="btn-run" full className="mt-7" onClick={onRun} disabled={running}>
                      {running ? "Working…" : "Pay and run"}
                    </CTAButton>
                  </div>
                )}
              </PaperCard>
            </Reveal>
          </div>
        </section>

        {/* ── 04 — the meter ── */}
        <section id="meter" className="border-y border-rule bg-paper-deep/40">
          <div className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
            <Reveal>
              <SectionLabel n="04">Live meter</SectionLabel>
              <EditorialHeading className="mt-6 max-w-[17ch]">
                Watch the price being earned.
              </EditorialHeading>
              <p className="mt-6 max-w-[52ch] text-[15px] leading-[1.7] text-ink-soft">
                The seller streams the same counter that produces the price. Each line is one step
                the worker actually performed, priced as it happened.
              </p>
            </Reveal>
            <Reveal delay={80} className="mt-12">
              <MeterWidget
                amount={meter.amount}
                unit={meter.unit}
                caption={meter.caption}
                lines={lines}
                running={running}
                progress={progress}
              />
            </Reveal>
          </div>
        </section>

        {/* ── 05 — receipts ── */}
        <section id="receipts" className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
          <Reveal>
            <SectionLabel n="05">Receipts</SectionLabel>
            <EditorialHeading className="mt-6 max-w-[20ch]">
              The record you can check without us.
            </EditorialHeading>
          </Reveal>

          {!run ? (
            <Reveal delay={60}>
              <PaperCard className="mt-12 p-10 text-center">
                <p className="font-mono text-[12.5px] text-ink-faint">
                  no receipt yet — run a job and one is written to Hedera
                </p>
              </PaperCard>
            </Reveal>
          ) : (
            <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <Reveal>
                <ReceiptCard stamp={verdict}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    delivery receipt
                  </p>
                  <p
                    data-testid="receipt-seq"
                    className="mt-1 font-serif text-[1.7rem] leading-tight"
                  >
                    #{run.receipt.sequenceNumber}
                  </p>
                  <dl className="mt-6 divide-y divide-rule-soft">
                    {[
                      { k: "Topic", v: run.receipt.topicId },
                      { k: "Capability", v: quote?.capability ?? "—" },
                      { k: "Planned", v: `${run.plan.steps} steps, ${run.plan.pages} pages` },
                      {
                        k: "Performed",
                        v: `${run.work.steps} steps, ${run.work.pages} pages, ${run.work.sessionMs} ms`,
                      },
                      { k: "Quoted", v: `${fmt(run.price.quoted)} ${run.price.unit ?? "tinybar"}` },
                      {
                        k: "Charged",
                        v: `${fmt(run.price.charged)} ${run.price.unit ?? "tinybar"}`,
                      },
                      { k: "Paying agent", v: run.payment.payer },
                      { k: "Items", v: String(run.result.items?.length ?? 0) },
                      { k: "Result hash", v: resultHash },
                    ].map((r) => (
                      <div key={r.k} className="flex items-baseline justify-between gap-5 py-2.5">
                        <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-soft">
                          {r.k}
                        </dt>
                        <dd className="text-right font-mono text-[12px] break-all tabular-nums">
                          {r.v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-6 flex flex-wrap gap-4 font-mono text-[11px]">
                    <a
                      className="underline decoration-rule underline-offset-4 hover:decoration-ink"
                      href={run.receipt.explorer}
                      target="_blank"
                      rel="noopener"
                    >
                      View on HashScan ↗
                    </a>
                    {run.payment.txId && (
                      <a
                        className="underline decoration-rule underline-offset-4 hover:decoration-ink"
                        href={`https://hashscan.io/testnet/transaction/${run.payment.txId}`}
                        target="_blank"
                        rel="noopener"
                      >
                        Settlement ↗
                      </a>
                    )}
                  </div>
                </ReceiptCard>
              </Reveal>

              <Reveal delay={80}>
                <PaperCard className="p-7">
                  <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                    Independent verification
                  </h3>
                  <p className="mt-4 text-[13.5px] leading-[1.6] text-ink-soft">
                    Checked against the public mirror node using the same code the CLI runs. Change
                    one character of the answer and the hash check goes red while everything else
                    stays green.
                  </p>

                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <CTAButton
                      data-testid="btn-verify"
                      onClick={() => verify(run.result, false)}
                      disabled={verifying}
                    >
                      Verify
                    </CTAButton>
                    <CTAButton
                      data-testid="btn-tamper"
                      variant="ghost"
                      onClick={onTamper}
                      disabled={verifying}
                    >
                      Tamper &amp; re-verify
                    </CTAButton>
                  </div>

                  {checks && (
                    <div data-testid="checks" className="mt-7 space-y-px border-t border-rule pt-5">
                      {checks.map((c, i) => (
                        <div
                          key={c.id}
                          className="print-in grid grid-cols-[3.1rem_1fr] gap-3 py-1.5"
                          style={{ animationDelay: `${i * 55}ms` }}
                        >
                          <span
                            className={cx(
                              "font-mono text-[10px] font-semibold tracking-[0.1em]",
                              c.ok ? "text-pass" : c.unchecked ? "text-ink-faint" : "text-void",
                            )}
                          >
                            {c.ok ? "PASS" : c.unchecked ? "SKIP" : "FAIL"}
                          </span>
                          <span>
                            <span className="block text-[12.5px] leading-snug">{c.label}</span>
                            <span className="mt-0.5 block font-mono text-[10.5px] break-all text-ink-faint">
                              {c.detail}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {tampered && (
                    <p className="mt-5 border-l-2 border-accent pl-4 text-[12.5px] leading-[1.6] text-ink-soft">
                      One character changed. The payment still settled, the price still follows the
                      published book, the record is still on chain — only the hash no longer matches.
                    </p>
                  )}
                </PaperCard>
              </Reveal>
            </div>
          )}

          {usage.jobs !== undefined && (
            <Reveal delay={120} className="mt-14">
              <Divider label="On the ledger so far" className="mb-6" />
              <div className="grid grid-cols-2 gap-px border border-rule bg-rule md:grid-cols-4">
                {[
                  { k: "Jobs", v: fmt(usage.jobs) },
                  {
                    k: "Success",
                    v: `${Math.round(((usage.succeeded ?? 0) / (usage.jobs || 1)) * 100)}%`,
                  },
                  { k: "Paying accounts", v: fmt(usage.distinctPayers) },
                  { k: "Steps metered", v: fmt(usage.work?.steps) },
                ].map((s) => (
                  <div key={s.k} className="bg-paper-raised p-6">
                    <p className="font-serif text-[2rem] leading-none tabular-nums">{s.v}</p>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
                      {s.k}
                    </p>
                  </div>
                ))}
              </div>
            </Reveal>
          )}
        </section>

        <HowItWorks />
        <Trust />
      </main>

      <Footer manifest={manifest} usage={usage} />
    </>
  );
}

/* ───────────────────────────── helpers ───────────────────────────── */

function Field({
  id,
  label,
  type,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="group">
      <label
        htmlFor={id}
        className="block font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint transition-colors group-focus-within:text-accent"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full border-0 border-b border-rule bg-transparent py-2 font-mono text-[13px] text-ink transition-colors placeholder:text-ink-faint focus:border-ink focus:outline-none"
      />
    </div>
  );
}

const hostOf = (site: string) => {
  try {
    return new URL(site).hostname.replace(/^www\./, "");
  } catch {
    return site;
  }
};

/** Numeric-looking values go over the wire as numbers; the seller validates types strictly. */
function coerce(params: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === "") continue;
    out[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

/**
 * Pay, then run.
 *
 * Two shapes, and they differ only in where the signature comes from: one round trip
 * through our own process, or two around a human tapping approve on their phone.
 */
async function payAndRun(
  runUrl: string,
  connected: { accountId: string } | null,
): Promise<Response> {
  if (!connected) {
    return fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runUrl }),
    });
  }

  const prep = await fetch("/api/pay/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runUrl, buyerAccountId: connected.accountId }),
  });
  const p = await prep.json();
  if (!prep.ok) throw new Error(p.error ?? "could not prepare the payment");

  const mod = await import("../connect.js");
  const signed = await mod.signPayment(connected.accountId, p.unsigned);

  return fetch("/api/pay/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payId: p.payId, signed }),
  });
}
