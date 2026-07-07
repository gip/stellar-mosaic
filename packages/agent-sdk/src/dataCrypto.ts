// Optional end-to-end encryption for attached/scratch data: values sealed under the agent's
// derived data key (AES-256-GCM) so the backend stores only ciphertext. Masters seal on the web
// (they can re-derive any agent's dataKey); agent sessions open with their own identity.

import { fromHex, toHex, utf8, webBytes } from "./bytes.js";
import type { SealedData } from "./types.js";

const AAD = utf8("stellar-mosaic/agent-data/v1");

async function aesKey(dataKey: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (dataKey.length !== 32) throw new Error(`data key must be 32 bytes, got ${dataKey.length}`);
  return crypto.subtle.importKey("raw", webBytes(dataKey), "AES-GCM", false, [usage]);
}

export function isSealedData(value: unknown): value is SealedData {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SealedData).mosaic_sealed === 1 &&
    typeof (value as SealedData).nonce === "string" &&
    typeof (value as SealedData).ct === "string"
  );
}

/** Encrypt any JSON value under the agent's data key. */
export async function sealAgentData(value: unknown, dataKey: Uint8Array): Promise<SealedData> {
  const key = await aesKey(dataKey, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: webBytes(AAD) },
      key,
      webBytes(utf8(JSON.stringify(value))),
    ),
  );
  return { mosaic_sealed: 1, nonce: toHex(nonce), ct: toHex(ct) };
}

/** Decrypt a sealed value back to its JSON form. */
export async function openAgentData(sealed: SealedData, dataKey: Uint8Array): Promise<unknown> {
  const key = await aesKey(dataKey, "decrypt");
  try {
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: webBytes(fromHex(sealed.nonce)), additionalData: webBytes(AAD) },
      key,
      webBytes(fromHex(sealed.ct)),
    );
    return JSON.parse(new TextDecoder().decode(clear));
  } catch {
    throw new Error("sealed data failed to open (wrong agent or corrupted value)");
  }
}
