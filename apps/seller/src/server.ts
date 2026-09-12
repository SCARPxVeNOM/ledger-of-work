import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  HBAR,
  RECEIPT_VERSION,
  priceTinybars,
  tinybarToAssetUnits,
  type AssetSpec,
} from "@low/protocol";
import { CATALOGUE, BadParamsError, getCapability } from "@low/worker";
import { ReceiptPublisher } from "@low/receipts";
import { chromium, type Browser } from "playwright";
import { agentUaid, buildAgentCard, SKILL_TAGS } from "@low/identity";
import { FacilitatorClient, type PaymentPayload } from "./facilitator.js";
import { JobEventRegistry } from "./events.js";
import { PaymentRejectedError, executeJob } from "./jobs.js";
import { QuoteStore } from "./quote-store.js";
import { renderLanding } from "./landing.js";
import { A2AServer } from "./a2a.js";

/**
 * Part of the HCS-14 identifier, so bumping it renames the agent.
 *
 * That is the intended behaviour — a different version of a service is a different agent
 * as far as discovery is concerned — but it means this is not a number to change idly.
 */
const SERVICE_VERSION = "0.1.0";

export interface SellerConfig {
  port: number;
  network: string;
  facilitatorUrl: string;
  facilitatorApiKey?: string | undefined;
  sellerAccountId: string;
  sellerPrivateKey: string;
  topicId: string;
  publicUrl?: string;
  /** Where to persist outstanding quotes so a restart does not drop price commitments. */
  quoteStorePath?: string | undefined;
  /** HFS file holding this manifest, so a buyer can check it without trusting us. */
  agentCardFileId?: string | undefined;
  /** Optional HTS asset a buyer may pay in instead of HBAR. */
  paymentToken?: AssetSpec | undefined;
  /**
   * Owns the retrieval proofs this seller produces. Absent, jobs run exactly as before
   * and receipts simply carry no third-party witness.
   */
  zkOwnerKey?: string | undefined;
}

