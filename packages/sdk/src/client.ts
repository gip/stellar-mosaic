// The local MosaicClient: shield / placeOrder / cancelOrder / unshield / assemble / startNoteLoop,
// composed from the extracted primitives (NoteManager, WalletMath, Prover, DirectSubmitter,
// LocalPathProvider). This is a faithful re-composition of the frontend's `direct`-mode operation
// flows (operationExecutor.ts + orchestrate.ts), with the backend relay / getNoteProof replaced by
// the local Submitter + NoteSource ports. No sponsor, no server: the caller signs and pays its own
// fees and rebuilds membership paths locally. Base shielding still routes through the MCP.

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { fieldToBytes32, randomField } from "./field.js";
import { recipientField } from "./recipient.js";
import { nowMs, nowSeconds } from "./time.js";
import { NoteManager } from "./notes.js";
import { planAssembly, type AssemblyStep, type JoinInputRef } from "./orderPlan.js";
import { makeWalletMath, type WalletMath } from "./noirMath.js";
import { makeProver, type Prover } from "./prove.js";
import type { CircuitProvider } from "./circuits.js";
import type { NoirRuntimeOptions } from "./noirRuntime.js";
import { errorMessage, getMosaicLogger, serializeError, type MosaicLogger } from "./logging.js";
import type {
  Deployer,
  EthSigner,
  Funder,
  McpClient,
  NetworkConfig,
  NoteSource,
  NoteStore,
  StellarSigner,
  Submitter,
} from "./ports.js";
import { SIDE_SELL, type Amount, type AssetDef, type DeskConfig, type Field, type Note, type PairDef, type Side } from "./types.js";

