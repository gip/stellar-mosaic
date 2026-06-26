// @mosaic/sdk/node — Node client factory. Wires the core to Node-native adapters for fully-local
// operation: SecretKeySigner (raw S... seed, signs + pays its own fees), DirectSubmitter,
// LocalPathProvider over the on-chain ChainEventSource, the bundled circuit provider, and (when a
// Friendbot URL is configured) a Funder. No backend required; an McpClient can be supplied for the
// Base flow.
//
// Storage defaults to in-memory; pass a durable `store` (e.g. a SQLite-backed NoteStore) to persist
// notes across runs.

import { Noir } from "@noir-lang/noir_js";
import { BASE_FEE, Contract, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { MosaicClient } from "./client.js";
import { SecretKeySigner } from "./secretKeySigner.js";
import { MemoryStore } from "./memoryStore.js";
import { DirectSubmitter } from "./submit.js";
import { ChainEventSource, type ChainEventCache } from "./chainEvents.js";
import { LocalPathProvider } from "./localPathProvider.js";
import { makeNoirCompressor } from "./noirCompressor.js";
import { StaticDeskProvider } from "./deskRegistry.js";
import { FriendbotFunder } from "./friendbot.js";
import { SqliteStore } from "./sqliteStore.js";
import { circuitProvider } from "./assets.node.js";
import { replayNoteEvents } from "./eventReplay.js";
import type { Deployer, McpClient, NetworkConfig, NoteStore } from "./ports.js";
import type { DeskConfig, Field } from "./types.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";
import type { ActivityStore } from "./activity.js";

export { SqliteStore } from "./sqliteStore.js";
export { SecretKeySigner } from "./secretKeySigner.js";
export { StellarCliDeployer } from "./stellarCliDeployer.js";

export interface NodeClientOptions {
  network: NetworkConfig;
  /** Stellar secret seed (S...) used to sign and pay for transactions in local mode. */
  secretKey: string;
  /** Durable note store. Defaults to a SQLite store at `dbPath`, or in-memory when neither is set. */
  store?: NoteStore;
  /** Durable activity store. Defaults to the configured store when it implements ActivityStore. */
  activity?: ActivityStore;
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
  /** Optional logger. Defaults to the SDK console logger. */
  logger?: MosaicLogger;
  /** Optional durable event cache for local replay across process restarts. */
  eventCache?: ChainEventCache;
}

function asActivityStore(store: NoteStore): ActivityStore | undefined {
  const candidate = store as Partial<ActivityStore>;
  return typeof candidate.record === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.since === "function"
    ? (store as unknown as ActivityStore)
    : undefined;
}

export interface NodeClient {
  client: MosaicClient;
  /** The desk registry — register desks here after deploying/importing them. */
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

/** Build a fully-local Node {@link MosaicClient}. Returns the client and its desk registry. */
export function createNodeClient(opts: NodeClientOptions): NodeClient {
  const logger = opts.logger ?? getMosaicLogger();
  const signer = new SecretKeySigner(opts.secretKey);
  const store = opts.store ?? (opts.dbPath ? new SqliteStore(opts.dbPath) : new MemoryStore());
  const activity = opts.activity ?? asActivityStore(store);
  const desks = new StaticDeskProvider(opts.desks ?? []);
  const submitter = new DirectSubmitter({ network: opts.network, signer, logger, activity });
  const chain = new ChainEventSource({ network: opts.network, startLedger: opts.startLedger, logger, cache: opts.eventCache, activity });

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
    events: async (deskId) => {
      const desk = await desks.get(deskId);
      return chain.events(desk.contractId, undefined, {
        validateReplay: async (events) => {
          const [state, root] = await Promise.all([
            replayNoteEvents({ events, compress }),
            readRoot(opts.network, desk.contractId, await signer.address()),
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

  const client = new MosaicClient({
    network: opts.network,
    signer,
    store,
    activity,
    source,
    submitter,
    desks,
    circuits: circuitProvider,
    logger,
    funder,
    deployer: opts.deployer,
    mcp: opts.mcp,
  });
  return { client, desks };
}
