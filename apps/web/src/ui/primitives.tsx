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
 * the main thread, and the element stops being watched once it has been shown. Reduced
 * motion is handled in the stylesheet rather than here, so the markup is identical either
 * way and nothing depends on reading a media query in JavaScript.
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
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
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

/**
 * A pill. The page's most repeated shape: announcements, badges, status, nav actions.
 *
 * `tone` rather than a colour prop, so a caller says what a thing *means* and the palette
 * stays in one file.
 */
export function Pill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "dark" | "pass" | "void" | "warn";
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-sunk text-ink-soft ring-1 ring-line",
    accent: "bg-accent-wash text-accent ring-1 ring-accent/15",
    dark: "bg-ink text-ink-invert",
    pass: "bg-pass/10 text-pass ring-1 ring-pass/20",
    void: "bg-void/10 text-void ring-1 ring-void/20",
    warn: "bg-warn/10 text-warn ring-1 ring-warn/20",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The small uppercase mono eyebrow that sits above a card's title. */
export function SectionLabel({
  n,
  children,
  className,
}: {
  n?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 font-mono text-[10.5px] tracking-[0.14em] text-ink-faint uppercase",
        className,
      )}
    >
      {n && <span className="text-ink-soft">{n}</span>}
      <span>{children}</span>
    </div>
  );
}

/**
 * A heading, in the grotesk that carries the whole page.
 *
 * Tight tracking is what makes a large sans read as a display face rather than as body
 * text that got bigger, and it has to get tighter as the size goes up.
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
    display: "text-display font-semibold",
    section: "text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.06] tracking-[-0.034em] font-semibold",
    sub: "text-[clamp(1.15rem,1.9vw,1.5rem)] leading-[1.2] tracking-[-0.022em] font-semibold",
  };
  return <Tag className={cx("text-ink text-balance", sizes[size], className)}>{children}</Tag>;
}

/**
 * The mono accent inside a heading.
 *
 * One word per headline, no more. It is the loudest decision on the page and it stops
 * being a signature the moment it appears twice in the same sentence.
 */
export function MonoAccent({ children }: { children: ReactNode }) {
  return <span className="font-mono font-medium tracking-[-0.03em]">{children}</span>;
}

/** Key/value pairs in mono — network, build, status and the like. */
export function MetadataRow({
  items,
  className,
}: {
  items: Array<{ k: string; v: ReactNode }>;
  className?: string;
}) {
  return (
    <dl
      className={cx("flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px]", className)}
    >
      {items.map((it) => (
        <div key={it.k} className="flex items-baseline gap-1.5">
          <dt className="text-ink-faint uppercase tracking-[0.1em]">{it.k}</dt>
          <dd className="text-ink-soft">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A white surface lifted off the ground by a hairline and a soft two-layer shadow.
 *
 * `interactive` and `selected` are separate on purpose: a card that is merely hoverable
 * and one that is currently chosen should not look the same, and a static card should not
 * pretend to be pressable.
 */
export function PaperCard({
  children,
  className,
  interactive = false,
  selected = false,
  dark = false,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  selected?: boolean;
  dark?: boolean;
  as?: "div" | "button" | "li";
} & Record<string, unknown>) {
  return (
    <Tag
      className={cx(
        "relative rounded-[var(--radius-card)] text-left transition-all duration-200",
        dark ? "bg-ink text-ink-invert" : "bg-surface text-ink ring-1",
        !dark && (selected ? "ring-ink" : "ring-line"),
        dark ? "shadow-[var(--shadow-lift)]" : "shadow-[var(--shadow-soft)]",
        interactive &&
          "cursor-pointer hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] active:translate-y-0",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** A ruled block for figures — values right-aligned in mono, one per row. */
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
      <SectionLabel>{title}</SectionLabel>
      <dl className="mt-4 divide-y divide-line">
        {rows.map((r, i) => (
          <div key={i} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="text-[13px] text-ink-soft">{r.k}</dt>
            <dd
              className={cx(
                "text-right font-mono text-[12.5px] tabular-nums break-all",
                r.accent ? "text-accent" : "text-ink",
              )}
            >
              {r.v}
            </dd>
          </div>
        ))}
      </dl>
      {footer && <div className="mt-5 border-t border-line pt-4">{footer}</div>}
    </PaperCard>
  );
}

/** A delivery receipt, rendered as a document rather than as a form. */
export function ReceiptCard({
  children,
  stamp,
  className,
}: {
  children: ReactNode;
  stamp?: { text: string; ok: boolean } | null;
  className?: string;
}) {
  const tone = !stamp
    ? "neutral"
    : stamp.text === "VOID"
      ? "void"
      : stamp.text === "PARTLY"
        ? "warn"
        : "pass";
  return (
    <PaperCard className={cx("overflow-hidden p-6", className)}>
      {stamp && (
        <div data-testid="stamp" className="stamp-in absolute top-5 right-5">
          <Pill tone={tone} className="font-mono tracking-[0.12em]">
            {stamp.text}
          </Pill>
        </div>
      )}
      {children}
    </PaperCard>
  );
}

/** The primary action. A pill, because everything pressable on this page is one. */
export function CTAButton({
  children,
  variant = "solid",
  full = false,
  size = "md",
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: "solid" | "ghost" | "quiet";
  full?: boolean;
  size?: "sm" | "md";
  /** Forwarded so tests can name a button without matching on its prose. */
  "data-testid"?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants = {
    solid: "bg-ink text-ink-invert hover:bg-ink/90 shadow-[var(--shadow-soft)]",
    ghost: "bg-surface text-ink ring-1 ring-line hover:ring-line-strong shadow-[var(--shadow-soft)]",
    quiet: "bg-transparent text-ink-soft hover:text-ink",
  };
  return (
    <button
      className={cx(
        "group inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-3.5 py-1.5 text-[12.5px]" : "px-5 py-2.5 text-[14px]",
        variants[variant],
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
  if (!label) return <hr className={cx("border-0 border-t border-line", className)} />;
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <span className="font-mono text-[10.5px] tracking-[0.14em] text-ink-faint uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-line" />
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
        "print-in grid grid-cols-[2rem_1fr_auto] items-baseline gap-3 py-1.5 font-mono text-[12.5px]",
        total && "mt-1 border-t border-line pt-2.5 font-semibold text-ink",
      )}
    >
      <span className="text-[11px] text-ink-faint tabular-nums">{n}</span>
      <span className="truncate text-ink-soft">{what}</span>
      <span className={cx("tabular-nums", total ? "text-ink" : "text-ink-soft")}>{cost}</span>
    </div>
  );
}

/** `+ something` — the list style the capability cards use. */
export function PlusList({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink-soft">
          <span aria-hidden className="text-ink-faint">
            +
          </span>
          <span className="min-w-0">{t}</span>
        </li>
      ))}
    </ul>
  );
}
