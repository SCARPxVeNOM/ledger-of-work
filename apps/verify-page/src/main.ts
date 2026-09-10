import { checkCoverage, type RetrievalProof } from "@low/proof/portable";
import {
  canonical,
  isHbar,
  verifyReceipt,
  type AssetSpec,
  type CheckResult,
  type MirrorTopicMessage,
  type MirrorTransaction,
  type PriceBook,
  type Receipt,
} from "@low/protocol/portable";
import { PRICE_BOOKS } from "@low/worker/pricebooks";

/**
 * The verifier, as a page with no backend.
 *
 * This exists so that checking a receipt costs a stranger nothing: no install, no
 * account, no trust in us. It reads the public Hedera mirror node directly from the
 * browser — which is keyless and CORS-open — so nothing here talks to the seller at any
 * point. Open it, paste a topic and sequence number, drop in the result file you were
 * given, and see for yourself.
 *
 * It shares `verifyReceipt` verbatim with the CLI rather than reimplementing the checks.
 * Two verifiers would eventually disagree, and a disagreement between two things that
 * both claim to prove delivery is worse than having only one.
 */

const MIRROR_DEFAULT = "https://testnet.mirrornode.hedera.com/api/v1";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();

/**
 * SHA-256 over the canonical encoding, using Web Crypto.
 *
 * The Node build hashes with `node:crypto`; both take the hash over the *same* canonical
 * bytes, which is the only thing that has to match. Encoding is shared code, so the two
 * cannot drift.
 */
async function hashCanonicalBrowser(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/** SHA-256 over raw bytes — page HTML and screenshots are opaque, not structured data. */
async function sha256Browser(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Sort the dropped files by what they actually are, not by what they are called.
 *
 * A buyer renames files. Sniffing the content means the page works when they do, and —
 * more importantly — a JSON file is only treated as a proof if it has the shape of one,
 * so dropping the result file twice cannot silently stand in for a proof that was never
 * supplied.
 */
async function sortArtifacts(files: File[]): Promise<{
  pageHash?: string;
  screenshotHash?: string;
  proof?: RetrievalProof;
}> {
  const out: { pageHash?: string; screenshotHash?: string; proof?: RetrievalProof } = {};
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const head = new TextDecoder().decode(buffer.slice(0, 512)).trimStart();

    // PNG's magic number. Screenshots are the artifact a human actually looks at.
    const bytes = new Uint8Array(buffer.slice(0, 8));
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      out.screenshotHash = await sha256Browser(buffer);
      continue;
    }

    if (head.startsWith("{")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(buffer)) as RetrievalProof;
        if (parsed?.claim?.parameters && parsed?.signatures?.attestorAddress) out.proof = parsed;
      } catch {
        /* not a proof; ignore rather than fail the whole verification */
      }
      continue;
    }

    // Anything else textual is treated as the page. Hashed as raw bytes, exactly as the
    // seller hashed it — canonicalising it here would guarantee a mismatch.
    out.pageHash = await sha256Browser(buffer);
  }
  return out;
}

