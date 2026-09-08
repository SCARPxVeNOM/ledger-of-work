/**
 * One-time setup for the HTS payment asset.
 *
 * Creates a stablecoin-shaped fungible token, associates the buyer with it, and funds
 * the buyer. Run once, then put the printed token id in .env as PAYMENT_TOKEN_ID.
 *
 * Why HTS at all: the Hedera exact scheme takes an `asset` that is either "0.0.0" for
 * HBAR or an HTS token id, and `@x402/hedera` re-exports TokenAssociateTransaction for
 * exactly this. An agent holding a stablecoin should be able to pay in it rather than
 * being forced to hold the network's volatile native asset — which is the realistic
 * shape of agent-to-agent commerce.
 */
import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const network = process.env.HEDERA_NETWORK ?? "testnet";
const sellerId = AccountId.fromString(process.env.SELLER_ACCOUNT_ID);
const sellerKey = PrivateKey.fromStringECDSA(process.env.SELLER_PRIVATE_KEY.replace(/^0x/i, ""));
const buyerId = AccountId.fromString(process.env.BUYER_ACCOUNT_ID);
const buyerKey = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY.replace(/^0x/i, ""));

const client = Client.forName(network).setOperator(sellerId, sellerKey);

/** Two decimals, like a fiat-denominated stablecoin. Amounts stay integers throughout. */
const DECIMALS = 2;
const INITIAL_SUPPLY = 1_000_000_00; // 1,000,000.00 WORK

try {
  // --- create -------------------------------------------------------------------
  const created = await (
    await new TokenCreateTransaction()
      .setTokenName("Ledger of Work Credit")
      .setTokenSymbol("WORK")
      .setTokenType(TokenType.FungibleCommon)
      .setDecimals(DECIMALS)
      .setInitialSupply(INITIAL_SUPPLY)
      .setTreasuryAccountId(sellerId)
      .setSupplyType(TokenSupplyType.Infinite)
      .setAdminKey(sellerKey.publicKey)
      .setSupplyKey(sellerKey.publicKey)
      .setTokenMemo("x402 payment asset for ledger-of-work")
      .freezeWith(client)
      .sign(sellerKey)
  ).execute(client);

  const receipt = await created.getReceipt(client);
  if (receipt.tokenId === null) throw new Error("token create returned no token id");
  const tokenId = receipt.tokenId.toString();
  console.log(`created token  ${tokenId}  (WORK, ${DECIMALS} decimals)`);

  // --- associate the buyer ------------------------------------------------------
  // Unlike HBAR, an HTS token cannot be received by an account that has not associated
  // it. Skipping this is what produces TOKEN_NOT_ASSOCIATED_TO_ACCOUNT at settlement,
  // after the buyer has already signed — so it belongs in setup, not in the hot path.
  await (
    await (
      await new TokenAssociateTransaction()
        .setAccountId(buyerId)
        .setTokenIds([receipt.tokenId])
        .freezeWith(client)
        .sign(buyerKey)
    ).execute(client)
  ).getReceipt(client);
  console.log(`associated     ${buyerId} with ${tokenId}`);

  // --- fund the buyer -----------------------------------------------------------
  const grant = 10_000_00; // 10,000.00 WORK
  await (
    await (
      await new TransferTransaction()
        .addTokenTransfer(receipt.tokenId, sellerId, -grant)
        .addTokenTransfer(receipt.tokenId, buyerId, grant)
        .freezeWith(client)
        .sign(sellerKey)
    ).execute(client)
  ).getReceipt(client);
  console.log(`funded buyer   ${(grant / 10 ** DECIMALS).toFixed(2)} WORK`);

  console.log(`\nadd to .env:\n  PAYMENT_TOKEN_ID=${tokenId}`);
  console.log(`\nhashscan: https://hashscan.io/testnet/token/${tokenId}`);
} finally {
  client.close();
}
