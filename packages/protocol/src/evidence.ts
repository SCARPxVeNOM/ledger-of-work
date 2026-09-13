/**
 * Reading the evidence off a receipt of any version.
 *
 * v2 and v3 put `finalUrl` inside `evidence`, beside two hashes, and v2 puts `capturedAt`
 * there too. Neither is a hash. So a schema describing evidence as named artifact
 * commitments cannot hold them — and typing it that way would reject receipts that are
 * already on the topic, which is a compatibility break hidden inside a generalisation.
 *
 * From v4 `finalUrl` is a field of its own, where it belonged: it is context about where
 * the capture ended up, not a commitment to a file anyone can re-hash.
 *
 * This reader is what keeps that difference from leaking. Everything downstream asks for
 * artifacts and gets artifacts, whatever version wrote the receipt, which is why the
 * verifier needs no version branch for evidence.
 */

export interface ReadEvidence {
  /** Named `sha256:<hex>` commitments. Empty when the receipt carries none. */
  artifacts: Record<string, string>;
  /** Where the capture actually ended up, when the receipt says. */
  finalUrl: string | undefined;
}

/** Fields that have lived in `evidence` without ever being artifact hashes. */
const NOT_ARTIFACTS = new Set(["finalUrl", "capturedAt"]);

export function readEvidence(receipt: {
  evidence?: Record<string, string | undefined> | undefined;
  finalUrl?: string | undefined;
}): ReadEvidence {
  const raw = receipt.evidence ?? {};
  const artifacts: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    // An absent value is not a commitment. Carrying it through as undefined would make
    // the verifier report "does not match" against nothing at all.
    if (NOT_ARTIFACTS.has(name) || value === undefined) continue;
    artifacts[name] = value;
  }

  // The v4 field wins when both are present, which only happens on a receipt written
  // during a migration. Preferring the newer one means the move can be made without a
  // flag day.
  return { artifacts, finalUrl: receipt.finalUrl ?? raw.finalUrl };
}
