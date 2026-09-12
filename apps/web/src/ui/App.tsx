import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CTAButton,
  Divider,
  EditorialHeading,
  MetadataRow,
  MonoAccent,
  PaperCard,
  Pill,
  PlusList,
  ReceiptCard,
  Reveal,
  SectionLabel,
  cx,
} from "./primitives.js";
import { MeterWidget, type MeterLine } from "./MeterWidget.js";
import { AgentBar } from "./AgentBar.js";
import { Art, FloatingArt } from "./Art.js";
import {
  AnimatedShinyText,
  AuroraText,
  BorderBeam,
  HederaMark,
  Marquee,
  NumberTicker,
} from "./magicui.js";

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
  { href: "#paper", label: "Write-up" },
];

/**
 * Why the wallet did not connect, said where the wallet was asked for.
 *
 * This began life in the page's one shared error banner, which sits under the hero —
 * about seven hundred pixels below the nav button that causes it. The button reset
 * itself and nothing appeared to happen, because the explanation was off screen. An
 * error has to be rendered next to the control that produced it or it may as well not
 * exist.
 */
function WalletNotice({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      // `alert` rather than `status`: this interrupts something the reader was actively
      // trying to do, so a screen reader should say it now rather than when it next pauses.
      role="alert"
      className={cx(
        "rounded-[10px] border border-accent/35 bg-surface p-3.5 text-left shadow-[var(--shadow-lift)]",
        className,
      )}
    >
      <p className="font-mono text-[11px] leading-[1.55] text-ink-soft">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase hover:text-ink"
      >
        dismiss
      </button>
    </div>
  );
}

function Nav({
  wallet,
  onConnect,
  busy,
  error,
  onDismissError,
}: {
  wallet: string;
  onConnect: () => void;
  busy: boolean;
  error: string;
  onDismissError: () => void;
}) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      {/* The thin notice strip above everything. Tinted rather than loud, and it says one
          thing — a banner that says three is an advert. */}
      <div className="relative z-50 border-b border-line bg-accent-wash/70">
        <div className="mx-auto flex max-w-[1200px] items-center justify-center gap-2 px-6 py-2 text-center text-[12px]">
          <HederaMark className="h-3.5 w-3.5 text-ink" />
          <AnimatedShinyText className="text-ink-soft">
            Running on Hedera testnet — every job below writes a real receipt
          </AnimatedShinyText>
        </div>
      </div>

      <header
        className={cx(
          "sticky top-0 z-40 transition-colors duration-300",
          solid ? "border-b border-line bg-ground/80 backdrop-blur-md" : "border-b border-transparent",
        )}
      >
        <nav className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-6">
          <a href="#top" className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-[17px] font-semibold tracking-[-0.03em]">Ledger of Work</span>
            <Pill tone="neutral" className="gap-1.5 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.1em]">
              <HederaMark className="h-3 w-3" />
              TESTNET
            </Pill>
          </a>

          <ul className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <li key={n.href}>
                <a
                  href={n.href}
                  className="rounded-full px-3 py-1.5 text-[13.5px] text-ink-soft transition-colors hover:bg-surface-sunk hover:text-ink"
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="relative">
            <CTAButton size="sm" variant="ghost" onClick={onConnect} disabled={busy}>
              <span className="font-mono text-[11.5px]">{wallet}</span>
            </CTAButton>

            {/* Hangs below the button rather than displacing it, so the nav does not
                change height and shove the whole page down to report a failure. */}
            {error && (
              <WalletNotice
                message={error}
                onDismiss={onDismissError}
                className="absolute top-full right-0 z-50 mt-2 w-[320px]"
              />
            )}
          </div>
        </nav>
      </header>
    </>
  );
}

/* ───────────────────────────── sections ───────────────────────────── */

