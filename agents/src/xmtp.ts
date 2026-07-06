// XMTP session for one agent: an EOA signer derived from the given eth key, a client on the XMTP
// dev network with a local encrypted db under the run dir, and one DM per peer (pairwise DMs
// generalize to N agents without group-invite sync). All incoming text lands in an in-memory FIFO
// (with sender attribution) that the `xmtp_wait_for_message` tool consumes; a full transcript is
// kept for `xmtp_history`.

import { join } from "node:path";
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
import type { ResolvedAgentFile } from "./experiment.js";

const ETHEREUM: IdentifierKind = 0 as IdentifierKind; // IdentifierKind.Ethereum (ambient const enum)

export interface InboxMessage {
  /** Peer name (falls back to the sender inbox id if unattributable). */
  from: string;
  text: string;
}

export interface XmtpTranscriptEntry {
  direction: "sent" | "received";
  peer: string;
  text: string;
  at: string;
}

export interface XmtpSession {
  client: Client<unknown>;
  peers: { name: string; ethAddress: `0x${string}` }[];
  /** Unread incoming messages, oldest first. */
  inbox: InboxMessage[];
  transcript: XmtpTranscriptEntry[];
  /** `to` is a peer name (case-insensitive) or eth address; may be omitted with a single peer. */
  send(to: string | undefined, text: string): Promise<void>;
}

function eoaSigner(ethKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(ethKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: ETHEREUM }),
    signMessage: async (message: string) => toBytes(await account.signMessage({ message })),
  };
}

export async function buildXmtp(cfg: ResolvedAgentFile, log: (line: string) => void): Promise<XmtpSession> {
  // Cast: Omit<ClientOptions, "codecs"> in create()'s signature collapses the NetworkOptions
  // union and hides `env`, but it is a valid runtime option.
  const client = await Client.create(eoaSigner(cfg.ethKey), {
    env: "dev",
    dbPath: join(cfg.runDir, `${cfg.name}-xmtp.db3`),
    dbEncryptionKey: hexToBytes(cfg.xmtpDbKey),
  } as ClientOptions);
  log(`xmtp ready (inbox ${client.inboxId})`);

  // All agents boot concurrently; wait until every peer's identity is registered on the network,
  // then open one DM per peer.
  const dms = new Map<string, Dm<unknown>>(); // lowercase peer name -> DM
  const peerByConversation = new Map<string, string>(); // conversation id -> peer name
  const peerByInbox = new Map<string, string>(); // sender inbox id -> peer name
  await Promise.all(
    cfg.peers.map(async (p) => {
      const identifier: Identifier = { identifier: p.ethAddress.toLowerCase(), identifierKind: ETHEREUM };
      for (let i = 0; ; i++) {
        const reachable = (await Client.canMessage([identifier], "dev")).get(identifier.identifier);
        if (reachable) break;
        if (i === 0) log(`waiting for ${p.name} (${p.ethAddress}) to register on xmtp…`);
        if (i > 90) throw new Error(`peer ${p.name} (${p.ethAddress}) never registered on the xmtp dev network`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      const dm = await client.conversations.createDmWithIdentifier(identifier);
      dms.set(p.name.toLowerCase(), dm);
      peerByConversation.set(dm.id, p.name);
      peerByInbox.set(dm.peerInboxId, p.name);
    }),
  );
  await client.conversations.sync();

  const inbox: InboxMessage[] = [];
  const transcript: XmtpTranscriptEntry[] = [];
  // No consent filter: a counterparty's first DM arrives with Unknown consent state.
  await client.conversations.streamAllMessages({
    onValue: (message: DecodedMessage) => {
      if (message.senderInboxId === client.inboxId) return;
      if (typeof message.content !== "string") return; // group-membership updates etc.
      const from =
        peerByInbox.get(message.senderInboxId) ??
        peerByConversation.get(message.conversationId) ??
        message.senderInboxId;
      inbox.push({ from, text: message.content });
      transcript.push({ direction: "received", peer: from, text: message.content, at: new Date().toISOString() });
      log(`xmtp << [${from}] ${message.content}`);
    },
    onError: (error: Error) => log(`xmtp stream error: ${error.message}`),
  });

  const resolvePeer = (to: string | undefined): string => {
    if (to === undefined || to === "") {
      if (cfg.peers.length === 1) return cfg.peers[0].name.toLowerCase();
      throw new Error(`"to" is required with ${cfg.peers.length} peers (${cfg.peers.map((p) => p.name).join(", ")})`);
    }
    const byName = cfg.peers.find((p) => p.name.toLowerCase() === to.toLowerCase());
    if (byName) return byName.name.toLowerCase();
    const byAddress = cfg.peers.find((p) => p.ethAddress.toLowerCase() === to.toLowerCase());
    if (byAddress) return byAddress.name.toLowerCase();
    throw new Error(`unknown peer "${to}" (peers: ${cfg.peers.map((p) => p.name).join(", ")})`);
  };

  return {
    client,
    peers: cfg.peers,
    inbox,
    transcript,
    async send(to: string | undefined, text: string) {
      const peerKey = resolvePeer(to);
      const dm = dms.get(peerKey);
      if (!dm) throw new Error(`no DM open with ${peerKey}`);
      await dm.sendText(text);
      transcript.push({ direction: "sent", peer: peerKey, text, at: new Date().toISOString() });
      log(`xmtp >> [${peerKey}] ${text}`);
    },
  };
}
