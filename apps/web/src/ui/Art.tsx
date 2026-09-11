import { motion } from "motion/react";
import { cx } from "./primitives.js";

/**
 * The artwork.
 *
 * These are the project's own illustrations — the receipt, the live job, the paper — and
 * they carry a palette of their own: cream stock, dark green, a red accent. The page
 * around them is deliberately quiet so that they are the only place colour appears.
 *
 * Every one is decorative in the accessibility sense: the thing each depicts exists for
 * real further down the page, in live form. So they are `alt=""` where a live counterpart
 * follows, and described where they stand alone.
 */

const SRC = {
  collage: { one: "/art/collage-640.webp", two: "/art/collage-1280.webp", w: 1153, h: 1364 },
  livejob: { one: "/art/livejob-760.webp", two: "/art/livejob-1520.webp", w: 1291, h: 1218 },
  paper: { one: "/art/paper-560.webp", two: "/art/paper-1120.webp", w: 1223, h: 1286 },
  decision: { one: "/art/decision-760.webp", two: "/art/decision-1520.webp", w: 1588, h: 991 },
} as const;

/**
 * A responsive art asset.
 *
 * Width and height are always given so the browser reserves the right box before the
 * bytes arrive — without them each image lands and shoves the page down under the
 * reader's eyes.
 */
export function Art({
  name,
  sizes,
  className,
  alt = "",
  priority = false,
}: {
  name: keyof typeof SRC;
  /** What width this will actually be displayed at, so the browser picks the right file. */
  sizes: string;
  className?: string;
  alt?: string;
  priority?: boolean;
}) {
  const s = SRC[name];
  return (
    <img
      src={s.one}
      srcSet={`${s.one} 1x, ${s.two} 2x`}
      sizes={sizes}
      width={s.w}
      height={s.h}
      alt={alt}
      // The hero image is the largest thing on first paint; everything else can wait until
      // the reader is on their way to it.
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      {...(priority ? { fetchPriority: "high" as const } : {})}
      className={cx("h-auto w-full select-none", className)}
      draggable={false}
    />
  );
}

/**
 * Artwork that drifts, and straightens when you look at it.
 *
 * The same motion as the reference's floating cards, applied to a whole illustration
 * rather than to markup: a slow vertical breath, a resting tilt, and a lift to flat on
 * hover so a reader who wants to study the receipt can.
 */
export function FloatingArt({
  children,
  rotate = -4,
  delay = 0,
  drift = 12,
  className,
}: {
  children: React.ReactNode;
  rotate?: number;
  delay?: number;
  drift?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={cx("will-change-transform", className)}
      initial={{ opacity: 0, y: 28, rotate }}
      animate={{ opacity: 1, y: [0, -drift, 0], rotate }}
      transition={{
        opacity: { duration: 0.8, delay },
        rotate: { duration: 0.8, delay },
        y: { duration: 8 + drift / 4, delay, repeat: Infinity, ease: "easeInOut" },
      }}
      whileHover={{ rotate: 0, scale: 1.02, transition: { duration: 0.4 } }}
    >
      {children}
    </motion.div>
  );
}
