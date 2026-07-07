// One XMTP client per agent process, serving both capabilities: pairwise DMs with configured
// peers (the negotiation channel) and the DM to the backend's known address (the session-log
// channel). Adapted from agents/src/xmtp.ts; a single client avoids two processes contending for
// the same local encrypted db, since both identities are the agent's derived eth key.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  Client,
  type ClientOptions,
  type DecodedMessage,
  type Dm,
  type Identifier,
  type IdentifierKind,
  type Signer,
} from "@xmtp/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, toBytes } from "viem";
import type { AgentIdentity } from "../derive.js";

const ETHEREUM: IdentifierKind = 0 as IdentifierKind; // IdentifierKind.Ethereum (ambient const enum)

export interface InboxMessage {
  from: string;
  text: string;
}

export interface XmtpTranscriptEntry {
  direction: "sent" | "received";
  peer: string;
  text: string;
  at: string;
}

export interface AgentXmtp {
  client: Client<unknown>;
  peers: { name: string; ethAddress: `0x${string}` }[];
  inbox: InboxMessage[];
  transcript: XmtpTranscriptEntry[];
  /** Open DMs with the configured peers and start the inbound stream. Peers come from the
   *  backend-served agent config, which is only available after agent auth — hence a second step. */
  connectPeers(peers: { name: string; ethAddress: `0x${string}` }[]): Promise<void>;
  send(to: string | undefined, text: string): Promise<void>;
  /** Send one raw text message to the backend's log inbox; null when the backend has no inbox. */
  sendToBackend: ((text: string) => Promise<void>) | null;
}

function eoaSigner(ethKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(ethKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: ETHEREUM }),
    signMessage: async (message: string) => toBytes(await account.signMessage({ message })),
  };
}

async function waitReachable(identifier: Identifier, env: string, what: string, log: (l: string) => void): Promise<void> {
  for (let i = 0; ; i++) {
    const reachable = (await Client.canMessage([identifier], env as "dev")).get(identifier.identifier);
    if (reachable) return;
    if (i === 0) log(`waiting for ${what} (${identifier.identifier}) to register on xmtp…`);
    if (i > 90) throw new Error(`${what} (${identifier.identifier}) never registered on the xmtp ${env} network`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function buildAgentXmtp(opts: {
  identity: AgentIdentity;
  backendXmtpAddress: `0x${string}` | null;
  env: "dev" | "production" | "local";
  dataDir: string;
  log: (line: string) => void;
}): Promise<AgentXmtp> {
  mkdirSync(opts.dataDir, { recursive: true });
  // Cast as in agents/src/xmtp.ts: create()'s Omit<ClientOptions, "codecs"> collapses the
  // NetworkOptions union and hides `env`, but it is a valid runtime option.
  const client = await Client.create(eoaSigner(opts.identity.ethKey), {
    env: opts.env,
    dbPath: join(opts.dataDir, "xmtp.db3"),
    dbEncryptionKey: hexToBytes(opts.identity.xmtpDbKey),
  } as ClientOptions);
  opts.log(`xmtp ready (inbox ${client.inboxId})`);

  // The backend log DM first (the backend is always online), then peers concurrently — peers may
  // be booting at the same time under the same or another daemon.
  let sendToBackend: AgentXmtp["sendToBackend"] = null;
  let backendDmId: string | null = null;
  if (opts.backendXmtpAddress) {
    const backendIdentifier: Identifier = { identifier: opts.backendXmtpAddress.toLowerCase(), identifierKind: ETHEREUM };
    await waitReachable(backendIdentifier, opts.env, "the backend log inbox", opts.log);
    const dm = await client.conversations.createDmWithIdentifier(backendIdentifier);
    backendDmId = dm.id;
    // Serialize log sends so envelope seq order matches wire order.
    let queue: Promise<unknown> = Promise.resolve();
    sendToBackend = (text: string) => {
      const send = queue.then(() => dm.sendText(text));
      queue = send.catch(() => {});
      return send.then(() => {});
    };
  }

  const peers: { name: string; ethAddress: `0x${string}` }[] = [];
  const dms = new Map<string, Dm<unknown>>();
  const peerByConversation = new Map<string, string>();
  const peerByInbox = new Map<string, string>();
  const inbox: InboxMessage[] = [];
  const transcript: XmtpTranscriptEntry[] = [];

  const resolvePeer = (to: string | undefined): string => {
    if (to === undefined || to === "") {
      if (peers.length === 1) return peers[0].name.toLowerCase();
      throw new Error(`"to" is required with ${peers.length} peers (${peers.map((p) => p.name).join(", ")})`);
    }
    const byName = peers.find((p) => p.name.toLowerCase() === to.toLowerCase());
    if (byName) return byName.name.toLowerCase();
    const byAddress = peers.find((p) => p.ethAddress.toLowerCase() === to.toLowerCase());
    if (byAddress) return byAddress.name.toLowerCase();
    throw new Error(`unknown peer "${to}" (peers: ${peers.map((p) => p.name).join(", ")})`);
  };

  return {
    client,
    peers,
    inbox,
    transcript,
    async connectPeers(configPeers) {
      peers.push(...configPeers);
      await Promise.all(
        configPeers.map(async (p) => {
          const identifier: Identifier = { identifier: p.ethAddress.toLowerCase(), identifierKind: ETHEREUM };
          await waitReachable(identifier, opts.env, `peer ${p.name}`, opts.log);
          const dm = await client.conversations.createDmWithIdentifier(identifier);
          dms.set(p.name.toLowerCase(), dm);
          peerByConversation.set(dm.id, p.name);
          peerByInbox.set(dm.peerInboxId, p.name);
        }),
      );
      await client.conversations.sync();
      // No consent filter: a counterparty's first DM arrives with Unknown consent.
      await client.conversations.streamAllMessages({
        onValue: (message: DecodedMessage) => {
          if (message.senderInboxId === client.inboxId) return;
          if (message.conversationId === backendDmId) return; // the log channel is one-way
          if (typeof message.content !== "string") return;
          const from =
            peerByInbox.get(message.senderInboxId) ?? peerByConversation.get(message.conversationId) ?? message.senderInboxId;
          inbox.push({ from, text: message.content });
          transcript.push({ direction: "received", peer: from, text: message.content, at: new Date().toISOString() });
          opts.log(`xmtp << [${from}] ${message.content}`);
        },
        onError: (error: Error) => opts.log(`xmtp stream error: ${error.message}`),
      });
    },
    async send(to: string | undefined, text: string) {
      const peerKey = resolvePeer(to);
      const dm = dms.get(peerKey);
      if (!dm) throw new Error(`no DM open with ${peerKey}`);
      await dm.sendText(text);
      transcript.push({ direction: "sent", peer: peerKey, text, at: new Date().toISOString() });
    },
    sendToBackend,
  };
}
