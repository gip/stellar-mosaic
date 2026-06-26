// UltraHonk proving for the protocol circuits (lift/unshield/join/cancel), ported from the
// frontend's `prove.ts`. Generates proofs whose bytes the on-chain Nethermind verifier accepts
// (bb.js {keccak:true} full proof + concatenated public inputs). Secrets stay in-process. The only
// change from the frontend version is that circuits come from an injected {@link CircuitProvider}.

import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { toField32 } from "./field.js";
import type { CircuitProvider } from "./circuits.js";
import type { Field } from "./types.js";
import { initNoirRuntime, type NoirRuntimeOptions } from "./noirRuntime.js";

/** Pack noir_js public-input field strings as the contract's `public_inputs`: 32-byte BE each. */
export function packPublicInputs(publicInputs: string[]): Uint8Array {
  const pi = new Uint8Array(publicInputs.length * 32);
  publicInputs.forEach((h, i) => {
    const hex = toField32(h).slice(2);
    for (let j = 0; j < 32; j++) pi[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
  });
  return pi;
}

/** Base64-encode bytes for JSON transport to a relay / MCP. */
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface ProofBundle {
  proof: Uint8Array;
  publicInputs: Uint8Array;
}

export interface LiftInputs {
  rho_in: Field;
  sk_o: Field;
  path: Field[];
  index_bits: number[];
  root: Field;
  nullifier_in: Field;
  asset_in: number;
  amount_in: string;
  asset_out: number;
  min_out: string;
  output_owner_tag: Field;
  cancel_owner_tag: Field;
  expiry: number;
  partial_allowed: number;
  order_leaf: Field;
}

export interface UnshieldInputs {
  rho_in: Field;
  sk_o: Field;
  path: Field[];
  index_bits: number[];
  root: Field;
  nullifier: Field;
  asset: number;
  amount: string;
  recipient: Field;
}

export interface JoinInputs {
  sk_1: Field;
  rho_1: Field;
  amount_1: string;
  path_1: Field[];
  index_bits_1: number[];
  sk_2: Field;
  rho_2: Field;
  amount_2: string;
  path_2: Field[];
  index_bits_2: number[];
  root: Field;
  nullifier_1: Field;
  nullifier_2: Field;
  asset: number;
  out_tag_1: Field;
  out_amount_1: string;
  out_tag_2: Field;
  out_amount_2: string;
}

export interface CancelInputs {
  sk_o: Field;
  rho_ord: Field;
  order_leaf: Field;
  cancel_owner_tag: Field;
  return_owner_tag: Field;
}

export interface Prover {
  proveLift(input: LiftInputs): Promise<ProofBundle>;
  proveUnshield(input: UnshieldInputs): Promise<ProofBundle>;
  proveJoin(input: JoinInputs): Promise<ProofBundle>;
  proveCancel(input: CancelInputs): Promise<ProofBundle>;
}

/** Build the prover over an injected circuit provider. */
export function makeProver(circuits: CircuitProvider, opts?: NoirRuntimeOptions): Prover {
  async function run(
    name: string,
    inputs: Record<string, unknown>,
  ): Promise<ProofBundle> {
    await initNoirRuntime(opts);
    const compiled = await circuits(name);
    const noir = new Noir(compiled);
    const { witness } = await noir.execute(inputs as never);
    const backend = new UltraHonkBackend(compiled.bytecode);
    const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true });
    return { proof, publicInputs: packPublicInputs(publicInputs) };
  }

  return {
    proveLift: (input) =>
      run("lift", {
        rho_in: input.rho_in,
        sk_o: input.sk_o,
        path: input.path,
        index_bits: input.index_bits.map(String),
        domain: "1",
        root: input.root,
        nullifier_in: input.nullifier_in,
        asset_in: String(input.asset_in),
        amount_in: input.amount_in,
        asset_out: String(input.asset_out),
        min_out: input.min_out,
        output_owner_tag: input.output_owner_tag,
        cancel_owner_tag: input.cancel_owner_tag,
        expiry: String(input.expiry),
        partial_allowed: String(input.partial_allowed),
        order_leaf: input.order_leaf,
      }),
    proveUnshield: (input) =>
      run("unshield", {
        rho_in: input.rho_in,
        sk_o: input.sk_o,
        path: input.path,
        index_bits: input.index_bits.map(String),
        domain: "2",
        root: input.root,
        nullifier: input.nullifier,
        asset: String(input.asset),
        amount: input.amount,
        recipient: input.recipient,
      }),
    proveJoin: (input) =>
      run("join", {
        sk_1: input.sk_1,
        rho_1: input.rho_1,
        amount_1: input.amount_1,
        path_1: input.path_1,
        index_bits_1: input.index_bits_1.map(String),
        sk_2: input.sk_2,
        rho_2: input.rho_2,
        amount_2: input.amount_2,
        path_2: input.path_2,
        index_bits_2: input.index_bits_2.map(String),
        domain: "4",
        root: input.root,
        nullifier_1: input.nullifier_1,
        nullifier_2: input.nullifier_2,
        asset: String(input.asset),
        out_tag_1: input.out_tag_1,
        out_amount_1: input.out_amount_1,
        out_tag_2: input.out_tag_2,
        out_amount_2: input.out_amount_2,
      }),
    proveCancel: (input) =>
      run("cancel", {
        sk_o: input.sk_o,
        rho_ord: input.rho_ord,
        domain: "3",
        order_leaf: input.order_leaf,
        cancel_owner_tag: input.cancel_owner_tag,
        return_owner_tag: input.return_owner_tag,
      }),
  };
}
