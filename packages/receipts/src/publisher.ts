import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { canonical, fitsOneChunk, type Receipt } from "@low/protocol";

export interface ReceiptLocator {
  topicId: string;
  sequenceNumber: number;
  /** Present once the mirror node has indexed the message. */
  consensusTimestamp?: string;
}

export interface PublisherOptions {
  network?: string;
  accountId: string;
  privateKey: string;
  topicId: string;
}

export class ReceiptTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `receipt is ${bytes} bytes and would be split across HCS chunks; the mirror REST API does not reassemble them. Bound sources[] or shorten fields.`,
    );
    this.name = "ReceiptTooLargeError";
  }
}

/**
 * Publishes receipts to a single HCS topic.
 *
 * One topic for the whole service, with a submit key set. Without the submit key anyone
 * could post a forged receipt to our topic and the verifier's "submitted by the expected
 * service" check would have nothing to reject.
 */
export class ReceiptPublisher {
  readonly topicId: string;
  readonly accountId: string;
  readonly #client: Client;

  constructor(options: PublisherOptions) {
    this.topicId = options.topicId;
    this.accountId = options.accountId;
    this.#client = Client.forName(options.network ?? "testnet").setOperator(
      AccountId.fromString(options.accountId),
      PrivateKey.fromStringECDSA(options.privateKey.replace(/^0x/i, "")),
    );
  }

  /**
   * Submit a receipt and return where it landed.
   *
   * The receipt is canonicalised before submission so a verifier can rebuild the exact
   * bytes: `JSON.stringify` orders keys by insertion, and a receipt written by one code
   * path but hashed by another would not match.
   */
  async publish(receipt: Receipt): Promise<ReceiptLocator> {
    const body = canonical(receipt);
    const bytes = Buffer.from(body, "utf8");

    if (!fitsOneChunk(receipt)) throw new ReceiptTooLargeError(bytes.length);

    const submitted = await (
      await new TopicMessageSubmitTransaction()
        .setTopicId(this.topicId)
        .setMessage(bytes)
        .execute(this.#client)
    ).getReceipt(this.#client);

    // The SDK types these as nullable because a receipt for a different transaction
    // kind would not carry them. For a topic submit they are always present, but assert
    // rather than cast: a silent undefined here would produce a receipt locator that
    // points nowhere, and the buyer would only find out at verification time.
    if (submitted.topicSequenceNumber === null) {
      throw new Error("topic submit returned no sequence number");
    }

    return {
      topicId: this.topicId,
      sequenceNumber: Number(submitted.topicSequenceNumber.toString()),
    };
  }

  close(): void {
    this.#client.close();
  }
}

/**
 * One-time setup: create the receipt topic.
 *
 * `adminKey` is set so the memo and keys can be rotated. A topic with no admin key is a
 * stronger immutability claim, but it is permanent — worth doing deliberately rather
 * than by accident.
 */
export async function createReceiptTopic(options: {
  network?: string;
  accountId: string;
  privateKey: string;
  memo?: string;
}): Promise<string> {
  const key = PrivateKey.fromStringECDSA(options.privateKey.replace(/^0x/i, ""));
  const client = Client.forName(options.network ?? "testnet").setOperator(
    AccountId.fromString(options.accountId),
    key,
  );
  try {
    const receipt = await (
      await new TopicCreateTransaction()
        .setTopicMemo(options.memo ?? "ledger-of-work receipts v1")
        .setAdminKey(key.publicKey)
        .setSubmitKey(key.publicKey)
        .execute(client)
    ).getReceipt(client);
    if (receipt.topicId === null) throw new Error("topic create returned no topic id");
    return receipt.topicId.toString();
  } finally {
    client.close();
  }
}
