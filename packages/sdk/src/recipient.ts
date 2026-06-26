// Map a Stellar address to the field value bound by the unshield circuit and contract. Ported from
// the frontend `soroban.ts` `recipientField`, with the `buffer` polyfill dependency removed (plain
// Uint8Array/hex), so it runs unchanged in the browser and Node.

import { Address } from "@stellar/stellar-sdk";
import { toField32 } from "./field.js";
import type { Field } from "./types.js";

/** recipient = sha256(Address.toScVal().toXDR()) with the top byte zeroed (keeps the big-endian
 * value below 2^248, matching the contract / circuit binding). */
export async function recipientField(to: string): Promise<Field> {
  const xdrBytes = Uint8Array.from(Address.fromString(to).toScVal().toXDR());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", xdrBytes));
  hash[0] = 0;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return toField32(BigInt(`0x${hex}`));
}
