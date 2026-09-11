import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The shared vocabulary of the page.
 *
 * Every one of these exists because the same shape appears in three or more places. A
 * component that appears once is a section, not a primitive, and lives with its section.
 */

/** Join class names, dropping anything falsy, so callers can pass conditionals inline. */
export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

/**
 * Reveal children when they first scroll into view.
 *
 * One observer per element rather than a scroll listener: the browser does the work off
 * the main thread, and the element stops being watched once it has been shown. Respects
 * `prefers-reduced-motion` through the stylesheet rather than here, so the markup is the
 * same either way.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cx("reveal", shown && "shown", className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** `01 — Overview`. The numbered editorial marker that opens every section. */
export function SectionLabel({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
      <span className="text-accent">{n}</span>
      <span className="h-px w-6 bg-rule" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/**
 * The serif voice of the page.
 *
 * `as` rather than a fixed tag because the visual weight of a heading and its place in
 * the document outline are different questions — the hero is the only `h1`, but several
 * sections want to look nearly as loud.
 */
export function EditorialHeading({
  children,
  as: Tag = "h2",
  size = "section",
  className,
}: {
  children: ReactNode;
  as?: "h1" | "h2" | "h3";
  size?: "display" | "section" | "sub";
  className?: string;
}) {
  const sizes = {
    display: "text-display",
    section: "text-[clamp(2rem,4.2vw,3.4rem)] leading-[0.98] tracking-[-0.018em]",
    sub: "text-[clamp(1.4rem,2.4vw,2rem)] leading-[1.05] tracking-[-0.012em]",
  };
  return (
    <Tag className={cx("font-serif font-normal text-ink text-balance", sizes[size], className)}>
      {children}
    </Tag>
  );
}

/** Key/value pairs in mono — the row that carries network, build, status and the like. */
export function MetadataRow({
  items,
  className,
}: {
  items: Array<{ k: string; v: ReactNode }>;
  className?: string;
}) {
  return (
    <dl
      className={cx(
        "flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em]",
        className,
      )}
    >
      {items.map((it) => (
        <div key={it.k} className="flex items-baseline gap-2">
          <dt className="text-ink-faint">{it.k}</dt>
          <dd className="text-ink">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A sheet of paper. Thin rule, no shadow at rest, a small lift on hover.
 *
 * `interactive` is separate from `selected` on purpose: a card that is merely hoverable
 * and one that is currently chosen should not look the same, and a static card should not
 * pretend to be clickable.
 */
export function PaperCard({
  children,
  className,
  interactive = false,
  selected = false,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  selected?: boolean;
  as?: "div" | "button" | "li";
} & Record<string, unknown>) {
  return (
    <Tag
      className={cx(
        "relative border bg-paper-raised transition-all duration-200",
        selected ? "border-ink" : "border-rule",
        interactive &&
          "cursor-pointer hover:-translate-y-0.5 hover:border-ink-soft hover:shadow-[0_1px_0_var(--color-rule),0_10px_24px_-18px_rgba(23,20,15,0.45)]",
        className,
      )}
      {...rest}
    >
      {/* The border highlight: a hairline that grows from the left edge on hover. */}
      {interactive && (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-x-0 top-0 h-px origin-left bg-accent transition-transform duration-300",
            selected ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100",
          )}
        />
      )}
      {children}
    </Tag>
  );
}

/** A ruled block for figures — the ledger look, values right-aligned in mono. */
export function LedgerCard({
  title,
  rows,
  footer,
  className,
}: {
  title: ReactNode;
  rows: Array<{ k: ReactNode; v: ReactNode; accent?: boolean }>;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <PaperCard className={cx("p-6", className)}>
      <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">{title}</h3>
      <dl className="mt-5 divide-y divide-rule-soft">
        {rows.map((r, i) => (
          <div key={i} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="font-mono text-[11px] uppercase tracking-[0.09em] text-ink-soft">
              {r.k}
            </dt>
            <dd
              className={cx(
                "text-right font-mono text-[13px] tabular-nums break-all",
                r.accent ? "text-accent" : "text-ink",
              )}
            >
              {r.v}
            </dd>
          </div>
        ))}
      </dl>
      {footer && <div className="mt-5 border-t border-rule pt-4">{footer}</div>}
    </PaperCard>
  );
}

/**
 * A printed transaction receipt.
 *
 * The torn edge is drawn with a repeating radial gradient rather than an image, so it
 * stays crisp at any width and costs nothing to load.
 */
export function ReceiptCard({
  children,
  stamp,
  className,
}: {
  children: ReactNode;
  stamp?: { text: string; ok: boolean } | null;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <div className="relative overflow-hidden border border-rule bg-paper-raised px-6 pt-6 pb-8">
        {stamp && (
          <div
            data-testid="stamp"
            className={cx(
              "stamp-in pointer-events-none absolute top-6 right-5 border-[3px] px-3 py-1 font-mono text-[13px] font-semibold tracking-[0.18em] uppercase",
              stamp.ok ? "border-pass text-pass" : "border-void text-void",
            )}
          >
            {stamp.text}
          </div>
        )}
        {children}
      </div>
      {/* Perforation. */}
      <div
        aria-hidden
        className="h-3 border-x border-rule"
        style={{
          background:
            "radial-gradient(circle at 7px 0, transparent 0 5px, var(--color-rule) 5px 5.6px, transparent 5.7px) repeat-x, linear-gradient(var(--color-paper), var(--color-paper))",
          backgroundSize: "14px 12px, 100% 100%",
        }}
      />
    </div>
  );
}

/** The primary action. Flat, bordered, with a small shove on press. */
export function CTAButton({
  children,
  variant = "solid",
  full = false,
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: "solid" | "ghost";
  full?: boolean;
  /** Forwarded so tests can name a button without matching on its prose. */
  "data-testid"?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "group relative inline-flex items-center justify-center gap-2.5 border px-6 py-3.5",
        "font-mono text-[11px] uppercase tracking-[0.16em] transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-35",
        variant === "solid"
          ? "border-ink bg-ink text-paper shadow-[3px_3px_0_var(--color-rule)] enabled:hover:-translate-x-px enabled:hover:-translate-y-px enabled:hover:shadow-[4px_4px_0_var(--color-rule)] enabled:active:translate-x-0.5 enabled:active:translate-y-0.5 enabled:active:shadow-[1px_1px_0_var(--color-rule)]"
          : "border-rule bg-transparent text-ink enabled:hover:border-ink",
        full && "w-full",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A hairline, optionally carrying a label in the margin. */
export function Divider({ label, className }: { label?: string; className?: string }) {
  if (!label) return <hr className={cx("border-0 border-t border-rule", className)} />;
  return (
    <div className={cx("flex items-center gap-4", className)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  );
}

/** One step of the meter's tape: index, what happened, running cost. */
export function TimelineRow({
  n,
  what,
  cost,
  total = false,
}: {
  n?: string;
  what: ReactNode;
  cost: ReactNode;
  total?: boolean;
}) {
  return (
    <div
      className={cx(
        "print-in grid grid-cols-[2.25rem_1fr_auto] items-baseline gap-3 py-1.5 font-mono text-[12.5px]",
        total && "mt-1 border-t border-ink pt-2.5 font-semibold",
      )}
    >
      <span className="text-[11px] text-ink-faint tabular-nums">{n}</span>
      <span className="truncate text-ink">{what}</span>
      <span className={cx("tabular-nums", total ? "text-ink" : "text-ink-soft")}>{cost}</span>
    </div>
  );
}
