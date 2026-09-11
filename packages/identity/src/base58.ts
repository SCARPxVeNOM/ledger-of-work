/**
 * Base58, Bitcoin alphabet.
 *
 * Written out rather than depended on, because it is thirty lines and this package is
 * imported by a browser bundle that is currently 12 KB. It is also the one step of
 * HCS-14 where a mistake is invisible: a wrong alphabet or a dropped leading zero still
 * produces a plausible-looking identifier, just not the one everyone else computes.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as base58.
 *
 * Leading zero bytes are significant and are emitted as leading `1`s. Dropping them is
 * the classic base58 bug: the arithmetic below treats the input as one big number, and a
 * number has no way to remember how many zeros came before it.
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated long division by 58 over a base-256 big number held as a digit array.
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}

/** Decode base58 back to bytes. Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;

  const bytes: number[] = [0];
  for (let i = zeros; i < text.length; i++) {
    const value = ALPHABET.indexOf(text[i] as string);
    if (value < 0) throw new Error(`"${text[i]}" is not a base58 character`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
