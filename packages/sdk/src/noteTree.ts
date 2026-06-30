// Off-chain reconstruction of the on-chain note tree, in pure TypeScript. This mirrors the Rust
// path server `tools/indexer/src/lib.rs` (asset_note_leaf, the zero ladder, build_layers, path,
// circuit_fold) one-for-one, but obtains the 2-to-1 Poseidon2 hash from an injected `Compressor`
// (the `circuits/wallet/compress` circuit executed via ACVM). Because that circuit is the exact
// primitive the contract/circuits/indexer already agree on, the roots and paths produced here are
// byte-identical by construction.
//
// The contract keeps only filled subtrees; this keeps every leaf so it can produce a path for any
// historical note. `Compressor` results are deterministic, so callers should memoize them (see
// `makeNoirCompressor`) to keep incremental rebuilds cheap.

import { toBigInt, toFieldHex } from "./field.js";
import type { Amount, ChainNote, Field, NoteProof, TreeEvent } from "./types.js";

/** Depth of the append-only note tree (matches the contract's TREE_DEPTH and the circuits'). */
export const TREE_DEPTH = 32;

/** 2-to-1 Poseidon2 compression: `compress(a,b) = poseidon2_permutation([a,b,0,0],4)[0]`. */
export type Compressor = (a: bigint, b: bigint) => Promise<bigint>;

/** Per-leaf metadata retained so we can answer `notes()` and look a leaf up by `owner_tag`. */
interface LeafMeta {
  asset: number;
  amount: Amount;
  owner_tag: Field;
}

export interface MerklePath {
  leaf_index: number;
  siblings: bigint[];
  index_bits: number[];
}

export class NoteTree {
  private readonly compress: Compressor;
  private leaves: bigint[] = [];
  private meta: LeafMeta[] = [];
  private zeros: bigint[] | null = null;

  constructor(compress: Compressor) {
    this.compress = compress;
  }

  get length(): number {
    return this.leaves.length;
  }

  /** Compute the zero ladder once: zeros[0]=0, zeros[i]=compress(zeros[i-1], zeros[i-1]). */
  private async ensureZeros(): Promise<bigint[]> {
    if (this.zeros) return this.zeros;
    const zeros: bigint[] = [0n];
    for (let i = 1; i < TREE_DEPTH; i++) {
      zeros.push(await this.compress(zeros[i - 1], zeros[i - 1]));
    }
    this.zeros = zeros;
    return zeros;
  }

  /** AssetNote leaf = compress(compress(asset, amount), owner_tag), folded left-to-right exactly
   * like the circuit's hash3, the contract's asset_note_leaf, and the indexer's. */
  private async assetNoteLeaf(asset: number, amount: Amount, ownerTag: Field): Promise<bigint> {
    const acc = await this.compress(BigInt(asset), toBigInt(amount));
    return this.compress(acc, toBigInt(ownerTag));
  }

  private async insertAssetNote(asset: number, amount: Amount, ownerTag: Field): Promise<number> {
    const leaf = await this.assetNoteLeaf(asset, amount, ownerTag);
    const idx = this.leaves.length;
    this.leaves.push(leaf);
    this.meta.push({ asset, amount, owner_tag: toFieldHex(ownerTag) });
    return idx;
  }

  /** Ingest a `shielded`/`noteins` event (one AssetNote leaf). */
  ingestNote(asset: number, amount: Amount, ownerTag: Field): Promise<number> {
    return this.insertAssetNote(asset, amount, ownerTag);
  }

  /** Ingest a `settled` event: two leaves in on-chain insertion order (a's output, then b's). */
  async ingestSettled(
    aAssetOut: number,
    bAmountIn: Amount,
    aOutputOwnerTag: Field,
    bAssetOut: number,
    aAmountIn: Amount,
    bOutputOwnerTag: Field,
  ): Promise<[number, number]> {
    const ia = await this.insertAssetNote(aAssetOut, bAmountIn, aOutputOwnerTag);
    const ib = await this.insertAssetNote(bAssetOut, aAmountIn, bOutputOwnerTag);
    return [ia, ib];
  }

