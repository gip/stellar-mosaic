// BN254 scalar field helpers shared by the note tree and (later) the crypto module. Field elements
// cross module boundaries as `0x`+64-hex strings (the on-chain encoding); internally the tree works
// in `bigint` for speed.

import type { Field } from "./types.js";

/** BN254 scalar field modulus (the field the circuits + contract operate over). */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Parse a field value (hex `0x…`, decimal string, number, or bigint) into a canonical bigint in
 * `[0, p)`. Tolerates the signed residue some tools emit by reducing mod p. */
export function toBigInt(v: Field | bigint | number): bigint {
  const n = typeof v === "bigint" ? v : BigInt(v);
  const r = n % FIELD_MODULUS;
  return r < 0n ? r + FIELD_MODULUS : r;
}

/** Render a field value as `0x` + 64 lowercase hex chars. */
export function toFieldHex(v: Field | bigint | number): Field {
  return "0x" + toBigInt(v).toString(16).padStart(64, "0");
}

/** Alias matching the original frontend `crypto.toField32` name (identical to {@link toFieldHex}). */
export const toField32 = toFieldHex;

/** A fresh random secret field element. 31 bytes (248 bits) is always < the BN254 prime (~254 bits).
 * Uses the Web Crypto RNG, available as a global in modern browsers and Node 18+. */
export function randomField(): Field {
  const b = new Uint8Array(31);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Field value as raw 32 bytes (big-endian) — the on-chain `BytesN<32>` encoding for owner tags. */
export function fieldToBytes32(v: Field | bigint): Uint8Array {
  const hex = toFieldHex(v).slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