export async function startSeller(config: SellerConfig) {
  const facilitator = new FacilitatorClient({
    url: config.facilitatorUrl,
    network: config.network,
    apiKey: config.facilitatorApiKey,
  });
  const feePayer = await facilitator.initialise();

  const publisher = new ReceiptPublisher({
    network: config.network.split(":")[1] ?? "testnet",
    accountId: config.sellerAccountId,
    privateKey: config.sellerPrivateKey,
    topicId: config.topicId,
  });

  /**
   * One browser for the process, started on the first job rather than at boot.
   *
   * Still one browser: launching Chromium costs ~300ms that no buyer should be billed
   * for, and each job gets its own isolated context off it. What changed is *when*.
   *
   * Launching at startup made the browser a condition of the service existing at all. If
   * Chromium cannot start — wrong image, no shared memory, too little RAM on a small
   * container — the process died before it could bind a port or answer `/health`, so the
   * one thing that could have said what was wrong was the thing that never ran. A
   * platform then reports "deploy failed" with no logs, which is indistinguishable from
   * a dozen other faults.
   *
   * Now the service starts, `/health` answers, and a browser failure is reported by the
   * job that needed it, with the real error attached.
   */
  let browser: Browser | null = null;
  async function getBrowser(): Promise<Browser> {
    // `isConnected` guards the case where Chromium died mid-life: relaunch rather than
    // hand a dead handle to the next job.
    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({ headless: true });
    }
    return browser;
  }
  const quotes = new QuoteStore({ path: config.quoteStorePath });
  const events = new JobEventRegistry();
  const sweeper = setInterval(() => quotes.sweep(), 60_000);
  sweeper.unref();

  const base = config.publicUrl ?? `http://localhost:${config.port}`;

  /**
   * This service's HCS-14 universal agent id.
   *
   * Derived from what the service *is* — its name, version, protocol and Hedera account —
   * rather than from where it happens to be hosted. Two agents that meet it through
   * different channels, or after it moves host, compute the same identifier without
   * consulting any registry.
   *
   * Deliberately not derived from `base`: an identifier that changes when the URL changes
   * is an address wearing an identifier's clothes.
   */
  const uaid = agentUaid({
    registry: "ledger-of-work",
    name: "Ledger of Work",
    version: SERVICE_VERSION,
    protocol: "a2a",
    nativeId: `hedera:${config.network.split(":")[1] ?? "testnet"}:${config.sellerAccountId}`,
    skills: SKILL_TAGS,
  });

  /**
   * The capability manifest — the discoverability half of the pitch.
   *
   * Another agent reads this, sees what is for sale, what each unit of work costs, and
   * where receipts are published. It can compute a price itself before asking, and pay
   * with no prior relationship and no API key.
   */
  const assets: AssetSpec[] = config.paymentToken ? [HBAR, config.paymentToken] : [HBAR];
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const manifest = () => ({
    name: "Ledger of Work",
    /** HCS-14. The stable name for this agent; the URL is only where it is today. */
    uaid,
    description:
      "Pay-per-job access to websites that cannot be turned into an API, with a receipt anyone can verify.",
    x402Version: 2,
    payment: {
      network: config.network,
      scheme: "exact",
      payTo: config.sellerAccountId,
      facilitator: config.facilitatorUrl,
      feePayer,
      /** Prices are published in tinybars; each asset declares its own conversion. */
      priceUnit: "tinybar",
      assets: assets.map((a) => ({
        asset: a.id,
        symbol: a.symbol,
        decimals: a.decimals,
        unitsPerTinybar: a.unitsPerTinybar,
        note:
          a.id === HBAR.id
            ? "native HBAR, no association needed"
            : "HTS token — payTo must have associated it",
      })),
    },
    ...(config.agentCardFileId
      ? {
          agentCard: {
            fileId: config.agentCardFileId,
            service: "hedera-file-service",
            explorer: `https://hashscan.io/testnet/file/${config.agentCardFileId}`,
            note: "the same catalogue and price books, committed on chain — check the prices you were quoted against it",
          },
        }
      : {}),
    receipts: {
      topicId: config.topicId,
      submitter: config.sellerAccountId,
      explorer: `https://hashscan.io/testnet/topic/${config.topicId}`,
      // Stated as a number from the constant rather than baked into the link, which is
      // how it went stale: this advertised `#receipt-v1` while emitting v3, at an anchor
      // that had also stopped existing. A buyer reading the manifest to decide which
      // schema to parse was being told the wrong answer twice.
      schemaVersion: RECEIPT_VERSION,
      schema: "https://github.com/SCARPxVeNOM/ledger-of-work#what-the-receipt-proves-and-what-it-does-not",
    },
    capabilities: Object.values(CATALOGUE).map((a) => ({
      name: a.spec.name,
      site: a.spec.site,
      description: a.spec.description,
      priceBook: a.spec.priceBook,
      limits: a.spec.limits,
      quote: `${base}/jobs`,
    })),
  });

  /**
   * The rate card, if every capability charges the same.
   *
   * Checked rather than assumed. They are identical today — the four price books differ
   * only in their ceiling — and stating it once is honest where a per-row "from" price
   * printed the same number four times and implied a choice. If the books ever diverge
   * this returns undefined on its own and the rows go back to quoting themselves.
   */
  const sharedRates = () => {
    const books = Object.values(CATALOGUE).map((a) => a.spec.priceBook);
    const [first] = books;
    if (!first) return undefined;
    const same = books.every(
      (b) =>
        b.base === first.base &&
        b.perStep === first.perStep &&
        b.perPage === first.perPage &&
        b.perSecond === first.perSecond,
    );
    return same
      ? {
          base: first.base,
          perStep: first.perStep,
          perPage: first.perPage,
          perSecond: first.perSecond,
        }
      : undefined;
  };

  /**
   * Mint a quote. The single place a price becomes a commitment.
   *
   * Shared with the A2A endpoint on purpose: a negotiated job and a directly quoted one
   * must be the same job, priced by the same code and stored in the same place. Two
   * paths to a quote would be two price books eventually.
   */
  async function mintQuote(capability: string, params: unknown, assetId: string) {
    const adapter = getCapability(capability);
    if (!adapter) throw new Error(`unknown capability ${capability}`);
    const asset = assetById.get(assetId);
    if (!asset) throw new Error(`unsupported asset ${assetId}`);

    // Refusals that need a lookup — a host that resolves somewhere private, a path the
    // site disallows — happen here, so a buyer learns before signing rather than after.
    if (adapter.precheck) await adapter.precheck(params);

    const plan = adapter.plan(params);
    const amount = priceTinybars(
      { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
      adapter.spec.priceBook,
    );
    const assetAmount = tinybarToAssetUnits(amount, asset);
    const quote = quotes.create(
      capability,
      params,
      { steps: plan.steps, pages: plan.pages, estimatedMs: plan.estimatedMs, outline: plan.outline },
      amount,
      adapter.spec.priceBook,
      asset,
      assetAmount,
    );
    return { quote, adapter, asset, plan, amount, assetAmount };
  }

  const a2a = new A2AServer({
    assets: [...assetById.keys()],
    quote: async (capability, params, assetId) => {
      const { quote, amount } = await mintQuote(capability, params, assetId);
      return {
        jobId: quote.jobId,
        run: `${base}/jobs/${quote.jobId}/run`,
        amount,
        expiresAt: quote.expiresAt,
      };
    },
  });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      send(res, 500, { error: "internal", message: (err as Error).message });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // CORS: the verifier and demo page must be able to call this from a browser.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-payment, payment-signature");
    if (req.method === "OPTIONS") return send(res, 204, null);

    if (path === "/" || path === "/.well-known/x402" || path === "/manifest") {
      // Content negotiation, and only at `/`. The two well-known paths are addressed by
      // software that went looking for a specific document, so they stay JSON whatever
      // the Accept header says; `/` is the one a person is liable to open by hand.
      //
      // The test is `text/html` appearing *before* any JSON preference, which is what a
      // browser sends and what an agent does not. A client sending `*/*` — curl, fetch
      // with no headers, most SDKs — falls through to JSON, so nothing that works today
      // changes.
      if (path === "/" && prefersHtml(req.headers.accept)) {
        const m = manifest();
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        // Same resource, two representations: say so, or a cache may hand the HTML to an
        // agent that asked for JSON.
        res.setHeader("vary", "accept");
        res.end(
          renderLanding({
            name: m.name,
            description: m.description,
            uaid,
            account: config.sellerAccountId,
            network: config.network,
            topicId: config.topicId,
            facilitator: m.payment.facilitator,
            baseUrl: base,
            capabilities: Object.values(CATALOGUE).map((a) => ({
              name: a.spec.name,
              description: a.spec.description,
              site: a.spec.site,
              fromTinybar: priceTinybars(
                { steps: 1, pages: 1, sessionMs: 1000 },
                a.spec.priceBook,
              ),
              ceilingTinybar: a.spec.priceBook.ceiling,
            })),
            sharedRates: sharedRates(),
          }),
        );
        return;
      }
      res.setHeader("vary", "accept");
      return send(res, 200, manifest());
    }

    // The same service, described the way A2A clients expect to find it. RFC 8615 path,
    // generated from the same specs the seller prices and executes from — a hand-written
    // card is a second copy of the catalogue, and a second copy drifts until an agent
    // discovers a skill that no longer exists.
    if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") {
      return send(
        res,
        200,
        buildAgentCard({
          baseUrl: base,
          uaid,
          account: config.sellerAccountId,
          receiptsTopic: config.topicId,
          network: config.network,
          version: SERVICE_VERSION,
          capabilities: Object.values(CATALOGUE).map((a) => ({
            name: a.spec.name,
            description: a.spec.description,
            site: a.spec.site,
            // The floor: base plus one step, one page, one second. A number an agent can
            // rank providers by without paying for a quote round trip first.
            fromTinybar: priceTinybars({ steps: 1, pages: 1, sessionMs: 1000 }, a.spec.priceBook),
          })),
        }),
      );
    }

    if (path === "/health") {
      return send(res, 200, {
        ok: true,
        facilitator: await facilitator.health(),
        // Whether the browser has been needed yet, and whether it is alive. A seller
        // reporting healthy while unable to launch Chromium would be lying by omission.
        browser: browser ? (browser.isConnected() ? "ready" : "disconnected") : "not started",
        topicId: config.topicId,
        openQuotes: quotes.size,
      });
    }

    // --- negotiate -------------------------------------------------------------
    // A2A JSON-RPC. Messages until terms are agreed; then a run URL and x402 as usual.
    if (path === "/a2a" && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 200, await a2a.handle(body));
    }

    // --- quote -----------------------------------------------------------------
    if (path === "/jobs" && req.method === "POST") {
      const body = await readJson(req);
      const capability = (body as { capability?: string }).capability ?? "";
      const assetId = (body as { asset?: string }).asset ?? HBAR.id;
      const asset = assetById.get(assetId);
      if (!asset) {
        return send(res, 400, { error: "unsupported_asset", supported: [...assetById.keys()] });
      }
      const adapter = getCapability(capability);
      if (!adapter) {
        return send(res, 404, {
          error: "unknown_capability",
          available: Object.keys(CATALOGUE),
        });
      }

      let params: unknown;
      try {
        params = adapter.normalise((body as { params?: unknown }).params);
      } catch (err) {
        if (err instanceof BadParamsError) {
          return send(res, 400, { error: "bad_params", message: err.message });
        }
        throw err;
      }

      // Through `mintQuote`, the same function the A2A endpoint uses. This route used to
      // price and store quotes itself, which is two implementations of one price.
      let minted;
      try {
        minted = await mintQuote(capability, params, asset.id);
      } catch (err) {
        if (err instanceof BadParamsError) {
          return send(res, 400, { error: "bad_params", message: err.message });
        }
        throw err;
      }
      const { plan, amount, assetAmount, quote } = minted;

      return send(res, 200, {
        jobId: quote.jobId,
        capability,
        params,
        plan: { steps: plan.steps, pages: plan.pages, outline: plan.outline },
        price: {
          /** The meter always counts in tinybars; `assetAmount` is what gets signed. */
          unit: "tinybar",
          amount,
          asset: asset.id,
          assetSymbol: asset.symbol,
          assetAmount,
          priceBook: adapter.spec.priceBook,
        },
        expiresAt: quote.expiresAt,
        run: `${base}/jobs/${quote.jobId}/run`,
        events: `${base}/jobs/${quote.jobId}/events`,
      });
    }

    // --- live progress ---------------------------------------------------------
    // The UI subscribes here while the paid POST runs, so the meter it shows is the one
    // actually producing the price.
    const eventsMatch = /^\/jobs\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && req.method === "GET") {
      const streamJobId = eventsMatch[1] as string;
      // Only for a quote we actually issued, so a bogus id cannot grow the registry.
      if (!quotes.get(streamJobId) && !events.get(streamJobId)) {
        return send(res, 404, { error: "no_such_job" });
      }
      events.ensure(streamJobId).subscribe(res);
      return;
    }

    // --- pay and run -----------------------------------------------------------
    const runMatch = /^\/jobs\/([^/]+)\/run$/.exec(path);
    if (runMatch && req.method === "POST") {
      const jobId = runMatch[1] as string;
      const quote = quotes.get(jobId);
      if (!quote) {
        return send(res, 404, { error: "unknown_or_expired_quote", message: "request a fresh quote" });
      }

      const adapter = getCapability(quote.capability);
      if (!adapter) return send(res, 500, { error: "capability_disappeared" });

      const requirements = facilitator.requirements(
        quote.assetAmount,
        config.sellerAccountId,
        quote.asset.id,
      );
      const header = req.headers["payment-signature"] ?? req.headers["x-payment"];

      // No payment yet: issue the 402 challenge with everything needed to pay.
      if (!header) {
        res.setHeader("payment-required", JSON.stringify({ x402Version: 2, accepts: [requirements] }));
        return send(res, 402, {
          x402Version: 2,
          accepts: [requirements],
          jobId,
          plan: quote.plan,
          hint: "sign a TransferTransaction whose transactionId.accountId is extra.feePayer, then retry with the base64 payload in PAYMENT-SIGNATURE",
        });
      }

      let payload: PaymentPayload;
      try {
        payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf8")) as PaymentPayload;
      } catch {
        return send(res, 400, { error: "bad_payment_header", message: "expected base64 JSON" });
      }

      // Consume only once we have a payment to act on, so a malformed header does not
      // burn the buyer's quote.
      quotes.consume(jobId);

      const stream = events.ensure(jobId);

      try {
        const outcome = await executeJob(quote, payload, requirements, {
          adapter,
          facilitator,
          publisher,
          browser: await getBrowser(),
          sellerAccountId: config.sellerAccountId,
          network: config.network,
          onStep: (e) => stream.fromStep(e),
          ...(config.zkOwnerKey ? { zkOwnerKey: config.zkOwnerKey } : {}),
        });

        stream.emit(
          outcome.ok
            ? {
                type: "done",
                steps: outcome.receipt.work.steps,
                pages: outcome.receipt.work.pages,
                sessionMs: outcome.receipt.work.sessionMs,
                charged: outcome.receipt.price.charged,
              }
            : { type: "failed", message: outcome.error ?? "job failed" },
        );
        events.close(jobId);

        const receiptBlock = {
          topicId: outcome.locator.topicId,
          sequenceNumber: outcome.locator.sequenceNumber,
          explorer: `https://hashscan.io/testnet/topic/${outcome.locator.topicId}`,
          verify: `verify --topic ${outcome.locator.topicId} --seq ${outcome.locator.sequenceNumber} --result ./result.json`,
        };

        if (!outcome.ok) {
          // The job failed, so nothing was settled — but a receipt exists either way.
          return send(res, 502, {
            error: "job_failed",
            message: outcome.error,
            charged: "0",
            receipt: receiptBlock,
            work: outcome.receipt.work,
          });
        }

        res.setHeader(
          "payment-response",
          JSON.stringify({ success: true, transaction: outcome.receipt.payment.txId }),
        );
        return send(res, 200, {
          result: outcome.result,
          // The buyer needs these to check the evidence hashes themselves; without them
          // the receipt's evidence commitment is unfalsifiable, which is the opposite of
          // the point.
          ...(outcome.artifacts ? { artifacts: outcome.artifacts } : {}),
          ...(outcome.retrievalProof ? { retrievalProof: outcome.retrievalProof } : {}),
          evidence: outcome.receipt.evidence,
          receipt: receiptBlock,
          price: {
            // The denomination actually settled, not the one the meter counts in. These
            // differ whenever the buyer paid in a token, and labelling a WORK amount
            // "tinybar" is the kind of small lie that makes a receipt untrustworthy.
            unit: outcome.receipt.price.unit,
            quoted: outcome.receipt.price.quoted,
            charged: outcome.receipt.price.charged,
            /** What the meter counted, before conversion — always tinybars. */
            meteredTinybar: quote.amount,
          },
          plan: outcome.receipt.plan,
          work: outcome.receipt.work,
          payment: outcome.receipt.payment,
        });
      } catch (err) {
        stream.emit({ type: "failed", message: (err as Error).message });
        events.close(jobId);
        if (err instanceof PaymentRejectedError) {
          return send(res, 402, { error: "payment_rejected", reason: err.reason, message: err.message });
        }
        throw err;
      }
    }

    return send(res, 404, { error: "not_found", path });
  }

  // Bind every interface. Node's default binds `::` only, which a platform proxy
  // connecting over IPv4 cannot reach — the service looks healthy in its own logs while
  // every request from outside returns 502.
  await new Promise<void>((resolve) =>
    server.listen(config.port, process.env.HOST ?? "0.0.0.0", resolve),
  );

  return {
    server,
    port: config.port,
    feePayer,
    async close() {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (browser) await browser.close().catch(() => {});
      publisher.close();
    },
  };
}

/**
 * Does this client want a page rather than the document?
 *
 * Browsers send an Accept list headed by `text/html`; agents send `application/json`, or
 * `*​/*`, or nothing. So the question is not "is html mentioned" — `*​/*` technically
 * mentions everything — but "is html asked for ahead of json", which is true of a browser
 * address bar and false of every programmatic client.
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  // The q-value and any other parameters are dropped; only the order matters here.
  const types = accept.split(",").map((t) => (t.split(";")[0] ?? "").trim().toLowerCase());
  const html = types.indexOf("text/html");
  if (html === -1) return false;
  const json = types.findIndex((t) => t === "application/json" || t.endsWith("+json"));
  return json === -1 || html < json;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  if (body === null) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
