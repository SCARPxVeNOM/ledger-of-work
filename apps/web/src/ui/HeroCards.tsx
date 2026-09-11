import { Pill, SectionLabel, cx } from "./primitives.js";
import { FloatingCard } from "./magicui.js";

/**
 * The cards that rest around the hero.
 *
 * Built as markup rather than shipped as images, for two reasons. They carry the real
 * shapes the product deals in — a receipt, a checklist, a captured page — so a visitor
 * who reads them learns what the thing does before scrolling; and an image of a receipt
 * would go stale the first time the receipt format changed, which on this project it has
 * three times.
 *
 * Hidden below `xl`. At narrow widths they would either overlap the headline or shrink
 * into illegibility, and decoration that makes the words harder to read has failed.
 */

/** Perforated bottom edge, drawn rather than imaged so it stays crisp at any width. */
function Perforation({ dark = false }: { dark?: boolean }) {
  return (
    <div
      aria-hidden
      className="h-2.5"
      style={{
        background: `radial-gradient(circle at 6px 0, transparent 0 4px, ${
          dark ? "rgba(255,255,255,.14)" : "var(--color-line)"
        } 4px 4.6px, transparent 4.7px) repeat-x, linear-gradient(${
          dark ? "#272727" : "#fff"
        }, ${dark ? "#272727" : "#fff"})`,
        backgroundSize: "12px 10px, 100% 100%",
      }}
    />
  );
}

const sheet =
  "rounded-[var(--radius-card)] bg-surface ring-1 ring-line shadow-[var(--shadow-lift)]";

/** A delivery receipt, in miniature. */
export function MiniReceipt({ className }: { className?: string }) {
  return (
    <div className={cx("w-[280px] overflow-hidden", sheet, className)}>
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-semibold tracking-[-0.03em]">Ledger of Work</span>
          <span className="font-mono text-[10px] text-ink-faint">#8421</span>
        </div>
        <SectionLabel className="mt-3">receipt</SectionLabel>
        <dl className="mt-3 space-y-1.5 font-mono text-[10.5px]">
          {[
            ["JOB", "oracle.capture_claim"],
            ["WORK", "2 steps · 1 page"],
            ["AMOUNT", "321,000 tinybar"],
            ["RECORDED", "Hedera Consensus"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-ink-faint">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t border-dashed border-line pt-3 space-y-1.5">
          {[
            ["RESULT", "7f3a5e…c91d"],
            ["PAGE", "a3f9d2…e1b0"],
            ["PROOF", "reclaim://…"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="text-ink-faint">{k}</span>
              <span className="rounded bg-surface-sunk px-1.5 py-0.5 text-ink-soft">{v}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <span
            aria-hidden
            className="grid h-5 w-5 place-items-center rounded-full bg-pass text-[11px] text-white"
          >
            ✓
          </span>
          <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-soft uppercase">
            verified on hedera testnet
          </span>
        </div>
      </div>
      <Perforation />
    </div>
  );
}

/** The verification checklist, with its PASS badges. */
export function MiniChecks({ className }: { className?: string }) {
  const rows = [
    "Result hash matches",
    "Page hash matches",
    "Screenshot matches",
    "Payment settled",
    "Price from published book",
  ];
  return (
    <div className={cx("w-[268px] p-5", sheet, className)}>
      <div className="flex items-center justify-between">
        <SectionLabel>verification</SectionLabel>
        <span className="font-mono text-[10px] text-ink-faint">checks / 05</span>
      </div>
      <ul className="mt-4 space-y-2">
        {rows.map((r) => (
          <li key={r} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[11.5px] text-ink-soft">
              <span aria-hidden className="text-pass">
                ✓
              </span>
              {r}
            </span>
            <Pill tone="pass" className="px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em]">
              PASS
            </Pill>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-line pt-3 font-mono text-[9.5px] tracking-[0.12em] text-ink-faint uppercase">
        trust, but verify.
      </p>
    </div>
  );
}

/** The captured page — evidence, as a browser chrome mock. */
export function MiniEvidence({ className }: { className?: string }) {
  return (
    <div className={cx("w-[258px] overflow-hidden", sheet, className)}>
      <div className="px-4 pt-4">
        <SectionLabel>evidence / rendered page</SectionLabel>
      </div>
      <div className="mt-3 bg-ink px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
          <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
          <span className="h-2 w-2 rounded-full bg-[#28c840]" />
          <span className="ml-2 flex-1 truncate rounded bg-white/10 px-2 py-0.5 font-mono text-[9px] text-white/70">
            https://www.whitehouse.gov/…
          </span>
        </div>
      </div>
      <div className="space-y-1.5 p-4">
        <div className="h-1.5 w-4/5 rounded bg-surface-sunk" />
        <div className="h-1.5 w-full rounded bg-surface-sunk" />
        <div className="h-1.5 w-3/5 rounded bg-surface-sunk" />
        <div className="mt-2 h-14 rounded bg-surface-sunk" />
        <div className="h-1.5 w-2/3 rounded bg-surface-sunk" />
      </div>
      <div className="border-t border-line px-4 py-3 font-mono text-[9.5px] text-ink-faint">
        HASH (PAGE)
        <br />
        <span className="text-ink-soft">a3f9…d2e1</span>
      </div>
    </div>
  );
}

/** Hedera consensus, as a node diagram. */
export function MiniConsensus({ className }: { className?: string }) {
  const nodes = [
    [50, 14],
    [84, 36],
    [72, 74],
    [28, 74],
    [16, 36],
  ];
  return (
    <div className={cx("w-[220px] p-5", sheet, className)}>
      <SectionLabel>hedera testnet</SectionLabel>
      <p className="mt-1 font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase">
        consensus service
      </p>
      <svg viewBox="0 0 100 90" className="mt-3 w-full" aria-hidden>
        {nodes.map(([x1, y1], i) =>
          nodes.slice(i + 1).map(([x2, y2], j) => (
            <line
              key={`${i}-${j}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--color-line-strong)"
              strokeWidth="0.6"
            />
          )),
        )}
        {nodes.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="9" fill="var(--color-ink)" />
            <text
              x={x}
              y={y + 3}
              textAnchor="middle"
              fill="#fff"
              fontSize="8"
              fontFamily="var(--font-mono)"
            >
              H
            </text>
          </g>
        ))}
      </svg>
      <p className="mt-2 font-mono text-[9.5px] leading-relaxed tracking-[0.1em] text-ink-faint uppercase">
        public
        <br />
        distributed
        <br />
        verifiable
      </p>
    </div>
  );
}

/**
 * The collage, positioned around the hero.
 *
 * Absolutely placed and `pointer-events-none` on the container so the cards never sit
 * between a reader and the buttons; each card re-enables pointer events for its own hover.
 */
export function HeroCollage() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden xl:block">
      <FloatingCard rotate={-7} delay={0.15} drift={12} className="absolute top-[12%] left-[1%]">
        <MiniEvidence />
      </FloatingCard>

      <FloatingCard rotate={5} delay={0.3} drift={9} className="absolute top-[8%] right-[2%]">
        <MiniChecks />
      </FloatingCard>

      <FloatingCard rotate={4} delay={0.45} drift={14} className="absolute bottom-[2%] left-[4%]">
        <MiniConsensus />
      </FloatingCard>

      <FloatingCard rotate={-5} delay={0.6} drift={11} className="absolute right-[5%] bottom-[-2%]">
        <MiniReceipt />
      </FloatingCard>
    </div>
  );
}
