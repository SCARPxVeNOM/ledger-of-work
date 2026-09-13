import { canonical } from "./canonical.js";
import type { Receipt, Signature } from "./types.js";

/**
 * Binding a receipt to whoever asserted it.
 *
 * ── Why this is needed at all ───────────────────────────────────────────────────
 * Until now the seller was also the submitter, so HCS submission *was* the
 * authentication. `payer_account_id` on a topic message is a fact nobody can forge, and
 * the verifier checked it against the account the seller was expected to publish from.
 * That check is doing real work and it costs nothing.
 *
 * It stops working the moment anything submits on the seller's behalf. Then that field
 * names the relay, for every seller at once, and a check that used to identify the author
 * identifies only the postman.
 *
 * A detached signature over the canonical bytes replaces it, and proves strictly more:
 * who *asserted* the receipt, rather than who happened to hand it to the network.
 *
 * ── Why no key appears in this file ─────────────────────────────────────────────
 * `sign` and `verify` are supplied by the caller. The only correct home for a private key
 * is the process that owns it, and this module is shared verbatim with the browser
 * verifier — which must never be in a position to hold one.
 */

/**
 * Exactly the bytes a signature covers: the receipt without its own signature.
 *
 * Obvious once stated and easy to get wrong in a way that is not caught by testing
 * against yourself. Signing the whole object means the signature covers itself, so
 * verifying requires the receipt as it looked *before* signing — which nobody reading it
 * off the topic can reconstruct. The receipt would verify only for whoever still had the
 * unsigned draft, which is to say, only for the seller.
 *
 * `canonical` rather than `JSON.stringify`, so two implementations that build the same
 * receipt with their fields in a different order still sign the same bytes.
 */
export function signingBytes(receipt: Receipt): string {
  const { sig: _excluded, ...rest } = receipt as Receipt & { sig?: Signature };
  return canonical(rest);
}

/** Return a copy of the receipt carrying a signature. The input is not modified. */
export function signReceipt(
  receipt: Receipt,
  opts: { alg: Signature["alg"]; by: string; sign: (bytes: string) => string },
): Receipt {
  return {
    ...receipt,
    sig: { alg: opts.alg, by: opts.by, sig: opts.sign(signingBytes(receipt)) },
  };
}

/**
 * True only when the receipt carries a signature and it verifies over the right bytes.
 *
 * An unsigned receipt is `false` rather than an exception: most receipts on the topic
 * predate signing, and a verifier that threw on them could not read its own history. The
 * caller decides what absence means — for a relayed receipt it is fatal, for a v3 one it
 * is simply how things were.
 */
export function verifySignature(
  receipt: Receipt,
  verify: (bytes: string, sig: string) => boolean,
): boolean {
  const sig = (receipt as Receipt & { sig?: Signature }).sig;
  if (!sig?.sig) return false;
  try {
    return verify(signingBytes(receipt), sig.sig);
  } catch {
    // A malformed signature is an unverified receipt, not a crash in the verifier. The
    // verifier is the thing a sceptic runs; it does not get to fall over on bad input.
    return false;
  }
}
