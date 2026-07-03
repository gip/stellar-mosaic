// XMTP session for one agent: an EOA signer derived from the given eth key, a client on the XMTP
// dev network with a local encrypted db under .demo/, and a single DM with the counterparty. All
// incoming text lands in an in-memory FIFO that the `xmtp_wait_for_message` tool consumes; a full
// transcript is kept for `xmtp_history`.

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
import { DEMO_DIR, type AgentConfig } from "./config.js";

const ETHEREUM: IdentifierKind = 0 as IdentifierKind; // IdentifierKind.Ethereum (ambient const enum)

export interface XmtpTranscriptEntry {
  direction: "sent" | "received";
  text: string;
  at: string;
}

export interface XmtpSession {
  client: Client<unknown>;
  dm: Dm<unknown>;
  /** Unread incoming texts, oldest first. */
  inbox: string[];
  transcript: XmtpTranscriptEntry[];
  send(text: string): Promise<void>;
}

function eoaSigner(ethKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(ethKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: ETHEREUM }),
    signMessage: async (message: string) => toBytes(await account.signMessage({ message })),
  };
}

export async function buildXmtp(cfg: AgentConfig, log: (line: string) => void): Promise<XmtpSession> {
  // Cast: Omit<ClientOptions, "codecs"> in create()'s signature collapses the NetworkOptions
  // union and hides `env`, but it is a valid runtime option.
  const client = await Client.create(eoaSigner(cfg.ethKey), {
    env: "dev",
    dbPath: join(DEMO_DIR, `${cfg.name}-xmtp.db3`),
    dbEncryptionKey: hexToBytes(cfg.xmtpDbKey),
  } as ClientOptions);
  log(`xmtp ready (inbox ${client.inboxId})`);

  // The two agents boot concurrently; wait until the peer's identity is registered on the network.
  const peer: Identifier = { identifier: cfg.peerEthAddress.toLowerCase(), identifierKind: ETHEREUM };
  for (let i = 0; ; i++) {
    const reachable = (await Client.canMessage([peer], "dev")).get(peer.identifier);
    if (reachable) break;
    if (i === 0) log(`waiting for peer ${cfg.peerEthAddress} to register on xmtp…`);
    if (i > 90) throw new Error(`peer ${cfg.peerEthAddress} never registered on the xmtp dev network`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const dm = await client.conversations.createDmWithIdentifier(peer);
  await client.conversations.sync();

  const inbox: string[] = [];
  const transcript: XmtpTranscriptEntry[] = [];
  // No consent filter: the counterparty's first DM arrives with Unknown consent state.
  await client.conversations.streamAllMessages({
    onValue: (message: DecodedMessage) => {
      if (message.senderInboxId === client.inboxId) return;
      if (typeof message.content !== "string") return; // group-membership updates etc.
      inbox.push(message.content);
      transcript.push({ direction: "received", text: message.content, at: new Date().toISOString() });
      log(`xmtp << ${message.content}`);
    },
    onError: (error: Error) => log(`xmtp stream error: ${error.message}`),
  });

  return {
    client,
    dm,
    inbox,
    transcript,
    async send(text: string) {
      await dm.sendText(text);
      transcript.push({ direction: "sent", text, at: new Date().toISOString() });
      log(`xmtp >> ${text}`);
    },
  };
}
