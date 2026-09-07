/**
 * Resolve Hedera account IDs from ECDSA private keys.
 *
 * A Hedera account is identified by its account id (0.0.x), which is *not* derivable
 * from the key the way an EVM address is. But an ECDSA key does determine an EVM
 * address, and the mirror node indexes accounts by that address — so given a key we can
 * find the account, if one has been created and funded for it.
 *
 * Read-only. Prints account ids, balances and key types. Never prints a private key.
 */
import "dotenv/config";
import { PrivateKey } from "@hiero-ledger/sdk";

const MIRROR = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1";

/** Accepts hex with or without 0x, and DER. Tries ECDSA first — the scheme requires it. */
function parseKey(raw) {
  const trimmed = raw.trim().replace(/^0x/i, "");
  try {
    return { key: PrivateKey.fromStringECDSA(trimmed), type: "ECDSA" };
  } catch {
    /* fall through */
  }
  try {
    return { key: PrivateKey.fromStringED25519(trimmed), type: "ED25519" };
  } catch (err) {
    throw new Error(`could not parse as ECDSA or ED25519: ${err.message}`);
  }
}

async function lookup(evmAddress) {
  const res = await fetch(`${MIRROR}/accounts/${evmAddress}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node ${res.status} for ${evmAddress}`);
  return res.json();
}

const roles = [
  ["seller", process.env.seller ?? process.env.SELLER_PRIVATE_KEY],
  ["buyer", process.env.buyer ?? process.env.BUYER_PRIVATE_KEY],
];

let missing = 0;

for (const [role, raw] of roles) {
  if (!raw) {
    console.log(`${role.padEnd(7)} no key found in .env`);
    missing++;
    continue;
  }

  let parsed;
  try {
    parsed = parseKey(raw);
  } catch (err) {
    console.log(`${role.padEnd(7)} UNPARSEABLE — ${err.message}`);
    missing++;
    continue;
  }

  const evm = `0x${parsed.key.publicKey.toEvmAddress()}`;
  const account = await lookup(evm);

  if (!account) {
    console.log(`${role.padEnd(7)} ${parsed.type}  ${evm}`);
    console.log(`${"".padEnd(7)} NO ACCOUNT on this network for that address.`);
    console.log(
      `${"".padEnd(7)} The key is valid but no account has been created for it — fund it at https://portal.hedera.com`,
    );
    missing++;
    continue;
  }

  const hbar = (Number(account.balance?.balance ?? 0) / 1e8).toFixed(8);
  const keyType = account.key?._type ?? "unknown";
  const tokens = account.balance?.tokens?.length ?? 0;

  // The mirror node spells these ECDSA_SECP256K1 / ED25519; the SDK parser says
  // ECDSA / ED25519. Normalise before comparing, or every account looks mismatched.
  const onChainFamily = keyType.startsWith("ECDSA") ? "ECDSA" : keyType;
  const mismatch = onChainFamily !== parsed.type;

  console.log(`${role.padEnd(7)} ${account.account}`);
  console.log(`${"".padEnd(7)} evm      ${evm}`);
  console.log(`${"".padEnd(7)} key      ${keyType}${mismatch ? `  (local key parsed as ${parsed.type} — MISMATCH)` : ""}`);
  console.log(`${"".padEnd(7)} balance  ${hbar} HBAR${tokens ? `, ${tokens} token association(s)` : ""}`);

  if (keyType !== "ECDSA_SECP256K1") {
    console.log(
      `${"".padEnd(7)} WARNING: the Hedera x402 exact scheme recovers the signature against the account key. ED25519 will fail with InvalidSignature.`,
    );
  }
  if (Number(hbar) === 0) {
    console.log(`${"".padEnd(7)} WARNING: zero balance — cannot pay or cover fees.`);
  }
}

process.exit(missing ? 1 : 0);
