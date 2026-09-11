import { cx } from "./primitives.js";

/**
 * The dark status bar: what the agent is doing, how far through it is.
 *
 * Taken from the reference, and deliberately wired to the real meter rather than
 * animated on a timer. The segments are steps the worker has actually reported over SSE,
 * and the label is the step it is on — so when it says "extracting", something is
 * extracting. A progress bar that advances on a `setInterval` is a picture of a progress
 * bar, and on a page arguing that you should not have to take the seller's word for
 * anything, that would be a strange thing to ship.
 *
 * Sits half-overlapping the panel above it, the way the reference does — enough to read
 * as attached to the job rather than as a separate widget.
 */
export function AgentBar({
  state,
  label,
  done,
  total,
  idleLabel = "quote a job to start",
}: {
  /**
   * Three states, not two. A finished job is not an idle one: the segments are still lit
   * and the count still reads 3 / 3, so calling it "idle" contradicts what is next to it.
   */
  state: "idle" | "working" | "done";
  /** The step currently being performed, or the last one performed. */
  label: string;
  done: number;
  total: number;
  idleLabel?: string;
}) {
  const running = state === "working";
  // Always render the same number of segments so the bar does not change width as a job
  // progresses; only how many are lit changes.
  const segments = Math.max(total, 8);
  const lit = Math.min(segments, done);

  return (
    <div className="rounded-full bg-ink px-5 py-3 text-ink-invert shadow-[var(--shadow-lift)]">
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className={cx(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            state === "working"
              ? "animate-pulse bg-[#ff5f57]"
              : state === "done"
                ? "bg-[#28c840]"
                : "bg-white/25",
          )}
        />

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9.5px] tracking-[0.16em] text-white/45 uppercase">
            {state === "working" ? "agent working" : state === "done" ? "job complete" : "agent idle"}
          </p>
          <p className="truncate text-[13px] font-medium">
            {state === "idle" ? idleLabel : label}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-[3px] sm:flex" aria-hidden>
          {Array.from({ length: segments }, (_, i) => (
            <span
              key={i}
              className={cx(
                "h-4 w-[5px] rounded-[1px] transition-colors duration-300",
                i < lit ? "bg-white" : "bg-white/20",
              )}
            />
          ))}
        </div>

        <div className="shrink-0 text-right">
          <p className="font-mono text-[15px] leading-none tabular-nums">
            {done} / {total || "—"}
          </p>
          <p className="mt-1 font-mono text-[9px] tracking-[0.14em] text-white/45 uppercase">
            steps
          </p>
        </div>
      </div>
    </div>
  );
}
