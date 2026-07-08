// Master-signature helpers: produce the (ref, signature) pair that seeds derivation, for both
// wallet kinds. The Stellar path rides the existing StellarSigner port (Freighter in the browser,
// SecretKeySigner headless — both already SEP-0053). The Ethereum path defines its own minimal
// message signer because the SDK's EthSigner port only sends transactions.

import type { StellarSigner } from "@mosaic/sdk";
import { getAddress, hexToBytes, isAddress, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentMasterMessage, normalizeEthSignature } from "./derive.js";
import { utf8 } from "./bytes.js";
import type { MasterRef } from "./types.js";

export interface MasterSignature {
  ref: MasterRef;
  /** HKDF input: 64 bytes (ed25519) or 65 bytes (normalized secp256k1). */
  signature: Uint8Array;
}

/** Sign the canonical master message with a Stellar wallet (SEP-0053 via signMessage). */
export async function signAgentMasterStellar(
  signer: StellarSigner,
  networkPassphrase: string,
): Promise<MasterSignature> {
  const address = await signer.address();
  const ref: MasterRef = { chain: "stellar", address, networkPassphrase };
  const signature = await signer.signMessage(utf8(agentMasterMessage(ref)));
  if (signature.length !== 64) throw new Error(`expected a 64-byte ed25519 signature, got ${signature.length}`);
  return { ref, signature };
}

/** Minimal EIP-191 message signer — an EOA wallet or a raw key. */
export interface EthMessageSigner {
  address(): Promise<`0x${string}`>;
  /** personal_sign over the utf8 message; returns 0x r||s||v (65 bytes). */
  personalSign(message: string): Promise<`0x${string}`>;
}

/** An EthMessageSigner from a raw private key (viem local account — RFC 6979 deterministic). */
export function ethMessageSignerFromKey(key: `0x${string}`): EthMessageSigner {
  const account = privateKeyToAccount(key);
  return {
    address: async () => account.address,
    personalSign: (message: string) => account.signMessage({ message }),
  };
}

/** Sign the canonical master message with an Ethereum EOA. Verifies the signature recovers to the
 *  claimed address — contract/MPC wallets (ERC-1271 etc.) are rejected because their signatures
 *  are not guaranteed deterministic, which would silently re-key the agent tree. */
export async function signAgentMasterEth(
  signer: EthMessageSigner,
  networkPassphrase: string,
): Promise<MasterSignature> {
  const raw = await signer.address();
  if (!isAddress(raw)) throw new Error(`invalid ethereum address: ${raw}`);
  const address = getAddress(raw); // EIP-55 — the canonical casing that enters the HKDF info
  const ref: MasterRef = { chain: "ethereum", address, networkPassphrase };
  const message = agentMasterMessage(ref);
  const sigHex = await signer.personalSign(message);
  const recovered = await recoverMessageAddress({ message, signature: sigHex });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error("signature does not recover to the master address (EOA wallets only)");
  }
  return { ref, signature: normalizeEthSignature(hexToBytes(sigHex)) };
}