  /** Replay a single insertion-ordered tree event. */
  async ingest(ev: TreeEvent): Promise<void> {
    if (ev.kind === "shielded" || ev.kind === "noteins") {
      await this.ingestNote(ev.asset, ev.amount, ev.owner_tag);
    } else {
      await this.ingestSettled(
        ev.a_asset_out,
        ev.b_amount_in,
        ev.a_output_owner_tag,
        ev.b_asset_out,
        ev.a_amount_in,
        ev.b_output_owner_tag,
      );
    }
  }

  /** Build all tree levels from the current leaves. layers[0] is the leaf level; layers[i+1] is
   * built by compressing pairs of layers[i], padding an odd tail with zeros[i]. */
  private async buildLayers(): Promise<bigint[][]> {
    const zeros = await this.ensureZeros();
    const layers: bigint[][] = [this.leaves.slice()];
    for (let level = 0; level < TREE_DEPTH; level++) {
      const prev = layers[level];
      const cur: bigint[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        const left = prev[i];
        const right = i + 1 < prev.length ? prev[i + 1] : zeros[level];
        cur.push(await this.compress(left, right));
      }
      layers.push(cur);
    }
    return layers;
  }

  /** Current Merkle root (must equal the contract's root() after the same inserts). */
  async root(): Promise<Field> {
    const zeros = await this.ensureZeros();
    if (this.leaves.length === 0) {
      const z = zeros[TREE_DEPTH - 1];
      return toFieldHex(await this.compress(z, z));
    }
    const layers = await this.buildLayers();
    return toFieldHex(layers[TREE_DEPTH][0]);
  }

  /** Membership path for the leaf at `index` (LSB-first; level 0 = leaf level). */
  async pathAt(index: number): Promise<MerklePath> {
    if (index < 0 || index >= this.leaves.length) throw new Error("leaf index out of range");
    const zeros = await this.ensureZeros();
    const layers = await this.buildLayers();
    const siblings: bigint[] = [];
    const index_bits: number[] = [];
    let idx = index;
    for (let level = 0; level < TREE_DEPTH; level++) {
      const bit = idx & 1;
      const sibPos = idx ^ 1;
      const layer = layers[level];
      siblings.push(sibPos < layer.length ? layer[sibPos] : zeros[level]);
      index_bits.push(bit);
      idx >>= 1;
    }
    return { leaf_index: index, siblings, index_bits };
  }

  /** A {@link NoteProof} (hex-encoded) for the leaf at `index`, ready for a witness. */
  async noteProofAt(index: number): Promise<NoteProof> {
    const [path, root] = await Promise.all([this.pathAt(index), this.root()]);
    return {
      leaf_index: index,
      root,
      siblings: path.siblings.map(toFieldHex),
      index_bits: path.index_bits,
    };
  }

  /** Fold a leaf up a path with the exact algorithm the Noir membership circuit uses. If this
   * equals root() for pathAt(index), a proof built from that witness satisfies the membership
   * constraint. Used to verify paths without running bb. */
  async circuitFold(leaf: bigint, path: MerklePath): Promise<bigint> {
    let node = leaf;
    for (let level = 0; level < TREE_DEPTH; level++) {
      const sib = path.siblings[level];
      const [left, right] = path.index_bits[level] === 0 ? [node, sib] : [sib, node];
      node = await this.compress(left, right);
    }
    return node;
  }

  /** The leaf value (bigint) at `index`, or undefined. */
  leafAt(index: number): bigint | undefined {
    return this.leaves[index];
  }

  /** All notes currently in the tree (no secrets), in insertion order. */
  notes(): ChainNote[] {
    return this.meta.map((m, leaf_index) => ({
      leaf_index,
      asset: m.asset,
      amount: m.amount,
      owner_tag: m.owner_tag,
    }));
  }

  /** Leaf index for the (last-inserted) note with this owner_tag, or -1. */
  indexOfOwnerTag(ownerTag: Field): number {
    const want = toFieldHex(ownerTag).toLowerCase();
    for (let i = this.meta.length - 1; i >= 0; i--) {
      if (this.meta[i].owner_tag.toLowerCase() === want) return i;
    }
    return -1;
  }
}