function Hero({ manifest }: { manifest: Manifest | null }) {
  return (
    <section
      id="top"
      className="mx-auto grid max-w-[1240px] items-center gap-12 px-6 py-16 lg:min-h-[80svh] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.86fr)] lg:gap-8 lg:py-20"
    >
      <div className="text-center lg:text-left">
        <Reveal>
          <Pill tone="accent" className="gap-2 px-3 py-1.5">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase">x402</span>
            <span>Pay per job, not per call</span>
            <span aria-hidden>→</span>
          </Pill>
        </Reveal>

        <Reveal delay={60}>
          <EditorialHeading as="h1" size="display" className="mt-7 max-w-[15ch]">
            Work you can pay for.{" "}
            <AuroraText className="font-mono font-medium tracking-[-0.03em]">Receipted.</AuroraText>
          </EditorialHeading>
        </Reveal>

        <Reveal delay={120}>
          <p className="mx-auto mt-6 max-w-[52ch] text-[16px] leading-[1.65] text-ink-soft lg:mx-0">
            An x402-gated service that sells completed multi-step web work — priced by the work it
            actually performs, with a tamper-evident receipt on Hedera that anyone can check
            without trusting us.
          </p>
        </Reveal>

        <Reveal delay={180}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <CTAButton onClick={() => document.getElementById("capabilities")?.scrollIntoView()}>
              Buy a job
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </CTAButton>
            <CTAButton
              variant="quiet"
              onClick={() => window.open(manifest?.receipts.explorer ?? "#", "_blank")}
            >
              <span aria-hidden>◷</span> Read the receipts
            </CTAButton>
          </div>
        </Reveal>

        <Reveal delay={240} className="mt-12">
          <MetadataRow
            className="justify-center lg:justify-start"
            items={[
              { k: "Network", v: manifest?.payment.network ?? "hedera:testnet" },
              { k: "Scheme", v: "exact" },
              { k: "Topic", v: manifest?.receipts.topicId ?? "—" },
            ]}
          />
        </Reveal>
      </div>

      {/* The collage: a receipt, the checks it passes, the consensus it is written to, and
          the page it came from. Everything the product does, in one picture — and each of
          them exists live further down, which is why this one is decorative. */}
      <FloatingArt rotate={-3} delay={0.25} drift={14} className="mx-auto w-full max-w-[560px]">
        <Art name="collage" sizes="(max-width: 1024px) 80vw, 46vw" priority />
      </FloatingArt>
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
    <section id="how" className="mx-auto max-w-[1200px] px-6 py-24">
      <Reveal className="text-center">
        <SectionLabel className="justify-center">How it works</SectionLabel>
        <EditorialHeading className="mx-auto mt-4 max-w-[20ch]">
          Five steps, none of which ask you to <MonoAccent>trust us.</MonoAccent>
        </EditorialHeading>
      </Reveal>

      <ol className="mt-14 grid gap-4 md:grid-cols-3 lg:grid-cols-5">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 60}>
            <PaperCard dark={i === 4} className="flex h-full flex-col p-5">
              <span
                className={cx(
                  "font-mono text-[11px] tracking-[0.14em]",
                  i === 4 ? "text-ink-invert/60" : "text-ink-faint",
                )}
              >
                {s.n}
              </span>
              <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.02em]">{s.t}</h3>
              <p
                className={cx(
                  "mt-2 text-[13px] leading-[1.55]",
                  i === 4 ? "text-ink-invert/70" : "text-ink-soft",
                )}
              >
                {s.d}
              </p>
            </PaperCard>
          </Reveal>
        ))}
      </ol>

      <Reveal delay={120} className="mt-16">
        <FloatingArt rotate={1.5} delay={0.1} drift={9} className="mx-auto max-w-[760px]">
          <Art
            name="decision"
            sizes="(max-width: 768px) 92vw, 760px"
            alt="A scale review card: a decision about when a job queue becomes the bottleneck, with load, p99 and budget figures beside it."
          />
        </FloatingArt>
      </Reveal>
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
    <section id="trust" className="border-y border-line bg-surface-sunk/40">
      <div className="mx-auto max-w-[1200px] px-6 py-24">
        <Reveal className="text-center">
          <SectionLabel className="justify-center">Verification</SectionLabel>
          <EditorialHeading className="mx-auto mt-4 max-w-[22ch]">
            Four things you can <MonoAccent>check yourself.</MonoAccent>
          </EditorialHeading>
        </Reveal>

        <div className="mt-14 grid gap-4 sm:grid-cols-2">
          {TRUST.map((t, i) => (
            <Reveal key={t.k} delay={i * 60}>
              <PaperCard className="h-full p-6">
                <div className="flex items-center gap-2">
                  <HederaMark className="h-3.5 w-3.5 text-ink-faint" />
                  <SectionLabel>{t.k}</SectionLabel>
                </div>
                <p className="mt-3 text-[13.5px] leading-[1.6] text-ink-soft">{t.v}</p>
              </PaperCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer({ manifest, usage }: { manifest: Manifest | null; usage: UsageState }) {
  return (
    <footer className="mx-auto max-w-[1200px] px-6 py-16">
      <Divider />
      <div className="flex flex-col gap-8 pt-8 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.03em]">
            <HederaMark className="h-4 w-4" />
            Ledger of Work
          </p>
          <p className="mt-2 max-w-[42ch] text-[13px] leading-relaxed text-ink-soft">
            Proof of what a paid agent delivered. Built for the AI &amp; Agentic Payments on Hedera
            track.
          </p>
        </div>
        <MetadataRow
          className="md:max-w-[28rem] md:justify-end"
          items={[
            { k: "Network", v: manifest?.payment.network ?? "—" },
            { k: "Build", v: "0.1.0" },
            { k: "Jobs", v: usage?.jobs !== undefined ? fmt(usage.jobs) : "—" },
            {
              k: "Source",
              v: (
                <a
                  className="underline decoration-line underline-offset-4 hover:decoration-ink"
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
                  className="underline decoration-line underline-offset-4 hover:decoration-ink"
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
  /** Capability → jobs served. Read off the public topic, not from a counter we keep. */
  byCapability?: Record<string, number>;
  revenue?: Record<string, string>;
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
  /** What the worker is doing right now, and how far through — drives the agent bar. */
  const [step, setStep] = useState({ label: "", done: 0 });

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
  /**
   * Kept apart from `error`, which belongs to the job. A wallet that will not open is
   * reported beside the connect button; a job that failed is reported beside the job.
   * One shared banner meant whichever happened last silently replaced the other.
   */
  const [walletError, setWalletError] = useState("");

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

  // What the button says it will do, not what the page happens to know. Showing the demo
  // account here made it read as a status display, so nobody pressed it.
  const walletLabel = walletBusy
    ? "Opening wallet…"
    : connected
      ? `${connected.accountId} · disconnect`
      : "Connect wallet";

  const onConnect = useCallback(async () => {
    setWalletError("");
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
      // Closing the modal is a decision, not a failure. Reporting it in red alongside
      // real errors teaches people to ignore the red.
      // RelayBlocked already reads as a sentence to a person; the others need framing.
      const err = e as Error;
      if (err.name === "OriginNotAllowed") {
        // Only offer the demo wallet where there is one. The hosted demo has none — it
        // holds a key and is bound to loopback — so pointing at it there would be
        // sending the reader after something that does not exist.
        setWalletError(
          demoWallet
            ? `${err.message} You can also pay from the demo wallet below.`
            : err.message,
        );
      } else if (err.name !== "WalletCancelled") {
        setWalletError(`Could not connect: ${err.message}`);
      }
    } finally {
      setWalletBusy(false);
    }
  }, [connected, demoWallet]);

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
    setStep({ label: "starting…", done: 0 });

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
        setStep({ label: e.label, done: e.steps });
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
      setStep({ label: "done — receipt written to Hedera", done: body.work.steps });
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
      <Nav
        wallet={walletLabel}
        onConnect={onConnect}
        busy={walletBusy}
        error={walletError}
        onDismissError={() => setWalletError("")}
      />

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
          <Reveal className="text-center">
            <SectionLabel className="justify-center">Capabilities</SectionLabel>
            <EditorialHeading className="mx-auto mt-4 max-w-[22ch]">
              Pick the work. The price <MonoAccent>follows it.</MonoAccent>
            </EditorialHeading>
            <p className="mx-auto mt-5 max-w-[58ch] text-[15px] leading-[1.65] text-ink-soft">
              Each capability publishes its own price book before you buy — a base, then a rate per
              step, per page and per second. A two-step job costs less than a twelve-step one, and
              you can compute either yourself.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="grid gap-4 sm:grid-cols-2">
              {(manifest?.capabilities ?? []).map((c, i) => (
                <PaperCard
                  key={c.name}
                  as="button"
                  interactive
                  selected={c.name === cap}
                  onClick={() => setCap(c.name)}
                  aria-pressed={c.name === cap}
                  className="h-full overflow-hidden p-5"
                >
                  {c.name === cap && <BorderBeam duration={8} size={70} />}
                  <div className="flex items-center justify-between gap-3">
                    <SectionLabel n={String(i + 1).padStart(2, "0")}>{hostOf(c.site)}</SectionLabel>
                    {c.name === cap && <Pill tone="dark">Selected</Pill>}
                  </div>
                  <h3 className="mt-3 font-mono text-[17px] font-medium tracking-[-0.02em]">
                    {c.name.split(".")[1]?.replace(/_/g, " ") ?? c.name}
                  </h3>
                  <p className="mt-2 line-clamp-3 text-[13px] leading-[1.55] text-ink-soft">
                    {c.description}
                  </p>
                  <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
                    <Pill>≤{c.limits.maxSteps} steps</Pill>
                    <Pill>≤{c.limits.maxPages} pages</Pill>
                  </div>
                </PaperCard>
              ))}
              {!manifest && (
                <PaperCard className="p-6 sm:col-span-2">
                  <p className="font-mono text-[12.5px] text-ink-faint">loading the catalogue…</p>
                </PaperCard>
              )}
            </div>

            {/* order panel */}
            <Reveal>
              <PaperCard className="p-6">
                <SectionLabel>Order a job</SectionLabel>

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
                        className="mt-2 w-full rounded-lg bg-surface-sunk px-3 py-2 font-mono text-[13px] ring-1 ring-line transition focus:ring-ink focus:outline-none"
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
                  <div className="mt-6 border-t border-line pt-5">
                    <div className="flex items-baseline gap-2">
                      <span
                        data-testid="quote-amount"
                        className="font-mono text-[2.1rem] leading-none font-medium tracking-[-0.03em] tabular-nums"
                      >
                        {fmt(price.amount)}
                      </span>
                      <span className="font-mono text-[11px] text-ink-faint">{price.unit}</span>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Pill>{quote.plan.steps} steps</Pill>
                      <Pill>{quote.plan.pages} pages</Pill>
                    </div>
                    <PlusList items={quote.plan.outline} />
                    <CTAButton data-testid="btn-run" full className="mt-7" onClick={onRun} disabled={running || (!connected && !demoWallet)}>
                      {running ? "Working…" : "Pay and run"}
                    </CTAButton>

                    {/* Who is about to pay, said where the paying happens. This used to be
                        in the nav, where it read as a status badge rather than a choice. */}
                    <p className="mt-3 text-center font-mono text-[10.5px] text-ink-faint">
                      {connected ? (
                        <>paying from your wallet · {connected.accountId}</>
                      ) : demoWallet ? (
                        <>
                          paying from the demo wallet · {demoWallet} ·{" "}
                          <button
                            type="button"
                            onClick={onConnect}
                            className="underline decoration-line underline-offset-2 hover:text-ink"
                          >
                            use your own
                          </button>
                        </>
                      ) : (
                        <>
                          no wallet ·{" "}
                          <button
                            type="button"
                            onClick={onConnect}
                            className="underline decoration-line underline-offset-2 hover:text-ink"
                          >
                            connect one to pay
                          </button>
                        </>
                      )}
                    </p>

                    {/* The other place the wallet is asked for, so the other place the
                        answer has to appear. */}
                    {walletError && (
                      <WalletNotice
                        message={walletError}
                        onDismiss={() => setWalletError("")}
                        className="mt-3"
                      />
                    )}
                  </div>
                )}
              </PaperCard>
            </Reveal>
          </div>
        </section>

        {/* ── 04 — the meter ── */}
        <section id="meter" className="border-y border-line bg-surface-sunk/40">
          <div className="mx-auto max-w-[1200px] px-6 py-24">
            <Reveal className="text-center">
              <SectionLabel className="justify-center">Live meter</SectionLabel>
              <EditorialHeading className="mx-auto mt-4 max-w-[20ch]">
                Watch the price being <MonoAccent>earned.</MonoAccent>
              </EditorialHeading>
              <p className="mx-auto mt-5 max-w-[56ch] text-[15px] leading-[1.65] text-ink-soft">
                The seller streams the same counter that produces the price. Each line is one step
                the worker actually performed, priced as it happened.
              </p>
            </Reveal>

            {/* The idea, then the instrument. This is an illustration; the panel below it
                is the live thing, and the difference is the point of the section. */}
            <Reveal delay={60} className="mt-12">
              <FloatingArt rotate={-2} delay={0.1} drift={10} className="mx-auto max-w-[720px]">
                <Art name="livejob" sizes="(max-width: 768px) 92vw, 720px" />
              </FloatingArt>
            </Reveal>
            <Reveal delay={80} className="mt-12">
              <div className="relative pb-8">
                <MeterWidget
                  amount={meter.amount}
                  unit={meter.unit}
                  caption={meter.caption}
                  lines={lines}
                  running={running}
                  progress={progress}
                />
                {/* Overlapping the panel, the way the reference does — attached to the job
                    rather than floating beside it. */}
                <div className="absolute inset-x-4 -bottom-1 sm:inset-x-10">
                  <AgentBar
                    state={running ? "working" : run ? "done" : "idle"}
                    label={step.label}
                    done={step.done}
                    total={quote?.plan.steps ?? 0}
                  />
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 05 — receipts ── */}
        <section id="receipts" className="mx-auto max-w-[1200px] px-6 py-24">
          <Reveal className="text-center">
            <SectionLabel className="justify-center">Receipts</SectionLabel>
            <EditorialHeading className="mx-auto mt-4 max-w-[22ch]">
              The record you can check <MonoAccent>without us.</MonoAccent>
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
                    className="mt-1 font-mono text-[1.6rem] leading-none font-medium tracking-[-0.03em]"
                  >
                    #{run.receipt.sequenceNumber}
                  </p>
                  <dl className="mt-5 divide-y divide-line">
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
                    <div data-testid="checks" className="mt-6 space-y-px border-t border-line pt-4">
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
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {[
                  { k: "Jobs", n: usage.jobs ?? 0, suffix: "" },
                  {
                    k: "Success",
                    n: Math.round(((usage.succeeded ?? 0) / (usage.jobs || 1)) * 100),
                    suffix: "%",
                  },
                  { k: "Paying accounts", n: usage.distinctPayers ?? 0, suffix: "" },
                  { k: "Steps metered", n: usage.work?.steps ?? 0, suffix: "" },
                ].map((s) => (
                  <PaperCard key={s.k} className="p-5">
                    <p className="font-mono text-[1.75rem] leading-none font-medium tracking-[-0.03em]">
                      <NumberTicker value={s.n} />
                      {s.suffix}
                    </p>
                    <p className="mt-2 text-[12.5px] text-ink-soft">{s.k}</p>
                  </PaperCard>
                ))}
              </div>
            </Reveal>
          )}

          {usage.byCapability && Object.keys(usage.byCapability).length > 0 && (
            <Reveal delay={160} className="mt-10">
              {/* Every chip is a count read off the public topic, including capabilities
                  we have since retired — this is what was sold, not what is on the menu. */}
              <Marquee pauseOnHover className="[--duration:38s]">
                {Object.entries(usage.byCapability)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, n]) => (
                    <span
                      key={name}
                      className="flex items-center gap-2.5 rounded-full bg-surface px-4 py-2 ring-1 ring-line"
                    >
                      <span className="font-mono text-[11.5px] text-ink">{name}</span>
                      <span className="h-3 w-px bg-line" aria-hidden />
                      <span className="font-mono text-[11.5px] text-ink-faint tabular-nums">
                        {n} {n === 1 ? "job" : "jobs"}
                      </span>
                    </span>
                  ))}
              </Marquee>
            </Reveal>
          )}
        </section>

        <HowItWorks />
        <Trust />

        {/* The written argument, for a reader who wants the reasoning rather than the demo.
            The image is the cover; the link goes to the thing itself. */}
        <section id="paper" className="mx-auto max-w-[1200px] px-6 py-24">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
            <Reveal>
              <FloatingArt rotate={-2.5} delay={0.1} drift={10} className="mx-auto max-w-[440px]">
                <Art
                  name="paper"
                  sizes="(max-width: 1024px) 76vw, 440px"
                  alt="Cover of the Ledger of Work write-up: verifiable work for the agent economy."
                />
              </FloatingArt>
            </Reveal>

            <Reveal delay={80}>
              <SectionLabel>The write-up</SectionLabel>
              <EditorialHeading className="mt-4 max-w-[18ch]">
                Why any of this <MonoAccent>needs proving.</MonoAccent>
              </EditorialHeading>
              <p className="mt-5 max-w-[52ch] text-[15px] leading-[1.65] text-ink-soft">
                The README is the long version: what the receipt proves and what it does not, why
                the price is metered rather than flat, how a zkTLS attestor gets a third party to
                vouch for the answer, and the measurements behind every claim — including the ones
                that came out badly.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <CTAButton
                  onClick={() =>
                    window.open("https://github.com/SCARPxVeNOM/ledger-of-work#readme", "_blank")
                  }
                >
                  Read it
                  <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </CTAButton>
                <CTAButton
                  variant="ghost"
                  onClick={() =>
                    window.open("https://github.com/SCARPxVeNOM/ledger-of-work", "_blank")
                  }
                >
                  Source
                </CTAButton>
              </div>
            </Reveal>
          </div>
        </section>
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
        className="mt-2 w-full rounded-lg bg-surface-sunk px-3 py-2 font-mono text-[13px] text-ink ring-1 ring-line transition placeholder:text-ink-faint focus:ring-ink focus:outline-none"
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
