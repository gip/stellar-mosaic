// SEP-0053 message signing digest. Stellar wallets (Freighter's `signMessage`, and any other
// SEP-0053 wallet) do not ed25519-sign a message's raw bytes: they sign
// `SHA256("Stellar Signed Message:\n" || message)`. Both the signer (SecretKeySigner) and the MCP
// auth verifier go through this single helper so the two can never drift apart.

import { hash } from "@stellar/stellar-sdk"; // SHA-256, re-exported from stellar-base (browser-safe)
import { Buffer } from "buffer";

const SEP53_PREFIX = Buffer.from("Stellar Signed Message:\n", "utf8");

/** SEP-0053 digest: SHA256("Stellar Signed Message:\n" || message). This 32-byte value is what
 *  Freighter (and every SEP-0053 wallet) actually ed25519-signs and verifies. */
export function sep53Digest(message: Uint8Array): Uint8Array {
  return Uint8Array.from(hash(Buffer.concat([SEP53_PREFIX, Buffer.from(message)])));
}
