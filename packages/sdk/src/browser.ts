// @mosaic/sdk/browser — browser client factory. Wires the core to browser-native adapters for
// fully-local operation: a caller-supplied StellarSigner (e.g. a Freighter-backed one) and NoteStore
// (e.g. IndexedDB), plus DirectSubmitter, LocalPathProvider over the on-chain ChainEventSource, the
// fetched circuit provider, and a Friendbot funder. Signing and storage are injected because they
// depend on app-level packages (the Freighter extension, idb) that the SDK does not pull in.
//
// This makes a backend OPTIONAL in the browser. An McpClient can be supplied for the Base flow.

import { Noir } from "@noir-lang/noir_js";
import { MosaicClient } from "./client.js";
import { DirectSubmitter } from "./submit.js";
import { ChainEventSource } from "./chainEvents.js";
import { LocalPathProvider } from "./localPathProvider.js";
import { makeNoirCompressor } from "./noirCompressor.js";
import { StaticDeskProvider } from "./deskRegistry.js";
import { FriendbotFunder } from "./friendbot.js";
import { loadSettlementWasm, loadVk, circuitProvider } from "./assets.browser.js";
import { StellarRpcDeployer } from "./stellarRpcDeployer.js";
import type { Deployer, McpClient, NetworkConfig, NoteStore, StellarSigner } from "./ports.js";
import type { DeskConfig, Note } from "./types.js";
import { initNoirRuntime, type NoirRuntimeOptions } from "./noirRuntime.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";

export interface BrowserClientOptions {
  network: NetworkConfig;
  /** App-supplied signer (e.g. a Freighter-backed StellarSigner). */
  signer: StellarSigner;
  /** App-supplied note store (e.g. an IndexedDB-backed NoteStore). */
  store: NoteStore;
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
  /** Optional MCP for the Base→Stellar shield flow. */
  mcp?: McpClient;
  /** Optional self-funded deployer. In browser apps this should sign with the connected wallet. */
  deployer?: Deployer;
}

export interface BrowserClient {
  client: MosaicClient;
  desks: StaticDeskProvider;
}

/** Build a fully-local browser {@link MosaicClient}. Returns the client and its desk registry. */
export function createBrowserClient(opts: BrowserClientOptions): BrowserClient {
  const logger = opts.logger ?? getMosaicLogger();
  const desks = new StaticDeskProvider(opts.desks ?? []);
  const submitter = new DirectSubmitter({ network: opts.network, signer: opts.signer, logger });
  const chain = new ChainEventSource({ network: opts.network, startLedger: opts.startLedger, logger });
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
    events: async (deskId) => chain.events((await desks.get(deskId)).contractId),
    fills: async (deskId) => chain.fills((await desks.get(deskId)).contractId),
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
