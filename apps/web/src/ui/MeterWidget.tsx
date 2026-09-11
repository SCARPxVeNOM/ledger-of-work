import { useEffect, useRef, useState } from "react";
import { cx, TimelineRow } from "./primitives.js";

export interface MeterLine {
  n?: string;
  what: string;
  cost: string;
  total?: boolean;
}

/**
 * Count toward a target instead of snapping to it.
 *
 * Amounts are integer tinybars held as strings, because they come off the ledger and a
 * float would quietly round them. The animation works in `Number` for the sixteen frames
 * it is on screen and then lands on the exact string — so what is *displayed* while
 * moving is approximate, and what is displayed at rest is the real figure.
 */
function useCountUp(target: string, ms = 420): string {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const raf = useRef(0);

  useEffect(() => {
    const start = Number(from.current);
    const end = Number(target);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
      setShown(target);
      from.current = target;
      return;
    }

    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      // Ease out cubic: fast at first, settling rather than stopping.
      const eased = 1 - (1 - p) ** 3;
      if (p >= 1) {
        setShown(target);
        from.current = target;
        return;
      }
      setShown(String(Math.round(start + (end - start) * eased)));
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);

  return shown;
}

const group = (n: string) => {
  try {
    return BigInt(n).toLocaleString("en-US");
  } catch {
    return n;
  }
};

/**
 * The meter — a terminal crossed with a ledger tape.
 *
 * The number is the point of the section, so it is set at display size in mono and
 * everything else defers to it. The tape below is what makes the number believable: each
 * line is one step the worker actually performed, priced as it happened.
 */
export function MeterWidget({
  amount,
  unit,
  caption,
  lines,
  running,
  progress,
}: {
  amount: string;
  unit: string;
  caption: string;
  lines: MeterLine[];
  running: boolean;
  /** 0–1, or null when there is nothing to be partway through. */
  progress: number | null;
}) {
  const shown = useCountUp(amount);
  const tapeRef = useRef<HTMLDivElement>(null);
  const [pulse, setPulse] = useState(0);

  useEffect(() => setPulse((p) => p + 1), [amount]);

  // Keep the newest line in view without yanking the page around.
  useEffect(() => {
    const el = tapeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="border border-rule bg-paper-raised">
      <div className="flex items-center justify-between border-b border-rule px-5 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          the meter, live
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em]">
          <span
            className={cx(
              "inline-block h-1.5 w-1.5 rounded-full",
              running ? "animate-pulse bg-accent" : "bg-ink-faint",
            )}
            aria-hidden
          />
          <span className={running ? "text-accent" : "text-ink-faint"}>
            {running ? "metering" : "idle"}
          </span>
        </span>
      </div>

      <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="border-b border-rule px-6 py-7 md:border-r md:border-b-0">
          <div
            key={pulse}
            data-testid="meter-amount"
            className="ticking font-mono text-[clamp(2.25rem,6vw,3.75rem)] leading-none tracking-tight tabular-nums"
            aria-live="polite"
          >
            {group(shown)}
          </div>
          <div className="mt-2 font-mono text-[11px] leading-snug uppercase tracking-[0.14em] text-ink-faint">
            {unit}
            <br />
            {caption}
          </div>

          {/* Progress. Indeterminate while running with no plan to measure against —
              a bar that sits at zero reads as broken rather than as unknown. */}
          <div className="mt-6 h-px w-full bg-rule" aria-hidden>
            <div
              className={cx("h-px bg-accent transition-all duration-500", running && "opacity-90")}
              style={{ width: progress === null ? (running ? "100%" : "0%") : `${progress * 100}%` }}
            />
          </div>
        </div>

        <div
          ref={tapeRef}
          className="max-h-[19rem] min-h-[11rem] overflow-y-auto px-5 py-4"
          style={{
            backgroundImage:
              "repeating-linear-gradient(var(--color-paper-raised) 0 27px, var(--color-rule-soft) 27px 27.5px)",
          }}
        >
          {lines.length === 0 ? (
            <p className="py-2 font-mono text-[12.5px] text-ink-faint">
              nothing metered yet — quote a job, then run it
            </p>
          ) : (
            lines.map((l, i) => (
              <TimelineRow
                key={i}
                {...(l.n !== undefined ? { n: l.n } : {})}
                what={l.what}
                cost={group(l.cost)}
                total={Boolean(l.total)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
