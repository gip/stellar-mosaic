// @mosaic/sdk/browser — browser client factory. Wires the core to browser-native adapters for
// fully-local operation: a caller-supplied StellarSigner (e.g. a Freighter-backed one) and NoteStore
// (e.g. IndexedDB), plus DirectSubmitter, LocalPathProvider over the on-chain ChainEventSource, the
// fetched circuit provider, and a Friendbot funder. Signing and storage are injected because they
// depend on app-level packages (the Freighter extension, idb) that the SDK does not pull in.
//
// This makes a backend OPTIONAL in the browser. An McpClient can be supplied for the Base flow.

import { Noir } from "@noir-lang/noir_js";
import { BASE_FEE, Contract, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { MosaicClient } from "./client.js";
import { DirectSubmitter } from "./submit.js";
import { ChainEventSource, type ChainEventCache } from "./chainEvents.js";
import { LocalPathProvider } from "./localPathProvider.js";
import { makeNoirCompressor } from "./noirCompressor.js";
import { StaticDeskProvider } from "./deskRegistry.js";
import { FriendbotFunder } from "./friendbot.js";
import { loadSettlementWasm, loadVk, circuitProvider } from "./assets.browser.js";
import { StellarRpcDeployer } from "./stellarRpcDeployer.js";
import { replayNoteEvents } from "./eventReplay.js";
import type { Deployer, McpClient, NetworkConfig, NoteStore, StellarSigner } from "./ports.js";
import type { DeskConfig, Field, Note } from "./types.js";
import { initNoirRuntime, type NoirRuntimeOptions } from "./noirRuntime.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";
import type { ActivityStore } from "./activity.js";

export interface BrowserClientOptions {
  network: NetworkConfig;
  /** App-supplied signer (e.g. a Freighter-backed StellarSigner). */
  signer: StellarSigner;
  /** App-supplied note store (e.g. an IndexedDB-backed NoteStore). */
  store: NoteStore;
  /** Optional app-supplied activity store. Defaults to `store` when it also implements ActivityStore. */
  activity?: ActivityStore;
  /** Desks to pre-register. */
  desks?: DeskConfig[];
  /** First ledger to read note-tree events from. */
  startLedger?: number;
  /** Notified after note mutations (e.g. dispatch a DOM event to refresh React). */
  onNotesChanged?: () => void;
  /** Protect or annotate newly-created notes before direct browser submissions. */
  prepareNotes?: (notes: Note[]) => Promise<Note[]>;
  /** Optional runtime hook for apps that serve Noir WASM from app-controlled URLs. */
  initNoir?: NoirRuntimeOptions["initNoir"];
  /** Optional logger. Defaults to the SDK console logger. */
  logger?: MosaicLogger;
  /** Optional durable event cache for trustless replay across browser reloads. */
  eventCache?: ChainEventCache;
  /** Optional MCP for the Base→Stellar shield flow. */
  mcp?: McpClient;
  /** Optional self-funded deployer. In browser apps this should sign with the connected wallet. */
  deployer?: Deployer;
}

function asActivityStore(store: NoteStore): ActivityStore | undefined {
  const candidate = store as Partial<ActivityStore>;
  return typeof candidate.record === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.since === "function"
    ? (store as unknown as ActivityStore)
    : undefined;
}

export interface BrowserClient {
  client: MosaicClient;
  desks: StaticDeskProvider;
}

function bytesToField(value: unknown): Field {
  const bytes =
    value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array((value as ArrayBufferView).buffer) : null;
  if (!bytes) throw new Error("contract root returned non-bytes");
  return `0x${Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

async function readRoot(network: NetworkConfig, contractId: string, sourceAccount: string): Promise<Field> {
  const server = new rpc.Server(network.rpcUrl);
  const account = await server.getAccount(sourceAccount);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: network.networkPassphrase })
    .addOperation(new Contract(contractId).call("root"))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
    throw new Error("root simulation failed");
  }
  return bytesToField(scValToNative(simulation.result.retval));
}

/** Build a fully-local browser {@link MosaicClient}. Returns the client and its desk registry. */
export function createBrowserClient(opts: BrowserClientOptions): BrowserClient {
  const logger = opts.logger ?? getMosaicLogger();
  const activity = opts.activity ?? asActivityStore(opts.store);
  const desks = new StaticDeskProvider(opts.desks ?? []);
  const submitter = new DirectSubmitter({ network: opts.network, signer: opts.signer, logger, activity });
  const chain = new ChainEventSource({ network: opts.network, startLedger: opts.startLedger, logger, cache: opts.eventCache, activity });
  const noirRuntime: NoirRuntimeOptions | undefined = opts.initNoir
    ? { initNoir: opts.initNoir }
    : undefined;

  let compressNoir: Noir | undefined;
  const compress = makeNoirCompressor({
    execute: async (inputs) => {
      await initNoirRuntime(noirRuntime);
      compressNoir ??= new Noir(await circuitProvider("compress"));
      return compressNoir.execute(inputs as never);
    },
  });
  const source = new LocalPathProvider({
    compress,
    events: async (deskId) => {
      const desk = await desks.get(deskId);
      return chain.events(desk.contractId, undefined, {
        validateReplay: async (events) => {
          const [state, root] = await Promise.all([
            replayNoteEvents({ events, compress }),
            readRoot(opts.network, desk.contractId, await opts.signer.address()),
          ]);
          if (state.root.toLowerCase() !== root.toLowerCase()) {
            throw new Error("retained event replay root does not match the live contract root");
          }
        },
      });
    },
    fills: async (deskId) => {
      const desk = await desks.get(deskId);
      return chain.fills(desk.contractId, undefined, {
        validateReplay: async (events) => {
          const [state, root] = await Promise.all([
            replayNoteEvents({ events, compress }),
            readRoot(opts.network, desk.contractId, await opts.signer.address()),
          ]);
          if (state.root.toLowerCase() !== root.toLowerCase()) {
            throw new Error("retained event replay root does not match the live contract root");
          }
        },
      });
    },
    logger,
  });

  const funder = opts.network.friendbotUrl
    ? new FriendbotFunder(opts.network.friendbotUrl)
    : undefined;
  const deployer =
    opts.deployer ??
    new StellarRpcDeployer({
      network: opts.network,
      signer: opts.signer,
      loadSettlementWasm,
      loadVk,
    });

  const client = new MosaicClient({
    network: opts.network,
    signer: opts.signer,
    store: opts.store,
    activity,
    source,
    submitter,
    desks,
    circuits: circuitProvider,
    noirRuntime,
    logger,
    funder,
    onNotesChanged: opts.onNotesChanged,
    prepareNotes: opts.prepareNotes,
    mcp: opts.mcp,
    deployer,
  });
  return { client, desks };
}
