// @mosaic/sdk/node — Node client factory. Wires the core to Node-native adapters for fully-local
// operation: SecretKeySigner (raw S... seed, signs + pays its own fees), DirectSubmitter,
// LocalPathProvider over the on-chain ChainEventSource, the bundled circuit provider, and (when a
// Friendbot URL is configured) a Funder. No backend required; an McpClient can be supplied for the
// Base flow.
//
// Storage defaults to in-memory; pass a durable `store` (e.g. a SQLite-backed NoteStore) to persist
// notes across runs.

import { Noir } from "@noir-lang/noir_js";
import { MosaicClient } from "./client.js";
import { SecretKeySigner } from "./secretKeySigner.js";
import { MemoryStore } from "./memoryStore.js";
import { DirectSubmitter } from "./submit.js";
import { ChainEventSource } from "./chainEvents.js";
import { LocalPathProvider } from "./localPathProvider.js";
import { makeNoirCompressor } from "./noirCompressor.js";
import { StaticDeskProvider } from "./deskRegistry.js";
import { FriendbotFunder } from "./friendbot.js";
import { SqliteStore } from "./sqliteStore.js";
import { circuitProvider } from "./assets.node.js";
import type { Deployer, McpClient, NetworkConfig, NoteStore } from "./ports.js";
import type { DeskConfig } from "./types.js";

export { SqliteStore } from "./sqliteStore.js";
export { SecretKeySigner } from "./secretKeySigner.js";
export { StellarCliDeployer } from "./stellarCliDeployer.js";

export interface NodeClientOptions {
  network: NetworkConfig;
  /** Stellar secret seed (S...) used to sign and pay for transactions in local mode. */
  secretKey: string;
  /** Durable note store. Defaults to a SQLite store at `dbPath`, or in-memory when neither is set. */
  store?: NoteStore;
  /** SQLite database path for note persistence (used when `store` is omitted). */
  dbPath?: string;
  /** Desks to pre-register (e.g. from a deploy result or config). */
  desks?: DeskConfig[];
  /** First ledger to read note-tree events from (required before the per-desk event cursor exists). */
  startLedger?: number;
  /** Optional MCP for the Base→Stellar shield flow. */
  mcp?: McpClient;
  /** Optional deployer (e.g. one that shells to the `stellar` CLI) enabling `client.deploy`. */
  deployer?: Deployer;
}

export interface NodeClient {
  client: MosaicClient;
  /** The desk registry — register desks here after deploying/importing them. */
  desks: StaticDeskProvider;
}

/** Build a fully-local Node {@link MosaicClient}. Returns the client and its desk registry. */
export function createNodeClient(opts: NodeClientOptions): NodeClient {
  const signer = new SecretKeySigner(opts.secretKey);
  const store = opts.store ?? (opts.dbPath ? new SqliteStore(opts.dbPath) : new MemoryStore());
  const desks = new StaticDeskProvider(opts.desks ?? []);
  const submitter = new DirectSubmitter({ network: opts.network, signer });
  const chain = new ChainEventSource({ network: opts.network, startLedger: opts.startLedger });

  // The compress circuit is loaded lazily (and only once) for the local Merkle-path tree.
  let compressNoir: Noir | undefined;
  const compress = makeNoirCompressor({
    execute: async (inputs) => {
      compressNoir ??= new Noir(await circuitProvider("compress"));
      return compressNoir.execute(inputs as never);
    },
  });
  const source = new LocalPathProvider({
    compress,
    events: async (deskId) => chain.events((await desks.get(deskId)).contractId),
  });

  const funder = opts.network.friendbotUrl
    ? new FriendbotFunder(opts.network.friendbotUrl)
    : undefined;

  const client = new MosaicClient({
    network: opts.network,
    signer,
    store,
    source,
    submitter,
    desks,
    circuits: circuitProvider,
    funder,
    deployer: opts.deployer,
    mcp: opts.mcp,
  });
  return { client, desks };
}
