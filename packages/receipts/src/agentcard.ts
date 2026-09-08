import {
  AccountId,
  Client,
  FileAppendTransaction,
  FileContentsQuery,
  FileCreateTransaction,
  FileId,
  FileUpdateTransaction,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { canonical } from "@low/protocol";

/**
 * The capability manifest, published to Hedera File Service.
 *
 * Serving the manifest over HTTPS makes discovery depend on the seller's web server
 * being up and honest. Publishing it to HFS instead means a buyer can read what is for
 * sale and what it costs straight from the ledger — and, more usefully, can check that
 * the prices they were quoted match the prices the seller committed to publicly, without
 * taking the seller's word for either.
 *
 * That matters because the verifier's meter check needs the price book. Reading it from
 * the same server that produced the receipt would be circular: a seller could quote one
 * price book and verify against another. An on-chain card closes that loop.
 */

/** HFS caps a single transaction's contents; anything larger is appended in chunks. */
const FILE_CHUNK_BYTES = 4096;

export interface AgentCardOptions {
  network?: string;
  accountId: string;
  privateKey: string;
}

function clientFor(options: AgentCardOptions): { client: Client; key: PrivateKey } {
  const key = PrivateKey.fromStringECDSA(options.privateKey.replace(/^0x/i, ""));
  const client = Client.forName(options.network ?? "testnet").setOperator(
    AccountId.fromString(options.accountId),
    key,
  );
  return { client, key };
}

/**
 * Publish a manifest and return its file id.
 *
 * An admin key is set so the card can be updated when the catalogue or prices change.
 * That is a deliberate trade: an immutable card would be a stronger commitment, but a
 * price book that can never change is not a product. The receipt's consensus timestamp
 * is what pins which version of the card applied to a given job.
 */
export async function publishAgentCard(
  manifest: unknown,
  options: AgentCardOptions,
): Promise<string> {
  const { client, key } = clientFor(options);
  const bytes = Buffer.from(canonical(manifest), "utf8");

  try {
    const head = bytes.subarray(0, FILE_CHUNK_BYTES);
    const receipt = await (
      await new FileCreateTransaction()
        .setKeys([key.publicKey])
        .setContents(head)
        .setFileMemo("ledger-of-work agent card v1")
        .freezeWith(client)
        .sign(key)
    )
      .execute(client)
      .then((r) => r.getReceipt(client));

    if (receipt.fileId === null) throw new Error("file create returned no file id");
    const fileId = receipt.fileId;

    for (let offset = FILE_CHUNK_BYTES; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
      await (
        await new FileAppendTransaction()
          .setFileId(fileId)
          .setContents(bytes.subarray(offset, offset + FILE_CHUNK_BYTES))
          .freezeWith(client)
          .sign(key)
      )
        .execute(client)
        .then((r) => r.getReceipt(client));
    }

    return fileId.toString();
  } finally {
    client.close();
  }
}

/** Replace a published card in place, keeping its file id stable. */
export async function updateAgentCard(
  fileId: string,
  manifest: unknown,
  options: AgentCardOptions,
): Promise<void> {
  const { client, key } = clientFor(options);
  const bytes = Buffer.from(canonical(manifest), "utf8");

  if (bytes.length > FILE_CHUNK_BYTES) {
    // FileUpdate replaces contents wholesale; a larger card needs update-then-append,
    // which is not what a caller expecting an atomic swap would want. Fail loudly.
    throw new Error(
      `agent card is ${bytes.length} bytes; updates above ${FILE_CHUNK_BYTES} need an update-then-append flow`,
    );
  }

  try {
    await (
      await new FileUpdateTransaction()
        .setFileId(FileId.fromString(fileId))
        .setContents(bytes)
        .freezeWith(client)
        .sign(key)
    )
      .execute(client)
      .then((r) => r.getReceipt(client));
  } finally {
    client.close();
  }
}

/**
 * Read a published card.
 *
 * Uses a paid consensus-node query rather than the mirror node because file *contents*
 * are not exposed over the mirror REST API — only file metadata is. A buyer therefore
 * needs an account to read it, which is a real limitation worth stating rather than
 * papering over.
 */
export async function readAgentCard(fileId: string, options: AgentCardOptions): Promise<unknown> {
  const { client } = clientFor(options);
  try {
    const contents = await new FileContentsQuery()
      .setFileId(FileId.fromString(fileId))
      .execute(client);
    return JSON.parse(Buffer.from(contents).toString("utf8"));
  } finally {
    client.close();
  }
}
