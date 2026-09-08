import type { ServerResponse } from "node:http";
import type { StepEvent } from "@low/worker";

export type JobEvent =
  | { type: "step"; label: string; steps: number; pages: number; sessionMs: number }
  | { type: "done"; steps: number; pages: number; sessionMs: number; charged: string }
  | { type: "failed"; message: string };

/**
 * Server-sent events for one job's progress.
 *
 * The demo UI shows the meter climbing as the work happens. That has to be the real
 * meter — the same counter that produces the price and goes into the receipt — or the
 * demo would be theatre for a project whose entire claim is that its numbers are honest.
 *
 * Events are replayed to a late subscriber because the UI has an inherent race: it must
 * POST the paid run before it can watch it, and the first step can land before the
 * EventSource connects.
 */
export class JobEventStream {
  readonly #history: JobEvent[] = [];
  readonly #subscribers = new Set<ServerResponse>();
  #ended = false;

  emit(event: JobEvent): void {
    if (this.#ended) return;
    this.#history.push(event);
    for (const res of this.#subscribers) this.#write(res, event);
    if (event.type === "done" || event.type === "failed") this.end();
  }

  fromStep(event: StepEvent): void {
    this.emit({ type: "step", ...event });
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    for (const event of this.#history) this.#write(res, event);
    if (this.#ended) {
      res.end();
      return;
    }
    this.#subscribers.add(res);
    res.on("close", () => this.#subscribers.delete(res));
  }

  end(): void {
    this.#ended = true;
    for (const res of this.#subscribers) res.end();
    this.#subscribers.clear();
  }

  #write(res: ServerResponse, event: JobEvent): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* a disconnected watcher must not affect the job */
    }
  }
}

/** Streams live only while a job runs; entries are dropped once it ends. */
export class JobEventRegistry {
  readonly #streams = new Map<string, JobEventStream>();

  /**
   * Get the stream for a job, creating it if this is the first reference.
   *
   * Both the watcher and the job itself call this, and the watcher usually gets here
   * first: a browser subscribes as soon as it kicks off the paid request, but that
   * request has to travel through the demo server and a 402 round trip before the job
   * exists. Requiring the job to have started would 404 the subscriber every time, which
   * is exactly the bug this replaced.
   */
  ensure(jobId: string): JobEventStream {
    let stream = this.#streams.get(jobId);
    if (!stream) {
      stream = new JobEventStream();
      this.#streams.set(jobId, stream);
    }
    return stream;
  }

  get(jobId: string): JobEventStream | undefined {
    return this.#streams.get(jobId);
  }

  close(jobId: string): void {
    this.#streams.get(jobId)?.end();
    // Kept briefly so a UI that subscribes late still receives the replayed history.
    setTimeout(() => this.#streams.delete(jobId), 30_000).unref();
  }
}
