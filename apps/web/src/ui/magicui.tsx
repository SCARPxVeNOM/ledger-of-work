import { useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import {
  motion,
  useInView,
  useMotionValue,
  useSpring,
  type MotionStyle,
  type Transition,
} from "motion/react";
import { cx } from "./primitives.js";

/**
 * Magic UI components, ported in.
 *
 * Magic UI is MIT and distributed to be copied into a project rather than installed as a
 * package — its own CLI assumes Next.js and shadcn, and this app is esbuild and Tailwind
 * v4 with no `@/lib/utils`. So these are the upstream implementations with two changes:
 * `cn` becomes our `cx`, and the colours default to this palette instead of Magic UI's
 * orange-to-purple, which would be the one loud thing on an otherwise quiet page.
 *
 * Source: https://magicui.design/docs/components
 */

/**
 * A beam of light travelling around a container's border.
 *
 * Used on the selected capability card and on the receipt while it is being verified —
 * places where something is *happening* and a static border would not say so.
 */
export function BorderBeam({
  className,
  size = 60,
  delay = 0,
  duration = 7,
  colorFrom = "#272727",
  colorTo = "#8e8e93",
  transition,
  style,
  reverse = false,
  initialOffset = 0,
  borderWidth = 1.5,
}: {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  transition?: Transition;
  className?: string;
  style?: React.CSSProperties;
  reverse?: boolean;
  initialOffset?: number;
  borderWidth?: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent [mask-clip:padding-box,border-box] mask-intersect mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)]"
      style={{ "--border-beam-width": `${borderWidth}px` } as React.CSSProperties}
    >
      <motion.div
        className={cx(
          "absolute aspect-square",
          "bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent",
          className,
        )}
        style={
          {
            width: size,
            offsetPath: `rect(0 auto auto 0 round ${size}px)`,
            "--color-from": colorFrom,
            "--color-to": colorTo,
            ...style,
          } as MotionStyle
        }
        initial={{ offsetDistance: `${initialOffset}%` }}
        animate={{
          offsetDistance: reverse
            ? [`${100 - initialOffset}%`, `${-initialOffset}%`]
            : [`${initialOffset}%`, `${100 + initialOffset}%`],
        }}
        transition={{ repeat: Infinity, ease: "linear", duration, delay: -delay, ...transition }}
      />
    </div>
  );
}

/**
 * A number that springs to its value rather than snapping.
 *
 * Upstream starts only when scrolled into view and once. That is kept: the meter's own
 * figure updates on every step and animates each time, but the summary statistics further
 * down should count up once, when the reader reaches them, and then hold still.
 */
export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}: {
  value: number;
  startValue?: number;
  direction?: "up" | "down";
  delay?: number;
  decimalPlaces?: number;
} & ComponentPropsWithoutRef<"span">) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(direction === "down" ? value : startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { once: true, margin: "0px" });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (isInView) {
      timer = setTimeout(() => {
        motionValue.set(direction === "down" ? startValue : value);
      }, delay * 1000);
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [motionValue, isInView, delay, value, direction, startValue]);

  useEffect(
    () =>
      springValue.on("change", (latest) => {
        if (ref.current) {
          ref.current.textContent = Intl.NumberFormat("en-US", {
            minimumFractionDigits: decimalPlaces,
            maximumFractionDigits: decimalPlaces,
          }).format(Number(latest.toFixed(decimalPlaces)));
        }
      }),
    [springValue, decimalPlaces],
  );

  return (
    <span ref={ref} className={cx("inline-block tabular-nums", className)} {...props}>
      {startValue}
    </span>
  );
}

/** A row that scrolls forever. Used for the strip of recent receipts. */
export function Marquee({
  className,
  reverse = false,
  pauseOnHover = false,
  children,
  vertical = false,
  repeat = 4,
  ...props
}: {
  className?: string;
  reverse?: boolean;
  pauseOnHover?: boolean;
  children: ReactNode;
  vertical?: boolean;
  repeat?: number;
} & ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cx(
        "group flex gap-(--gap) overflow-hidden p-2 [--duration:40s] [--gap:1rem]",
        vertical ? "flex-col" : "flex-row",
        className,
      )}
    >
      {Array(repeat)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className={cx(
              "flex shrink-0 justify-around gap-(--gap)",
              vertical ? "animate-marquee-vertical flex-col" : "animate-marquee flex-row",
              pauseOnHover && "group-hover:[animation-play-state:paused]",
              reverse && "[animation-direction:reverse]",
            )}
          >
            {children}
          </div>
        ))}
    </div>
  );
}

/**
 * A card that drifts, and tilts toward the pointer.
 *
 * Not a Magic UI component — it is the motif from the reference: cards resting at an
 * angle around the hero, breathing slightly. Kept here beside the others because it is
 * the same kind of thing, and because it needs `motion` too.
 *
 * `whileHover` lifts the card flat and forward, so a thing that looks like a photograph
 * on a desk becomes readable when you go to read it.
 */
export function FloatingCard({
  children,
  className,
  rotate = -6,
  delay = 0,
  drift = 10,
}: {
  children: ReactNode;
  className?: string;
  rotate?: number;
  delay?: number;
  drift?: number;
}) {
  return (
    <motion.div
      className={cx("pointer-events-auto", className)}
      initial={{ opacity: 0, y: 24, rotate }}
      animate={{
        opacity: 1,
        y: [0, -drift, 0],
        rotate,
      }}
      transition={{
        opacity: { duration: 0.7, delay },
        rotate: { duration: 0.7, delay },
        y: {
          duration: 7 + drift / 4,
          delay,
          repeat: Infinity,
          ease: "easeInOut",
        },
      }}
      whileHover={{ rotate: 0, scale: 1.03, y: -14, transition: { duration: 0.35 } }}
    >
      {children}
    </motion.div>
  );
}
