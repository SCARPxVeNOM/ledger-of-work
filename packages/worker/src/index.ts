import { booksAdapter } from "./adapters/books.js";
import { quotesAdapter } from "./adapters/quotes.js";
import type { SiteAdapter } from "./types.js";

export { MAX_SOURCES, WorkMeter, type MeterOptions, type StepEvent } from "./meter.js";
export {
  DEFAULT_USER_AGENT,
  runJob,
  type RunResult,
  type RuntimeOptions,
} from "./runtime.js";
export {
  BadParamsError,
  JobAbortedError,
  type CapabilitySpec,
  type JobContext,
  type Meter,
  type Plan,
  type SiteAdapter,
} from "./types.js";
export {
  CATEGORIES,
  booksAdapter,
  parseBooks,
  type Book,
  type BooksParams,
} from "./adapters/books.js";
export {
  parseQuotes,
  quotesAdapter,
  type Quote,
  type QuotesParams,
} from "./adapters/quotes.js";

/**
 * The capability catalogue.
 *
 * This is what makes the service discoverable: another agent reads the manifest built
 * from these specs, sees what is for sale and what each unit of work costs, and can
 * compute a price before asking — no API key and no prior relationship.
 */
// biome-ignore lint/suspicious/noExplicitAny: adapters are heterogeneous by design
export const CATALOGUE: Record<string, SiteAdapter<any, any>> = {
  [quotesAdapter.spec.name]: quotesAdapter,
  [booksAdapter.spec.name]: booksAdapter,
};

export function getCapability(name: string) {
  return CATALOGUE[name];
}
