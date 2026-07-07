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
import { ActivityHistory, type ActivityEvent, type ActivityStore } from "./activity.js";
import { planAssembly, type AssemblyStep, type JoinInputRef } from "./orderPlan.js";
import { makeWalletMath, type WalletMath } from "./noirMath.js";
import { makeProver, type Prover } from "./prove.js";
import type { CircuitProvider } from "./circuits.js";
import type { NoirRuntimeOptions } from "./noirRuntime.js";
import { errorMessage, getMosaicLogger, serializeError, type MosaicLogger } from "./logging.js";
import type {
  Deployer,
  EthSigner,
  BaseBridgeDeployer,
  Funder,
  McpClient,
  NetworkConfig,
  NoteSource,
  NoteStore,
  StellarSigner,
  Submitter,
} from "./ports.js";
import { baseTokenAddress } from "./baseSepolia.js";
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
  /** Optional append-only public-safe activity history. */
  activity?: ActivityStore;
  /** Resolves desk config (contract id, assets, pairs). */
  desks: { get(deskId: string): Promise<DeskConfig> };
  circuits: CircuitProvider;
  /** Optional runtime hook for browser WASM loaders used by Noir. */
  noirRuntime?: NoirRuntimeOptions;
  /** Optional logger. Defaults to the SDK console logger. */
  logger?: MosaicLogger;
  funder?: Funder;
  deployer?: Deployer;
  baseBridgeDeployer?: BaseBridgeDeployer;
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

export class DeployDeskError extends Error {
  readonly partialDesk?: DeskConfig;

  constructor(message: string, partialDesk?: DeskConfig, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeployDeskError";
    this.partialDesk = partialDesk;
  }
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
  private readonly activity: ActivityHistory;

  constructor(ports: MosaicPorts) {
    this.p = ports;
    this.logger = ports.logger ?? getMosaicLogger();
    this.activity = new ActivityHistory(ports.activity);
    this.notes = new NoteManager(ports.store, ports.onNotesChanged, ports.activity);
    this.wallet = makeWalletMath(ports.circuits, ports.noirRuntime);
    this.prover = makeProver(ports.circuits, ports.noirRuntime);
  }

  private actionId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private async walletAddress(): Promise<string | undefined> {
    try {
      return await this.p.signer.address();
    } catch {
      return undefined;
    }
  }