const ZERO_FIELD: Field = "0x" + "0".repeat(64);
const ZERO_PATH: Field[] = Array<Field>(32).fill(ZERO_FIELD);
const ZERO_BITS: number[] = Array<number>(32).fill(0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The full set of environment adapters a {@link MosaicClient} runs on. */
export interface MosaicPorts {
  network: NetworkConfig;
  signer: StellarSigner;
  store: NoteStore;
  /** Read-only on-chain note state (default: LocalPathProvider). */
  source: NoteSource;
  submitter: Submitter;
  /** Resolves desk config (contract id, assets, pairs). */
  desks: { get(deskId: string): Promise<DeskConfig> };
  circuits: CircuitProvider;
  /** Optional runtime hook for browser WASM loaders used by Noir. */
  noirRuntime?: NoirRuntimeOptions;
  /** Optional logger. Defaults to the SDK console logger. */
  logger?: MosaicLogger;
  funder?: Funder;
  deployer?: Deployer;
  ethSigner?: EthSigner;
  mcp?: McpClient;
  /** Notified after note mutations (e.g. to trigger a UI refresh). */
  onNotesChanged?: () => void;
  /** Lets an app protect or annotate freshly-created notes before a transaction is submitted. */
  prepareNotes?: (notes: Note[]) => Promise<Note[]>;
}

export interface ShieldParams {
  deskId: string;
  asset_id: number;
  amount: Amount;
}
export interface OrderParams {
  deskId: string;
  pairId: number;
  side: Side;
  /** Raw amount_in offered (base for SELL, quote for BUY). */
  amountIn: Amount;
  /** Raw min_out wanted. */
  minOut: Amount;
  expiry?: number;
  partialAllowed?: boolean;
}
export interface UnshieldParams {
  deskId: string;
  asset_id: number;
  amount: Amount;
  recipient: string;
}
export interface CancelParams {
  deskId: string;
  noteId: string;
}

export interface NoteLoop {
  stop(): void;
}

export class MosaicClient {
  private readonly p: MosaicPorts;
  private readonly notes: NoteManager;
  private readonly wallet: WalletMath;
  private readonly prover: Prover;
  private readonly logger: MosaicLogger;

  constructor(ports: MosaicPorts) {
    this.p = ports;
    this.logger = ports.logger ?? getMosaicLogger();
    this.notes = new NoteManager(ports.store, ports.onNotesChanged);
    this.wallet = makeWalletMath(ports.circuits, ports.noirRuntime);
    this.prover = makeProver(ports.circuits, ports.noirRuntime);
  }

  private async prepareNotes(notes: Note[]): Promise<Note[]> {
    if (!this.p.prepareNotes) return notes;
    const prepared = await this.p.prepareNotes(notes);
    if (prepared.length !== notes.length) throw new Error("prepareNotes returned the wrong number of notes.");
    return prepared;
  }

  // --- helpers ----------------------------------------------------------------------------------

  private scvBytes(bytes: Uint8Array): xdr.ScVal {
    return xdr.ScVal.scvBytes(Buffer.from(bytes));
  }

  private symbolOf(desk: DeskConfig, assetId: number): string {
    return desk.assets.find((a) => a.asset_id === assetId)?.symbol ?? `#${assetId}`;
  }

  /** Poll until the note with `ownerTag` has a membership path (the local indexer caught up). */
  private async waitForNotePath(deskId: string, ownerTag: Field, timeoutMs = 30_000) {
    const start = Date.now();
    for (;;) {
      try {
        return await this.p.source.notePath(deskId, ownerTag);
      } catch (err) {
        this.logger.debug("note path not indexed yet", { deskId, ownerTag, error: err });
        if (Date.now() - start >= timeoutMs) throw err;
        await sleep(1_500);
      }
    }
  }

  /** Poll the chain, reconcile, and return the note once it is active + indexed. */
  private async waitForConfirm(deskId: string, noteId: string, timeoutMs = 120_000): Promise<Note> {
    const start = Date.now();
    for (;;) {
      try {
        await this.notes.reconcile(deskId, await this.p.source.notes(deskId));
      } catch {
        /* transient; retry */
      }
      const n = (await this.notes.forDesk(deskId)).find((x) => x.id === noteId);
      if (n?.status === "active" && n.indexed) return n;
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for note confirmation.");
      await sleep(3_000);
    }
  }

  // --- shield -----------------------------------------------------------------------------------

  async shield(params: ShieldParams): Promise<{ note: Note }> {
    let noteId: string | undefined;
    try {
      this.logger.info("shield started", { deskId: params.deskId, assetId: params.asset_id, amount: params.amount });
      const desk = await this.p.desks.get(params.deskId);
      const asset = desk.assets.find((a) => a.asset_id === params.asset_id);
      if (!asset) throw new Error("The requested asset is not registered on this desk.");

      const sk = randomField();
      const rho = randomField();
      const owner_tag = await this.wallet.noteTag(sk, rho);
      let note: Note = {
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: "asset",
        asset_id: params.asset_id,
        symbol: asset.symbol,
        amount: params.amount,
        sk,
        rho,
        owner_tag,
        status: "active",
        indexed: false,
        createdAt: nowMs(),
      };
      [note] = await this.prepareNotes([note]);
      noteId = note.id;
      await this.notes.add(note);
      this.logger.info("shield note staged", { deskId: desk.id, noteId, assetId: params.asset_id, symbol: asset.symbol });

      const source = await this.p.signer.address();
      const res = await this.p.submitter.submit({
        deskId: desk.id,
        contractId: desk.contractId,
        method: "shield",
        args: [
          new Address(source).toScVal(),
          nativeToScVal(params.asset_id, { type: "u32" }),
          nativeToScVal(BigInt(params.amount), { type: "i128" }),
          this.scvBytes(fieldToBytes32(owner_tag)),
        ],
      });
      await this.notes.update(note.id, { txHash: res.txHash });
      this.logger.info("shield transaction submitted", { deskId: desk.id, noteId, txHash: res.txHash });
      try {
        await this.waitForConfirm(desk.id, note.id, 30_000);
        this.logger.info("shield note indexed", { deskId: desk.id, noteId });
      } catch (error) {
        this.logger.warn("shield note not indexed before timeout", { deskId: desk.id, noteId, error });
        /* shield is final; leave it pending until the loop reconciles it */
      }
      return { note: (await this.notes.forDesk(desk.id)).find((n) => n.id === note.id) ?? note };
    } catch (error) {
      this.logger.error("shield failed", {
        deskId: params.deskId,
        noteId,
        message: errorMessage(error),
        error: serializeError(error),
      });
      throw error;
    }
  }

  // --- assemble (join/split) --------------------------------------------------------------------

  /** Produce one confirmed note of exactly `target` of `asset_id` (split/merge as needed). */
  async assemble(deskId: string, asset_id: number, target: Amount): Promise<{ note: Note }> {
    const all = await this.notes.forDesk(deskId);
    const plan = planAssembly(all, asset_id, BigInt(target));
    if (plan.kind === "impossible") throw new Error(plan.reason);
    if (plan.kind === "direct") {
      const note = all.find((n) => n.id === plan.noteId);
      if (!note) throw new Error("The selected private note is no longer available.");
      return { note };
    }
    return { note: await this.runAssembly(deskId, plan.steps, all) };
  }

  private async runAssembly(deskId: string, steps: AssemblyStep[], pool: Note[]): Promise<Note> {
    const byId = new Map(pool.map((n) => [n.id, n]));
    const resolve = (ref: JoinInputRef, prev: Note | null) =>
      ref.type === "prev" ? prev : byId.get(ref.id) ?? null;
    let prev: Note | null = null;
    for (const step of steps) {
      const a = resolve(step.a, prev);
      const b = step.op === "join" ? resolve(step.b, prev) : null;
      if (!a || (step.op === "join" && !b)) throw new Error("A note is no longer available; please retry.");
      const { target } = await this.executeJoin(deskId, a, b, BigInt(step.targetRaw), BigInt(step.changeRaw));
      prev = await this.waitForConfirm(deskId, target.id);
    }
    if (!prev) throw new Error("Empty assembly plan.");
    return prev;
  }

  private async executeJoin(
    deskId: string,
    a: Note,
    b: Note | null,
    targetRaw: bigint,
    changeRaw: bigint,
  ): Promise<{ target: Note; change: Note | null }> {
    const desk = await this.p.desks.get(deskId);
    const sk_out1 = randomField();
    const rho_out1 = randomField();
    const sk_out2 = randomField();
    const rho_out2 = randomField();
    const sk_2 = b ? b.sk : randomField();
    const rho_2 = b ? b.rho : randomField();

    const terms = await this.wallet.joinTerms({
      sk_1: a.sk,
      rho_1: a.rho,
      sk_2,
      rho_2,
      sk_out1,
      rho_out1,
      sk_out2,
      rho_out2,
    });

    const pa = await this.waitForNotePath(deskId, a.owner_tag);
    let amount_2: Amount = "0";
    let path_2 = ZERO_PATH;
    let index_bits_2 = ZERO_BITS;
    if (b) {
      const pb = await this.waitForNotePath(deskId, b.owner_tag);
      if (pa.root.toLowerCase() !== pb.root.toLowerCase()) {
        throw new Error("Tree advanced between path fetches; please retry.");
      }
      amount_2 = b.amount;
      path_2 = pb.siblings;
      index_bits_2 = pb.index_bits;
    }

    const bundle = await this.prover.proveJoin({
      sk_1: a.sk,
      rho_1: a.rho,
      amount_1: a.amount,
      path_1: pa.siblings,
      index_bits_1: pa.index_bits,
      sk_2,
      rho_2,
      amount_2,
      path_2,
      index_bits_2,
      root: pa.root,
      nullifier_1: terms.nullifier_1,
      nullifier_2: terms.nullifier_2,
      asset: a.asset_id,
      out_tag_1: terms.out_tag_1,
      out_amount_1: targetRaw.toString(),
      out_tag_2: terms.out_tag_2,
      out_amount_2: changeRaw.toString(),
    });

    let target: Note = {
      id: crypto.randomUUID(),
      deskId: desk.id,
      role: "asset",
      asset_id: a.asset_id,
      symbol: a.symbol,
      amount: targetRaw.toString(),
      sk: sk_out1,
      rho: rho_out1,
      owner_tag: terms.out_tag_1,
      status: "active",
      indexed: false,
      createdAt: nowMs(),
    };
    let change: Note | null =
      changeRaw > 0n
        ? {
            id: crypto.randomUUID(),
            deskId: desk.id,
            role: "asset",
            asset_id: a.asset_id,
            symbol: a.symbol,
            amount: changeRaw.toString(),
            sk: sk_out2,
            rho: rho_out2,
            owner_tag: terms.out_tag_2,
            status: "active",
            indexed: false,
            createdAt: nowMs(),
          }
        : null;
    const prepared = await this.prepareNotes(change ? [target, change] : [target]);
    target = prepared[0];
    change = change ? prepared[1] : null;
    await this.notes.add(target);
    if (change) await this.notes.add(change);

    await this.p.submitter.submit({
      deskId: desk.id,
      contractId: desk.contractId,
      method: "join",
      args: [this.scvBytes(bundle.proof), this.scvBytes(bundle.publicInputs)],
    });
    await this.notes.update(a.id, { status: "spent" });
    if (b) await this.notes.update(b.id, { status: "spent" });
    return { target, change };
  }

  // --- place order ------------------------------------------------------------------------------

  async placeOrder(params: OrderParams): Promise<{ note: Note }> {
    const desk = await this.p.desks.get(params.deskId);
    const pair = desk.pairs.find((p) => p.pair_id === params.pairId);
    if (!pair) throw new Error("The requested pair is not registered on this desk.");
    const assetIn = params.side === SIDE_SELL ? pair.base_asset : pair.quote_asset;
    const assetOut = params.side === SIDE_SELL ? pair.quote_asset : pair.base_asset;

    const offer = (await this.assemble(params.deskId, assetIn, params.amountIn)).note;
    await this.waitForConfirm(params.deskId, offer.id);
    const membership = await this.waitForNotePath(params.deskId, offer.owner_tag);

    const expiry = params.expiry ?? nowSeconds() + 7 * 86400;
    const rho_out = randomField();
    const rho_ord = randomField();
    const partial = params.partialAllowed ? 1 : 0;
    const terms = await this.wallet.orderTerms({
      sk: offer.sk,
      rho_in: offer.rho,
      rho_out,
      rho_ord,
      asset_in: assetIn,
      amount_in: offer.amount,
      asset_out: assetOut,
      min_out: params.minOut,
      expiry,
      partial_allowed: partial,
    });
    const bundle = await this.prover.proveLift({
      rho_in: offer.rho,
      sk_o: offer.sk,
      path: membership.siblings,
      index_bits: membership.index_bits,
      root: membership.root,
      nullifier_in: terms.nullifier_in,
      asset_in: assetIn,
      amount_in: offer.amount,
      asset_out: assetOut,
      min_out: params.minOut,
      output_owner_tag: terms.output_owner_tag,
      cancel_owner_tag: terms.cancel_owner_tag,
      expiry,
      partial_allowed: partial,
      order_leaf: terms.order_leaf,
    });

    let output: Note = {
      id: crypto.randomUUID(),
      deskId: desk.id,
      role: "order-output",
      asset_id: assetOut,
      symbol: this.symbolOf(desk, assetOut),
      amount: params.minOut,
      sk: offer.sk,
      rho: rho_out,
      owner_tag: terms.output_owner_tag,
      status: "active",
      indexed: false,
      createdAt: nowMs(),
      cancel: {
        rho_ord,
        order_leaf: terms.order_leaf,
        cancel_owner_tag: terms.cancel_owner_tag,
        pairId: params.pairId,
        side: params.side,
        asset_in: assetIn,
        symbol_in: this.symbolOf(desk, assetIn),
        amount_in: offer.amount,
      },
    };
    [output] = await this.prepareNotes([output]);
    await this.notes.add(output);
    await this.p.submitter.submit({
      deskId: desk.id,
      contractId: desk.contractId,
      method: "submit_order",
      args: [this.scvBytes(bundle.proof), this.scvBytes(bundle.publicInputs)],
    });
    await this.notes.update(offer.id, { status: "spent" });
    return { note: output };
  }

  // --- unshield ---------------------------------------------------------------------------------

  async unshield(params: UnshieldParams): Promise<void> {
    const desk = await this.p.desks.get(params.deskId);
    const offer = (await this.assemble(params.deskId, params.asset_id, params.amount)).note;
    await this.waitForConfirm(params.deskId, offer.id);
    const membership = await this.waitForNotePath(params.deskId, offer.owner_tag);

    const [nullifier, recipient] = await Promise.all([
      this.wallet.noteNullifier(offer.sk, offer.rho),
      recipientField(params.recipient),
    ]);
    const bundle = await this.prover.proveUnshield({
      rho_in: offer.rho,
      sk_o: offer.sk,
      path: membership.siblings,
      index_bits: membership.index_bits,
      root: membership.root,
      nullifier,
      asset: offer.asset_id,
      amount: offer.amount,
      recipient,
    });
    await this.p.submitter.submit({
      deskId: desk.id,
      contractId: desk.contractId,
      method: "unshield",
      args: [
        new Address(params.recipient).toScVal(),
        this.scvBytes(bundle.proof),
        this.scvBytes(bundle.publicInputs),
      ],
    });
    await this.notes.update(offer.id, { status: "spent" });
  }

  // --- cancel order -----------------------------------------------------------------------------

  async cancelOrder(params: CancelParams): Promise<{ note: Note }> {
    const desk = await this.p.desks.get(params.deskId);
    const note = (await this.notes.forDesk(params.deskId)).find((n) => n.id === params.noteId);
    const c = note?.cancel;
    if (!note || !c || note.status !== "active") throw new Error("The order is no longer cancellable.");

    const rho_return = randomField();
    const return_owner_tag = await this.wallet.noteTag(note.sk, rho_return);
    const bundle = await this.prover.proveCancel({
      sk_o: note.sk,
      rho_ord: c.rho_ord,
      order_leaf: c.order_leaf,
      cancel_owner_tag: c.cancel_owner_tag,
      return_owner_tag,
    });
    let refund: Note = {
      id: crypto.randomUUID(),
      deskId: desk.id,
      role: "asset",
      asset_id: c.asset_in,
      symbol: c.symbol_in,
      amount: c.amount_in,
      sk: note.sk,
      rho: rho_return,
      owner_tag: return_owner_tag,
      status: "active",
      indexed: false,
      createdAt: nowMs(),
    };
    [refund] = await this.prepareNotes([refund]);
    await this.notes.add(refund);
    await this.p.submitter.submit({
      deskId: desk.id,
      contractId: desk.contractId,
      method: "cancel_order",
      args: [
        nativeToScVal(c.pairId, { type: "u32" }),
        nativeToScVal(c.side, { type: "u32" }),
        this.scvBytes(bundle.proof),
        this.scvBytes(bundle.publicInputs),
      ],
    });
    await this.notes.update(note.id, { status: "cancelled", cancelledAt: nowMs() });
    return { note: refund };
  }

  // --- deploy / fund / loop / base --------------------------------------------------------------

  /** Deploy a new desk (requires a {@link Deployer}). Returns its config; register it with your
   * DeskProvider to operate on it. */
  async deploy(params: {
    name?: string;
    assets: AssetDef[];
    pairs: Omit<PairDef, "pair_id">[];
  }): Promise<DeskConfig> {
    if (!this.p.deployer) throw new Error("No Deployer configured (Node only).");
    const admin = await this.p.signer.address();
    const { contractId } = await this.p.deployer.deploySettlement({
      assets: params.assets,
      pairs: params.pairs,
      admin,
    });
    return {
      id: crypto.randomUUID(),
      name: params.name,
      contractId,
      sponsor: admin,
      assets: params.assets,
      pairs: params.pairs.map((p, i) => ({ ...p, pair_id: i })),
    };
  }

  /** Fund an account on testnet (requires a {@link Funder}). */
  async fund(address: string): Promise<void> {
    if (!this.p.funder) throw new Error("No Funder configured (Node only).");
    await this.p.funder.fund(address);
  }

  /** Start the local note-tracking loop: periodically reconcile the store against on-chain state. */
  startNoteLoop(deskId: string, opts: { intervalMs?: number } = {}): NoteLoop {
    const interval = setInterval(async () => {
      try {
        await this.notes.reconcile(deskId, await this.p.source.notes(deskId));
      } catch {
        /* transient; retry on next tick */
      }
    }, opts.intervalMs ?? 3_000);
    return { stop: () => clearInterval(interval) };
  }

  /** Base -> Stellar shield. Requires an {@link McpClient}; errors clearly otherwise. */
  async shieldFromBase(params: {
    deskId: string;
    asset_id: number;
    amount: Amount;
    baseTxHash: string;
  }): Promise<{ owner_tag: Field; txHash: string }> {
    if (!this.p.mcp) throw new Error("Base shielding requires an MCP (configure `mcp`).");
    const desk = await this.p.desks.get(params.deskId);
    const sk = randomField();
    const rho = randomField();
    const owner_tag = await this.wallet.noteTag(sk, rho);
    const asset = desk.assets.find((a) => a.asset_id === params.asset_id);
    let note: Note = {
      id: crypto.randomUUID(),
      deskId: desk.id,
      role: "asset",
      asset_id: params.asset_id,
      symbol: asset?.symbol ?? `#${params.asset_id}`,
      amount: params.amount,
      sk,
      rho,
      owner_tag,
      status: "active",
      indexed: false,
      createdAt: nowMs(),
    };
    [note] = await this.prepareNotes([note]);
    await this.notes.add(note);
    return this.p.mcp.baseShield({
      contractId: desk.contractId,
      asset_id: params.asset_id,
      amount: params.amount,
      owner_tag,
      baseTxHash: params.baseTxHash,
    });
  }

  /** Direct read access to the note manager (lists, recovery merge, etc.). */
  get noteManager(): NoteManager {
    return this.notes;
  }
}