/** REST wants `0.0.x-secs-nanos`; the SDK prints `0.0.x@secs.nanos` and REST 400s on it. */
function toRestTxId(txId: string): string {
  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(txId)) return txId;
  const [account, ts] = txId.split("@");
  if (!account || !ts) throw new Error(`unrecognised transaction id "${txId}"`);
  return `${account}-${ts.replace(".", "-")}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return (await res.json()) as T;
}

function render(checks: CheckResult[], ok: boolean, evidence: string[]): void {
  const list = $("checks");
  list.innerHTML = "";
  checks.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = `chk ${c.ok ? "pass" : "fail"}`;
    row.style.animationDelay = `${i * 55}ms`;
    row.innerHTML =
      '<span class="verdict"></span><span><span class="label"></span><br><span class="detail"></span></span>';
    (row.querySelector(".verdict") as HTMLElement).textContent = c.ok ? "PASS" : "FAIL";
    (row.querySelector(".label") as HTMLElement).textContent = c.label;
    (row.querySelector(".detail") as HTMLElement).textContent = c.detail;
    list.append(row);
  });

  const stamp = $("stamp");
  stamp.className = "stamp";
  setTimeout(() => {
    stamp.textContent = ok ? "VERIFIED" : "VOID";
    stamp.className = `stamp show ${ok ? "ok" : "void"}`;
  }, checks.length * 55 + 120);

  const ev = $("evidence");
  ev.innerHTML = "";
  for (const url of evidence) {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener";
    ev.append(a);
  }
  $("result-panel").hidden = false;
}

async function run(): Promise<void> {
  $("error").textContent = "";
  $("result-panel").hidden = true;

  const topicId = val("topic");
  const seq = Number(val("seq"));
  const submitter = val("submitter");
  const mirror = val("mirror") || MIRROR_DEFAULT;
  const capability = val("capability");

  if (!topicId || !seq || !submitter) {
    $("error").textContent = "Topic, sequence number and submitter account are all required.";
    return;
  }

  const file = (document.getElementById("result") as HTMLInputElement).files?.[0];
  if (!file) {
    $("error").textContent = "Choose the result file you were given.";
    return;
  }

  let result: unknown;
  try {
    result = JSON.parse(await file.text());
  } catch {
    $("error").textContent = `${file.name} is not valid JSON.`;
    return;
  }

  ($("go") as HTMLButtonElement).disabled = true;
  try {
    const message = await getJson<MirrorTopicMessage>(
      `${mirror}/topics/${topicId}/messages/${seq}`,
    );

    // Peek for the settlement id so the payment checks can run. A parse failure here is
    // left for verifyReceipt to report properly rather than thrown.
    let transaction: MirrorTransaction | undefined;
    let txUrl: string | undefined;
    let receiptFinalUrl: string | undefined;
    try {
      const peeked = JSON.parse(atob(message.message)) as Receipt;
      receiptFinalUrl = peeked.evidence?.finalUrl;
      if (peeked.payment?.txId) {
        txUrl = `${mirror}/transactions/${toRestTxId(peeked.payment.txId)}`;
        const body = await getJson<{ transactions: (MirrorTransaction & { nonce?: number })[] }>(txUrl);
        transaction = body.transactions?.find((t) => t.nonce === 0) ?? body.transactions?.[0];
      }
    } catch {
      /* reported by the checks below */
    }

    const priceBook: PriceBook | undefined = capability ? PRICE_BOOKS[capability] : undefined;

    // A token settlement needs the published rate to check the meter.
    let asset: AssetSpec | undefined;
    const assetId = val("asset");
    if (assetId && !isHbar(assetId)) {
      asset = {
        id: assetId,
        symbol: val("assetSymbol") || "TOKEN",
        decimals: Number(val("assetDecimals") || 2),
        unitsPerTinybar: val("assetRate") || "0.001",
      };
    }

    const artifacts = await sortArtifacts([
      ...((document.getElementById("artifacts") as HTMLInputElement).files ?? []),
    ]);

    // The retrieval questions this page can answer without the attestor library: is this
    // the proof the receipt committed to, and does it cover the answer? The signature
    // itself is left to the CLI, and reported as unchecked rather than assumed.
    const proofHash = artifacts.proof
      ? await hashCanonicalBrowser(artifacts.proof)
      : undefined;
    const coverage =
      artifacts.proof && receiptFinalUrl
        ? checkCoverage({
            proof: artifacts.proof,
            expectedUrl: receiptFinalUrl,
            answer: JSON.stringify(result),
          })
        : undefined;

    const out = verifyReceipt({
      resultHash: await hashCanonicalBrowser(result),
      message,
      expectedSubmitter: submitter,
      ...(artifacts.pageHash ? { pageHash: artifacts.pageHash } : {}),
      ...(artifacts.screenshotHash ? { screenshotHash: artifacts.screenshotHash } : {}),
      ...(proofHash ? { retrievalProofHash: proofHash } : {}),
      ...(coverage ? { retrievalCoverage: coverage } : {}),
      ...(priceBook ? { priceBook } : {}),
      ...(asset ? { asset } : {}),
      ...(transaction ? { transaction } : {}),
    });

    render(out.checks, out.ok, [
      `${mirror}/topics/${topicId}/messages/${seq}`,
      ...(txUrl ? [txUrl] : []),
      `https://hashscan.io/testnet/topic/${topicId}`,
    ]);
  } catch (err) {
    $("error").textContent = (err as Error).message;
  } finally {
    ($("go") as HTMLButtonElement).disabled = false;
  }
}

// Prefill from every price book ever published, including retired capabilities — a
// receipt on the ledger stays verifiable after the thing that produced it stops selling.
const capSelect = document.getElementById("capability") as HTMLSelectElement;
for (const name of Object.keys(PRICE_BOOKS)) {
  const o = document.createElement("option");
  o.value = name;
  o.textContent = name;
  capSelect.append(o);
}

// A topic/seq in the query string makes a receipt shareable as a link.
const params = new URLSearchParams(location.search);
for (const key of ["topic", "seq", "submitter", "capability", "asset"]) {
  const v = params.get(key);
  if (v) (document.getElementById(key) as HTMLInputElement).value = v;
}

$("go").addEventListener("click", () => void run());