  private async recordActivity(event: ActivityEvent): Promise<void> {
    try {
      await this.activity.record({
        network: this.p.network.networkPassphrase,
        ...event,
      });
    } catch (error) {
      this.logger.debug("activity record failed", { error });
    }
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

  private hexBytes(hex: string, bytes: number): Uint8Array {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(raw)) throw new Error(`expected ${bytes}-byte hex value`);
    return Uint8Array.from(Buffer.from(raw, "hex"));
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
  private async waitForConfirm(
    deskId: string,
    noteId: string,
    walletAddress?: string,
    timeoutMs = 120_000,
  ): Promise<Note> {
    const start = Date.now();
    for (;;) {
      try {
        await this.notes.reconcile(deskId, await this.p.source.notes(deskId));
      } catch {
        /* transient; retry */
      }
      const n = (await this.notes.forDesk(deskId, walletAddress)).find((x) => x.id === noteId);
      if (n?.status === "active" && n.indexed) return n;
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for note confirmation.");
      await sleep(3_000);
    }
  }

  // --- shield -----------------------------------------------------------------------------------

  async shield(params: ShieldParams): Promise<{ note: Note }> {
    let noteId: string | undefined;
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    try {
      this.logger.info("shield started", { deskId: params.deskId, assetId: params.asset_id, amount: params.amount });
      await this.recordActivity({
        kind: "user_action",
        action: "shield",
        status: "started",
        wallet_address: wallet,
        desk_id: params.deskId,
        metadata: { action_id: actionId, asset_id: params.asset_id, amount: params.amount },
      });
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
      await this.recordActivity({
        kind: "user_action",
        action: "shield",
        status: "staged",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: note.id,
        owner_tag,
        metadata: { action_id: actionId, asset_id: params.asset_id, symbol: asset.symbol, decimals: asset.decimals, amount: params.amount },
      });
      this.logger.info("shield note staged", { deskId: desk.id, noteId, assetId: params.asset_id, symbol: asset.symbol });

      const source = await this.p.signer.address();
      const res = await this.p.submitter.submit({
        deskId: desk.id,
        contractId: desk.contractId,
        method: "shield",
        metadata: { action_id: actionId, asset_id: params.asset_id, symbol: asset.symbol, decimals: asset.decimals, amount: params.amount },
        args: [
          new Address(source).toScVal(),
          nativeToScVal(params.asset_id, { type: "u32" }),
          nativeToScVal(BigInt(params.amount), { type: "i128" }),
          this.scvBytes(fieldToBytes32(owner_tag)),
        ],
      });
      await this.notes.update(note.id, { txHash: res.txHash });
      await this.recordActivity({
        kind: "user_action",
        action: "shield",
        status: "submitted",
        wallet_address: wallet,
        desk_id: desk.id,
        tx_hash: res.txHash,
        note_id: note.id,
        owner_tag,
        metadata: { action_id: actionId, method: "shield", status: res.status },
      });
      this.logger.info("shield transaction submitted", { deskId: desk.id, noteId, txHash: res.txHash });
      try {
        await this.waitForConfirm(desk.id, note.id, wallet, 30_000);
        await this.recordActivity({
          kind: "user_action",
          action: "shield",
          status: "succeeded",
          wallet_address: wallet,
          desk_id: desk.id,
          tx_hash: res.txHash,
          note_id: note.id,
          owner_tag,
          metadata: { action_id: actionId, indexed: true },
        });
        this.logger.info("shield note indexed", { deskId: desk.id, noteId });
      } catch (error) {
        this.logger.warn("shield note not indexed before timeout", { deskId: desk.id, noteId, error });
        await this.recordActivity({
          kind: "user_action",
          action: "shield",
          status: "succeeded",
          wallet_address: wallet,
          desk_id: desk.id,
          tx_hash: res.txHash,
          note_id: note.id,
          owner_tag,
          metadata: { action_id: actionId, indexed: false, index_timeout: true },
        });
        /* shield is final; leave it pending until the loop reconciles it */
      }
      return { note: (await this.notes.forDesk(desk.id, wallet)).find((n) => n.id === note.id) ?? note };
    } catch (error) {
      this.logger.error("shield failed", {
        deskId: params.deskId,
        noteId,
        message: errorMessage(error),
        error: serializeError(error),
      });
      await this.recordActivity({
        kind: "error",
        action: "shield",
        status: "failed",
        wallet_address: wallet,
        desk_id: params.deskId,
        note_id: noteId,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
  }

  // --- assemble (join/split) --------------------------------------------------------------------

  /** Produce one confirmed note of exactly `target` of `asset_id` (split/merge as needed). When a
   * `parent` operation drives the assembly, its join steps record under that operation's activity. */
  async assemble(
    deskId: string,
    asset_id: number,
    target: Amount,
    parent?: { actionId: string; kind: string },
  ): Promise<{ note: Note }> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    await this.recordActivity({
      kind: "user_action",
      action: "assemble",
      status: "started",
      wallet_address: wallet,
      desk_id: deskId,
      metadata: { action_id: actionId, asset_id, target },
    });
    try {
      const all = await this.notes.forDesk(deskId, wallet);
      const plan = planAssembly(all, asset_id, BigInt(target));
      if (plan.kind === "impossible") throw new Error(plan.reason);
      if (plan.kind === "direct") {
        const note = all.find((n) => n.id === plan.noteId);
        if (!note) throw new Error("The selected private note is no longer available.");
        await this.recordActivity({
          kind: "user_action",
          action: "assemble",
          status: "succeeded",
          wallet_address: wallet,
          desk_id: deskId,
          note_id: note.id,
          owner_tag: note.owner_tag,
          metadata: { action_id: actionId, mode: "direct", asset_id, target },
        });
        return { note };
      }
      const note = await this.runAssembly(deskId, plan.steps, all, wallet, parent);
      await this.recordActivity({
        kind: "user_action",
        action: "assemble",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: deskId,
        note_id: note.id,
        owner_tag: note.owner_tag,
        metadata: { action_id: actionId, mode: "join", asset_id, target, steps: plan.steps.length },
      });
      return { note };
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "assemble",
        status: "failed",
        wallet_address: wallet,
        desk_id: deskId,
        message: errorMessage(error),
        metadata: { action_id: actionId, asset_id, target, error: serializeError(error) },
      });
      throw error;
    }
  }

  private async runAssembly(
    deskId: string,
    steps: AssemblyStep[],
    pool: Note[],
    walletAddress?: string,
    parent?: { actionId: string; kind: string },
  ): Promise<Note> {
    const byId = new Map(pool.map((n) => [n.id, n]));
    const resolve = (ref: JoinInputRef, prev: Note | null) =>
      ref.type === "prev" ? prev : byId.get(ref.id) ?? null;
    let prev: Note | null = null;
    for (const step of steps) {
      const a = resolve(step.a, prev);
      const b = step.op === "join" ? resolve(step.b, prev) : null;
      if (!a || (step.op === "join" && !b)) throw new Error("A note is no longer available; please retry.");
      const { target } = await this.executeJoin(deskId, a, b, BigInt(step.targetRaw), BigInt(step.changeRaw), parent);
      prev = await this.waitForConfirm(deskId, target.id, walletAddress);
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
    parent?: { actionId: string; kind: string },
  ): Promise<{ target: Note; change: Note | null }> {
    // When a parent (order/unshield) drives this join, record it under the parent's activity group
    // (same action_id + kind) so every on-chain step of the operation shows as its own transaction
    // line. Standalone `assemble` calls keep their own group.
    const actionId = parent?.actionId ?? this.actionId();
    const wallet = await this.walletAddress();
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
    await this.recordActivity({
      kind: "user_action",
      action: "join",
      status: "staged",
      wallet_address: wallet,
      desk_id: desk.id,
      note_id: target.id,
      owner_tag: target.owner_tag,
      metadata: {
        action_id: actionId,
        kind: parent?.kind,
        input_note_ids: [a.id, b?.id].filter(Boolean),
        target_amount: targetRaw.toString(),
        change_note_id: change?.id,
        change_amount: changeRaw.toString(),
      },
    });

    const res = await this.p.submitter.submit({
      deskId: desk.id,
      contractId: desk.contractId,
      method: "join",
      metadata: { action_id: actionId },
      args: [this.scvBytes(bundle.proof), this.scvBytes(bundle.publicInputs)],
    });
    await this.notes.update(target.id, { txHash: res.txHash });
    if (change) await this.notes.update(change.id, { txHash: res.txHash });
    await this.notes.update(a.id, { status: "spent" });
    if (b) await this.notes.update(b.id, { status: "spent" });
    await this.recordActivity({
      kind: "user_action",
      action: "join",
      method: "join",
      status: "succeeded",
      wallet_address: wallet,
      desk_id: desk.id,
      tx_hash: res.txHash,
      note_id: target.id,
      owner_tag: target.owner_tag,
      metadata: { action_id: actionId, kind: parent?.kind, change_note_id: change?.id, status: res.status },
    });
    return { target, change };
  }

  // --- place order ------------------------------------------------------------------------------

  async placeOrder(params: OrderParams): Promise<{ note: Note }> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    await this.recordActivity({
      kind: "user_action",
      action: "place_order",
      status: "started",
      wallet_address: wallet,
      desk_id: params.deskId,
      metadata: {
        action_id: actionId,
        pair_id: params.pairId,
        side: params.side,
        amount_in: params.amountIn,
        min_out: params.minOut,
        partial_allowed: params.partialAllowed ?? false,
      },
    });
    try {
      const desk = await this.p.desks.get(params.deskId);
      const pair = desk.pairs.find((p) => p.pair_id === params.pairId);
      if (!pair) throw new Error("The requested pair is not registered on this desk.");
      const assetIn = params.side === SIDE_SELL ? pair.base_asset : pair.quote_asset;
      const assetOut = params.side === SIDE_SELL ? pair.quote_asset : pair.base_asset;

      const offer = (await this.assemble(params.deskId, assetIn, params.amountIn, { actionId, kind: "place_order" })).note;
      await this.waitForConfirm(params.deskId, offer.id, wallet);
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
      await this.recordActivity({
        kind: "user_action",
        action: "place_order",
        status: "staged",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: output.id,
        owner_tag: output.owner_tag,
        metadata: {
          action_id: actionId,
          input_note_id: offer.id,
          pair_id: params.pairId,
          base_symbol: this.symbolOf(desk, pair.base_asset),
          quote_symbol: this.symbolOf(desk, pair.quote_asset),
          base_decimals: desk.assets.find((a) => a.asset_id === pair.base_asset)?.decimals ?? 7,
          quote_decimals: desk.assets.find((a) => a.asset_id === pair.quote_asset)?.decimals ?? 7,
          asset_in: assetIn,
          asset_out: assetOut,
          amount_in: offer.amount,
          min_out: params.minOut,
          expiry,
          partial_allowed: partial === 1,
          order_leaf: terms.order_leaf,
        },
      });
      const res = await this.p.submitter.submit({
        deskId: desk.id,
        contractId: desk.contractId,
        method: "submit_order",
        metadata: { action_id: actionId },
        args: [this.scvBytes(bundle.proof), this.scvBytes(bundle.publicInputs)],
      });
      await this.notes.update(output.id, { txHash: res.txHash });
      await this.notes.update(offer.id, { status: "spent" });
      await this.recordActivity({
        kind: "user_action",
        action: "place_order",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: desk.id,
        tx_hash: res.txHash,
        note_id: output.id,
        owner_tag: output.owner_tag,
        metadata: { action_id: actionId, status: res.status },
      });
      return { note: { ...output, txHash: res.txHash } };
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "place_order",
        status: "failed",
        wallet_address: wallet,
        desk_id: params.deskId,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
  }

  // --- unshield ---------------------------------------------------------------------------------

  async unshield(params: UnshieldParams): Promise<void> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    await this.recordActivity({
      kind: "user_action",
      action: "unshield",
      status: "started",
      wallet_address: wallet,
      desk_id: params.deskId,
      metadata: { action_id: actionId, asset_id: params.asset_id, amount: params.amount, recipient: params.recipient },
    });
    try {
      const desk = await this.p.desks.get(params.deskId);
      const asset = desk.assets.find((a) => a.asset_id === params.asset_id);
      const offer = (await this.assemble(params.deskId, params.asset_id, params.amount, { actionId, kind: "unshield" })).note;
      await this.waitForConfirm(params.deskId, offer.id, wallet);
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
      await this.recordActivity({
        kind: "user_action",
        action: "unshield",
        status: "staged",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: offer.id,
        owner_tag: offer.owner_tag,
        metadata: {
          action_id: actionId,
          recipient: params.recipient,
          asset_id: offer.asset_id,
          symbol: asset?.symbol ?? offer.symbol,
          decimals: asset?.decimals,
          amount: offer.amount,
        },
      });
      const res = await this.p.submitter.submit({
        deskId: desk.id,
        contractId: desk.contractId,
        method: "unshield",
        metadata: { action_id: actionId },
        args: [
          new Address(params.recipient).toScVal(),
          this.scvBytes(bundle.proof),
          this.scvBytes(bundle.publicInputs),
        ],
      });
      await this.notes.update(offer.id, { status: "spent", txHash: res.txHash });
      await this.recordActivity({
        kind: "user_action",
        action: "unshield",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: desk.id,
        tx_hash: res.txHash,
        note_id: offer.id,
        owner_tag: offer.owner_tag,
        metadata: { action_id: actionId, status: res.status, recipient: params.recipient },
      });
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "unshield",
        status: "failed",
        wallet_address: wallet,
        desk_id: params.deskId,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
  }

  // --- cancel order -----------------------------------------------------------------------------

  async cancelOrder(params: CancelParams): Promise<{ note: Note }> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    await this.recordActivity({
      kind: "user_action",
      action: "cancel_order",
      status: "started",
      wallet_address: wallet,
      desk_id: params.deskId,
      note_id: params.noteId,
      metadata: { action_id: actionId },
    });
    try {
      const desk = await this.p.desks.get(params.deskId);
      const note = (await this.notes.forDesk(params.deskId, wallet)).find((n) => n.id === params.noteId);
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
      await this.recordActivity({
        kind: "user_action",
        action: "cancel_order",
        status: "staged",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: refund.id,
        owner_tag: refund.owner_tag,
        metadata: { action_id: actionId, cancelled_note_id: note.id, pair_id: c.pairId, side: c.side },
      });
      const res = await this.p.submitter.submit({
        deskId: desk.id,
        contractId: desk.contractId,
        method: "cancel_order",
        metadata: { action_id: actionId },
        args: [
          nativeToScVal(c.pairId, { type: "u32" }),
          nativeToScVal(c.side, { type: "u32" }),
          this.scvBytes(bundle.proof),
          this.scvBytes(bundle.publicInputs),
        ],
      });
      await this.notes.update(refund.id, { txHash: res.txHash });
      await this.notes.update(note.id, { status: "cancelled", cancelledAt: nowMs(), txHash: res.txHash });
      await this.recordActivity({
        kind: "user_action",
        action: "cancel_order",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: desk.id,
        tx_hash: res.txHash,
        note_id: refund.id,
        owner_tag: refund.owner_tag,
        metadata: { action_id: actionId, cancelled_note_id: note.id, status: res.status },
      });
      return { note: { ...refund, txHash: res.txHash } };
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "cancel_order",
        status: "failed",
        wallet_address: wallet,
        desk_id: params.deskId,
        note_id: params.noteId,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
  }

  // --- deploy / fund / loop / base --------------------------------------------------------------

  /** Deploy a new desk (requires a {@link Deployer}). Returns its config; register it with your
   * DeskProvider to operate on it. */
  async deploy(params: {
    name?: string;
    assets: AssetDef[];
    pairs: Omit<PairDef, "pair_id">[];
    base?: {
      assets: { asset_id: number; symbol: string; token: string }[];
      router_id: string;
      image_id: string;
      config_id: string;
      /** Wait for Base L1 finality before minting shielded notes. Default false. */
      require_finality?: boolean;
    };
  }): Promise<DeskConfig> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    let partialDesk: DeskConfig | undefined;
    await this.recordActivity({
      kind: "user_action",
      action: "create_desk",
      status: "started",
      wallet_address: wallet,
      metadata: { action_id: actionId, name: params.name, asset_count: params.assets.length, pair_count: params.pairs.length },
    });
    try {
      if (!this.p.deployer) throw new Error("No Deployer configured (Node only).");
      const admin = await this.p.signer.address();
      const deployed = await this.p.deployer.deploySettlement({
        assets: params.assets,
        pairs: params.pairs,
        admin,
      });
      if (deployed.uploadWasmTxHash || deployed.wasmHash) {
        await this.recordActivity({
          kind: "user_action",
          action: "update_wasm",
          status: "succeeded",
          wallet_address: wallet,
          tx_hash: deployed.uploadWasmTxHash,
          metadata: {
            action_id: actionId,
            step: 1,
            wasm_hash: deployed.wasmHash,
          },
        });
      }
      if (deployed.contractId || deployed.createContractTxHash) {
        await this.recordActivity({
          kind: "user_action",
          action: "create_contract",
          status: "succeeded",
          wallet_address: wallet,
          contract_id: deployed.contractId,
          tx_hash: deployed.createContractTxHash,
          metadata: {
            action_id: actionId,
            step: 2,
            contract_id: deployed.contractId,
          },
        });
      }
      const desk: DeskConfig = {
        id: crypto.randomUUID(),
        name: params.name,
        contractId: deployed.contractId,
        sponsor: admin,
        assets: params.assets,
        pairs: params.pairs.map((p, i) => ({ ...p, pair_id: i })),
      };
      partialDesk = desk;
      const baseAssets = params.base?.assets ?? [];
      if (params.base && baseAssets.length > 0) {
        if (!this.p.baseBridgeDeployer) throw new DeployDeskError("No BaseBridgeDeployer configured.", partialDesk);
        const assetIds = baseAssets.map((asset) => asset.asset_id);
        const tokens = baseAssets.map((asset) => baseTokenAddress(asset.token));
        desk.baseDeployment = {
          status: "awaiting_wallet",
          deployer_address: "",
          tx_hash: null,
          bridge_address: null,
          error: null,
          assets: baseAssets.map((asset, index) => ({ asset_id: asset.asset_id, symbol: asset.symbol, token: tokens[index] })),
          require_finality: params.base.require_finality === true,
        };
        partialDesk = desk;
        await this.recordActivity({
          kind: "user_action",
          action: "deploy_base_bridge",
          status: "started",
          wallet_address: wallet,
          desk_id: desk.id,
          contract_id: deployed.contractId,
          metadata: { action_id: actionId, asset_ids: assetIds },
        });
        let base;
        try {
          base = await this.p.baseBridgeDeployer.deploy({ assetIds, tokens });
        } catch (error) {
          desk.baseDeployment = { ...desk.baseDeployment, status: "failed", error: errorMessage(error) };
          throw new DeployDeskError(errorMessage(error), desk, { cause: error });
        }
        desk.baseDeployment = {
          ...desk.baseDeployment,
          status: "configuring",
          deployer_address: base.deployer,
          tx_hash: base.txHash,
          bridge_address: base.bridgeAddress,
          error: null,
        };
        partialDesk = desk;
        await this.recordActivity({
          kind: "user_action",
          action: "deploy_base_bridge",
          status: "succeeded",
          wallet_address: wallet,
          desk_id: desk.id,
          contract_id: deployed.contractId,
          tx_hash: base.txHash,
          metadata: { action_id: actionId, bridge_address: base.bridgeAddress, deployer: base.deployer },
        });
        let res;
        try {
          res = await this.p.submitter.submit({
            deskId: desk.id,
            contractId: desk.contractId,
            method: "configure_base_bridge",
            metadata: { action_id: actionId, bridge_address: base.bridgeAddress },
            args: [
              new Address(params.base.router_id).toScVal(),
              this.scvBytes(this.hexBytes(params.base.image_id, 32)),
              this.scvBytes(this.hexBytes(params.base.config_id, 32)),
              this.scvBytes(this.hexBytes(base.bridgeAddress, 20)),
            ],
          });
        } catch (error) {
          desk.baseDeployment = { ...desk.baseDeployment, status: "failed", error: errorMessage(error) };
          throw new DeployDeskError(errorMessage(error), desk, { cause: error });
        }
        desk.baseDeployment = { ...desk.baseDeployment, status: "active" };
        partialDesk = desk;
        await this.recordActivity({
          kind: "user_action",
          action: "configure_base_bridge",
          status: "succeeded",
          wallet_address: wallet,
          desk_id: desk.id,
          contract_id: deployed.contractId,
          tx_hash: res.txHash,
          metadata: { action_id: actionId, bridge_address: base.bridgeAddress },
        });
      }
      await this.recordActivity({
        kind: "user_action",
        action: "create_desk",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: desk.id,
        contract_id: deployed.contractId,
        metadata: {
          action_id: actionId,
          name: params.name,
          admin,
          upload_wasm_tx_hash: deployed.uploadWasmTxHash,
          create_contract_tx_hash: deployed.createContractTxHash,
          wasm_hash: deployed.wasmHash,
        },
      });
      return desk;
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "create_desk",
        status: "failed",
        wallet_address: wallet,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      if (partialDesk && !(error instanceof DeployDeskError)) {
        throw new DeployDeskError(errorMessage(error), partialDesk, { cause: error });
      }
      throw error;
    }
  }

  /** Fund an account on testnet (requires a {@link Funder}). */
  async fund(address: string): Promise<void> {
    const actionId = this.actionId();
    await this.recordActivity({
      kind: "user_action",
      action: "fund",
      status: "started",
      wallet_address: address,
      metadata: { action_id: actionId },
    });
    try {
      if (!this.p.funder) throw new Error("No Funder configured (Node only).");
      await this.p.funder.fund(address);
      await this.recordActivity({
        kind: "user_action",
        action: "fund",
        status: "succeeded",
        wallet_address: address,
        metadata: { action_id: actionId },
      });
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "fund",
        status: "failed",
        wallet_address: address,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
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

  /**
   * Base -> Stellar shield via the durable server worker. Requires an {@link McpClient}.
   *
   * The Base deposit must already be made *with the returned note's owner tag* — that is the privacy
   * binding, so the caller derives the note here, deposits on Base with `note.owner_tag`, and passes
   * the resulting `deposit_id`. This enqueues the durable prove -> finality -> mint job and polls it
   * to a terminal state. (The browser client drives the same MCP tools directly and need not block.)
   */
  async shieldFromBase(params: {
    deskId: string;
    asset_id: number;
    amount: Amount;
    /** The MosaicBridge deposit counter for the on-chain deposit (bound to `note.owner_tag`). */
    deposit_id: number;
    /** Poll cadence + ceiling while waiting for the ~10-minute prove + finality to complete. */
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ owner_tag: Field; note_id: string; job_id: string; status: string }> {
    const actionId = this.actionId();
    const wallet = await this.walletAddress();
    await this.recordActivity({
      kind: "user_action",
      action: "shield_from_base",
      status: "started",
      wallet_address: wallet,
      desk_id: params.deskId,
      metadata: { action_id: actionId, asset_id: params.asset_id, amount: params.amount, deposit_id: params.deposit_id },
    });
    try {
      if (!this.p.mcp) throw new Error("Base shielding requires an MCP (configure `mcp`).");
      const desk = await this.p.desks.get(params.deskId);
      const config = await this.p.mcp.baseShieldConfig(params.deskId);
      if (!config.available || !config.bridge) {
        throw new Error(`Base shielding is not available for this desk (${config.reason ?? "unavailable"}).`);
      }
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
      await this.recordActivity({
        kind: "user_action",
        action: "shield_from_base",
        status: "staged",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: note.id,
        owner_tag,
        metadata: { action_id: actionId, asset_id: params.asset_id, amount: params.amount, deposit_id: params.deposit_id },
      });
      const job = await this.p.mcp.enqueueBaseShield(params.deskId, {
        expected_bridge: config.bridge,
        deposit_id: params.deposit_id,
        // Display metadata for Activity: lets any browser render the job's entry with the amount
        // even though this path never writes a local deposit event. (No Base tx hash here — the
        // caller made the deposit before calling in, and only passes its deposit_id.)
        deposit: {
          asset_id: params.asset_id,
          symbol: asset?.symbol,
          decimals: asset?.decimals,
          amount: params.amount,
        },
      });
      const final = await this.pollBaseShield(params.deskId, job.id, params.pollIntervalMs, params.timeoutMs);
      if (final.status === "failed") throw new Error(final.error ?? "base shield failed on the server");
      await this.recordActivity({
        kind: "user_action",
        action: "shield_from_base",
        status: "succeeded",
        wallet_address: wallet,
        desk_id: desk.id,
        note_id: note.id,
        owner_tag,
        metadata: { action_id: actionId, deposit_id: params.deposit_id, job_id: job.id },
      });
      return { owner_tag, note_id: note.id, job_id: job.id, status: final.status };
    } catch (error) {
      await this.recordActivity({
        kind: "error",
        action: "shield_from_base",
        status: "failed",
        wallet_address: wallet,
        desk_id: params.deskId,
        message: errorMessage(error),
        metadata: { action_id: actionId, error: serializeError(error) },
      });
      throw error;
    }
  }

  /** Poll a durable base-shield job until it reaches a terminal state (or the timeout elapses). */
  private async pollBaseShield(
    deskId: string,
    jobId: string,
    intervalMs = 12_000,
    timeoutMs = 30 * 60_000,
  ): Promise<{ status: string; error?: string | null }> {
    if (!this.p.mcp) throw new Error("Base shielding requires an MCP (configure `mcp`).");
    const deadline = nowMs() + timeoutMs;
    for (;;) {
      const jobs = await this.p.mcp.listBaseShields(deskId);
      const job = jobs.find((j) => j.id === jobId);
      if (job && (job.status === "active" || job.status === "failed")) {
        return { status: job.status, error: job.error };
      }
      if (nowMs() > deadline) return { status: "failed", error: "timed out waiting for base shield" };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Direct read access to the note manager (lists, recovery merge, etc.). */
  get noteManager(): NoteManager {
    return this.notes;
  }

  get history(): ActivityHistory {
    return this.activity;
  }
}
