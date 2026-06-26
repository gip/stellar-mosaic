// Wallet "math" helpers, ported from the frontend's `noir.ts`. These EXECUTE small Noir circuits
// (no proving) to derive the public field values — owner_tag, nullifier, order_leaf — using the
// exact Poseidon2 convention as the circuits/contract. The only change from the frontend version is
// that circuits are obtained from an injected {@link CircuitProvider} instead of `fetch('/circuits')`,
// so the same code runs in the browser and in Node.

import { Noir } from "@noir-lang/noir_js";
import { toFieldHex } from "./field.js";
import type { CircuitProvider } from "./circuits.js";
import type { Field } from "./types.js";
import { initNoirRuntime, type NoirRuntimeOptions } from "./noirRuntime.js";

function asField(v: unknown): Field {
  // noir_js returns field outputs as hex strings; normalize to 0x + 64 hex chars.
  return toFieldHex(v as string);
}

export interface OrderTerms {
  nullifier_in: Field;
  output_owner_tag: Field;
  cancel_owner_tag: Field;
  order_leaf: Field;
}

export interface JoinTerms {
  nullifier_1: Field;
  nullifier_2: Field;
  out_tag_1: Field;
  out_tag_2: Field;
}

export interface WalletMath {
  /** owner_tag = compress(compress(sk,0), rho). */
  noteTag(sk: Field, rho: Field): Promise<Field>;
  /** The public fields a lift (order) proof binds. */
  orderTerms(input: {
    sk: Field;
    rho_in: Field;
    rho_out: Field;
    rho_ord: Field;
    asset_in: number;
    amount_in: string;
    asset_out: number;
    min_out: string;
    expiry: number;
    partial_allowed: number;
  }): Promise<OrderTerms>;
  /** A note nullifier (reuses the order_terms helper with zero placeholders). */
  noteNullifier(sk: Field, rho: Field): Promise<Field>;
  /** The public fields a join proof binds: two input nullifiers and two output destination tags. */
  joinTerms(input: {
    sk_1: Field;
    rho_1: Field;
    sk_2: Field;
    rho_2: Field;
    sk_out1: Field;
    rho_out1: Field;
    sk_out2: Field;
    rho_out2: Field;
  }): Promise<JoinTerms>;
}

/** Build the wallet-math helpers over an injected circuit provider. Noir instances are cached. */
export function makeWalletMath(circuits: CircuitProvider, opts?: NoirRuntimeOptions): WalletMath {
  const cache = new Map<string, Promise<Noir>>();
  const load = (name: string): Promise<Noir> => {
    let p = cache.get(name);
    if (!p) {
      p = initNoirRuntime(opts).then(() => circuits(name)).then((c) => new Noir(c));
      cache.set(name, p);
    }
    return p;
  };

  const orderTerms: WalletMath["orderTerms"] = async (input) => {
    const noir = await load("order_terms");
    const { returnValue } = await noir.execute({
      sk: input.sk,
      rho_in: input.rho_in,
      rho_out: input.rho_out,
      rho_ord: input.rho_ord,
      asset_in: String(input.asset_in),
      amount_in: input.amount_in,
      asset_out: String(input.asset_out),
      min_out: input.min_out,
      expiry: String(input.expiry),
      partial_allowed: String(input.partial_allowed),
    });
    const [nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf] = (
      returnValue as string[]
    ).map(asField);
    return { nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf };
  };

  return {
    async noteTag(sk, rho) {
      const noir = await load("note_tag");
      const { returnValue } = await noir.execute({ sk, rho });
      return asField(returnValue);
    },
    orderTerms,
    async noteNullifier(sk, rho) {
      const { nullifier_in } = await orderTerms({
        sk,
        rho_in: rho,
        rho_out: "0",
        rho_ord: "0",
        asset_in: 0,
        amount_in: "0",
        asset_out: 0,
        min_out: "0",
        expiry: 0,
        partial_allowed: 0,
      });
      return nullifier_in;
    },
    async joinTerms(input) {
      const noir = await load("join_terms");
      const { returnValue } = await noir.execute({
        sk_1: input.sk_1,
        rho_1: input.rho_1,
        sk_2: input.sk_2,
        rho_2: input.rho_2,
        sk_out1: input.sk_out1,
        rho_out1: input.rho_out1,
        sk_out2: input.sk_out2,
        rho_out2: input.rho_out2,
      });
      const [nullifier_1, nullifier_2, out_tag_1, out_tag_2] = (returnValue as string[]).map(asField);
      return { nullifier_1, nullifier_2, out_tag_1, out_tag_2 };
    },
  };
}
