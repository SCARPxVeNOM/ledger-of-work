import { booksAdapter } from "./adapters/books.js";
import { govinfoAdapter } from "./adapters/govinfo.js";
import { virgoAdapter } from "./adapters/virgo.js";
import { quotesAdapter } from "./adapters/quotes.js";
import type { SiteAdapter } from "./types.js";

export { MAX_SOURCES, WorkMeter, type MeterOptions, type StepEvent } from "./meter.js";
export {
  DEFAULT_USER_AGENT,
  runJob,
  type Evidence,
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
  govinfoAdapter,
  parseDayLabel,
  type FederalRegisterIssue,
  type GovinfoParams,
} from "./adapters/govinfo.js";
export {
  parseHitText,
  virgoAdapter,
  type CatalogueRecord,
  type VirgoParams,
} from "./adapters/virgo.js";
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
  [govinfoAdapter.spec.name]: govinfoAdapter,
  [virgoAdapter.spec.name]: virgoAdapter,
};

export function getCapability(name: string) {
  return CATALOGUE[name];
}
