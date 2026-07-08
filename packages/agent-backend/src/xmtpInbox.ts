// XMTP inbox worker: the backend's known XMTP identity (an EOA from MOSAIC_AGENT_XMTP_KEY)
// receives session-log DMs from agents and persists them. `handleInboundLog` is the pure,
// testable core — sender resolution and the XMTP client are injected. Idempotency comes from the
// store's UNIQUE(session_id, seq); ordering comes from reading by seq, so out-of-order delivery
// and redelivery are both harmless.

import { Client, type ClientOptions, type DecodedMessage, type IdentifierKind, type Signer } from "@xmtp/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, toBytes } from "viem";
import type { AgentRecord, LogEnvelope } from "@mosaic/agent-sdk";
import type { AgentBackendConfig } from "./config.js";
import type { AgentStore } from "./store.js";

const ETHEREUM: IdentifierKind = 0 as IdentifierKind; // IdentifierKind.Ethereum (ambient const enum)
const MAX_CONTENT_BYTES = 64 * 1024;

export interface XmtpInboxHandle {
  address: `0x${string}`;
  inboxId: string;
  stop(): Promise<void>;
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function eoaSigner(ethKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(ethKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: ETHEREUM }),
    signMessage: async (message: string) => toBytes(await account.signMessage({ message })),
  };
}

/** Parse + shape-check one inbound text message; null (with a reason) when it isn't a valid log
 *  envelope. Non-mosaic messages are silently ignored — the inbox address is public, so arbitrary
 *  DMs are expected. */
export function parseLogEnvelope(content: string): { envelope: LogEnvelope } | { reason: string | null } {
  if (content.length > MAX_CONTENT_BYTES) return { reason: `message exceeds ${MAX_CONTENT_BYTES} bytes` };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { reason: null };
  }
  if (typeof parsed !== "object" || parsed === null || parsed.mosaic !== "agent-log/v1") return { reason: null };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) return { reason: "missing session_id" };
  if (!Number.isInteger(parsed.seq) || (parsed.seq as number) < 1) return { reason: "seq must be a positive integer" };
  if (typeof parsed.at !== "number") return { reason: "missing at" };
  if (parsed.visibility !== "public" && parsed.visibility !== "private") return { reason: "invalid visibility" };
  if (parsed.kind !== "session_start" && parsed.kind !== "log" && parsed.kind !== "session_end") {
    return { reason: "invalid kind" };
  }
  return { envelope: parsed as unknown as LogEnvelope };
}

export interface InboundLogDeps {
  store: AgentStore;
  ownInboxId: string;
  /** Lowercase eth addresses associated with a sender inbox. */
  resolveSenderAddresses(senderInboxId: string): Promise<string[]>;
  log: Logger;
}

export type InboundLogResult = "stored" | "duplicate" | "ignored";

/** Validate and persist one inbound message. Every rejection is a warn + "ignored" — the sender is
 *  untrusted, so nothing here throws back into the stream. */
export async function handleInboundLog(
  deps: InboundLogDeps,
  message: { senderInboxId: string; content: unknown },
): Promise<InboundLogResult> {
  if (message.senderInboxId === deps.ownInboxId) return "ignored";
  if (typeof message.content !== "string") return "ignored"; // group-membership updates etc.

  const parsed = parseLogEnvelope(message.content);
  if ("reason" in parsed) {
    if (parsed.reason) deps.log.warn(`xmtp log from ${message.senderInboxId} rejected: ${parsed.reason}`);
    return "ignored";
  }
  const envelope = parsed.envelope;

  const addresses = await deps.resolveSenderAddresses(message.senderInboxId);
  const agents: AgentRecord[] = [];
  for (const address of addresses) {
    const agent = await deps.store.agentByEthAddress(address);
    if (agent && !agent.revoked && !agents.some((a) => a.id === agent.id)) agents.push(agent);
  }
  if (agents.length !== 1) {
    deps.log.warn(`xmtp log from ${message.senderInboxId} rejected: ${agents.length} registered agents match the sender`);
    return "ignored";
  }
  const agent = agents[0]!;

  const session = await deps.store.getAgentSession(envelope.session_id);
  if (!session || session.agent_id !== agent.id) {
    deps.log.warn(`xmtp log from agent ${agent.id} rejected: session ${envelope.session_id} unknown or not theirs`);
    return "ignored";
  }

  const inserted = await deps.store.insertLogEntry({
    session_id: envelope.session_id,
    agent_id: agent.id,
    seq: envelope.seq,
    at: envelope.at,
    visibility: envelope.visibility,
    kind: envelope.kind,
    payload: envelope.payload,
  });
  if (envelope.kind === "session_end") await deps.store.endAgentSession(envelope.session_id);
  return inserted ? "stored" : "duplicate";
}

export async function startXmtpInbox(config: AgentBackendConfig, store: AgentStore, log: Logger): Promise<XmtpInboxHandle> {
  if (!config.xmtp.key || !config.xmtp.dbKey) {
    throw new Error("startXmtpInbox needs MOSAIC_AGENT_XMTP_KEY and MOSAIC_AGENT_XMTP_DB_KEY");
  }
  const address = privateKeyToAccount(config.xmtp.key).address;
  // Cast as in agents/src/xmtp.ts: create()'s Omit<ClientOptions, "codecs"> collapses the
  // NetworkOptions union and hides `env`, but it is a valid runtime option.
  const client = await Client.create(eoaSigner(config.xmtp.key), {
    env: config.xmtp.env,
    dbPath: config.xmtp.dbPath,
    dbEncryptionKey: hexToBytes(config.xmtp.dbKey),
  } as ClientOptions);

  // inboxId → eth addresses, cached: identity associations are effectively append-only for our
  // purposes, and a stale miss just falls through to a network fetch on the next message.
  const addressCache = new Map<string, string[]>();
  const resolveSenderAddresses = async (senderInboxId: string): Promise<string[]> => {
    const cached = addressCache.get(senderInboxId);
    if (cached && cached.length > 0) return cached;
    let states = await client.preferences.getInboxStates([senderInboxId]).catch(() => []);
    if (!states.some((s) => s.identifiers.length > 0)) {
      states = await client.preferences.fetchInboxStates([senderInboxId]).catch(() => []);
    }
    const addresses = states
      .flatMap((s) => s.identifiers)
      .filter((i) => i.identifierKind === ETHEREUM)
      .map((i) => i.identifier.toLowerCase());
    addressCache.set(senderInboxId, addresses);
    return addresses;
  };

  const deps: InboundLogDeps = { store, ownInboxId: client.inboxId, resolveSenderAddresses, log };

  // No consent filter: a first-contact DM arrives with Unknown consent. The SDK's built-in retry
  // keeps the stream alive across transient network failures (long-running server context).
  const stream = await client.conversations.streamAllMessages({
    onValue: (message: DecodedMessage) => {
      void handleInboundLog(deps, message).catch((error: unknown) => {
        log.warn(`xmtp inbox handler error: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onError: (error: Error) => log.warn(`xmtp stream error: ${error.message}`),
    onRetry: (attempt: number, max: number) => log.warn(`xmtp stream retrying (${attempt}/${max})`),
    onRestart: () => log.info("xmtp stream restarted"),
    onFail: () => log.warn("xmtp stream failed permanently — restart the backend to resume log ingest"),
    retryOnFail: true,
    retryAttempts: 1_000_000,
    retryDelay: 10_000,
  });

  return {
    address,
    inboxId: client.inboxId,
    stop: async () => {
      await stream.end().catch(() => {});
    },
  };
}
