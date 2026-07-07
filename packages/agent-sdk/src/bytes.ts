// Byte helpers shared across the portable (browser-safe) modules. Buffer comes from the `buffer`
// package like the rest of the workspace (Vite maps it to the polyfill), so everything here runs
// in both Node and the browser.

import { Buffer } from "buffer";

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex string");
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64url"));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Copy into a fresh ArrayBuffer-backed view — WebCrypto rejects SharedArrayBuffer-backed and
 *  offset views, and TS 5.7+ typed-array generics demand a plain ArrayBuffer. */
export function webBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", webBytes(input)));
}

/** HKDF-SHA-256 → 32 bytes. The single derivation primitive behind every key in this SDK,
 *  mirroring the frontend recovery module so the two schemes stay structurally identical. */
export async function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", webBytes(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: webBytes(salt), info: webBytes(info) },
      key,
      256,
    ),
  );
}
