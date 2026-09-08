import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HBAR, priceTinybars, tinybarToAssetUnits, type AssetSpec } from "@low/protocol";
import { CATALOGUE, BadParamsError, getCapability } from "@low/worker";
import { ReceiptPublisher } from "@low/receipts";
import { chromium, type Browser } from "playwright";
import { FacilitatorClient, type PaymentPayload } from "./facilitator.js";
import { JobEventRegistry } from "./events.js";
import { PaymentRejectedError, QuoteStore, executeJob } from "./jobs.js";

export interface SellerConfig {
  port: number;
  network: string;
  facilitatorUrl: string;
  facilitatorApiKey?: string | undefined;
  sellerAccountId: string;
  sellerPrivateKey: string;
  topicId: string;
  publicUrl?: string;
  /** Optional HTS asset a buyer may pay in instead of HBAR. */
  paymentToken?: AssetSpec | undefined;
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

  // One browser for the process. Launching Chromium costs ~300ms that no buyer should
  // be billed for; each job still gets its own isolated context.
  const browser: Browser = await chromium.launch({ headless: true });
  const quotes = new QuoteStore();
  const events = new JobEventRegistry();
  const sweeper = setInterval(() => quotes.sweep(), 60_000);
  sweeper.unref();

  const base = config.publicUrl ?? `http://localhost:${config.port}`;

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
    receipts: {
      topicId: config.topicId,
      submitter: config.sellerAccountId,
      explorer: `https://hashscan.io/testnet/topic/${config.topicId}`,
      schema: "https://github.com/SCARPxVeNOM/ledger-of-work#receipt-v1",
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
      return send(res, 200, manifest());
    }

    if (path === "/health") {
      return send(res, 200, {
        ok: true,
        facilitator: await facilitator.health(),
        topicId: config.topicId,
        openQuotes: quotes.size,
      });
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

      const plan = adapter.plan(params);
      const amount = priceTinybars(
        { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
        adapter.spec.priceBook,
      );
      // Prices are metered in tinybars; a non-HBAR asset converts at its published rate
      // so a buyer can reproduce the number from the manifest alone.
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

      return send(res, 200, {
        jobId: quote.jobId,
        capability,
        params,
        plan: { steps: plan.steps, pages: plan.pages, outline: plan.outline },
        price: {
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
          browser,
          sellerAccountId: config.sellerAccountId,
          network: config.network,
          onStep: (e) => stream.fromStep(e),
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
          receipt: receiptBlock,
          price: {
            unit: "tinybar",
            quoted: outcome.receipt.price.quoted,
            charged: outcome.receipt.price.charged,
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

  await new Promise<void>((resolve) => server.listen(config.port, resolve));

  return {
    server,
    port: config.port,
    feePayer,
    async close() {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
      publisher.close();
    },
  };
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
