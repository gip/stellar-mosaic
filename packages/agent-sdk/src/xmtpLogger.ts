// XMTP session logger: one DM from the agent's derived eth identity to the backend's known XMTP
// address, one JSON text message per LogEnvelope. Follows the buildXmtp recipe from
// agents/src/xmtp.ts: EOA signer from the derived eth key, local encrypted sqlite db (keyed by the
// deterministic xmtpDbKey so restarts reopen the same db), bounded canMessage polling for the
// backend, then a single DM. A send queue serializes messages so seq order matches send order.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, type ClientOptions, type Identifier, type IdentifierKind, type Signer } from "@xmtp/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, toBytes } from "viem";
import type { AgentIdentity } from "./derive.js";
import type { SessionLogger } from "./session.js";

const ETHEREUM: IdentifierKind = 0 as IdentifierKind; // IdentifierKind.Ethereum (ambient const enum)

export interface XmtpLoggerOptions {
  identity: AgentIdentity;
  backendXmtpAddress: `0x${string}`;
  env?: "dev" | "production" | "local";
  /** Directory for the local encrypted XMTP db (default `.mosaic-agent/`). */
  dbDir?: string;
  /** canMessage polling bounds while waiting for the backend to be reachable. */
  waitAttempts?: number;
  waitDelayMs?: number;
}

function eoaSigner(ethKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(ethKey);
  return {
    type: "EOA",
    getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: ETHEREUM }),
    signMessage: async (message: string) => toBytes(await account.signMessage({ message })),
  };
}

export async function createXmtpSessionLogger(opts: XmtpLoggerOptions): Promise<SessionLogger> {
  const env = opts.env ?? "dev";
  const dbDir = opts.dbDir ?? ".mosaic-agent";
  mkdirSync(dbDir, { recursive: true });
  const client = await Client.create(eoaSigner(opts.identity.ethKey), {
    env,
    dbPath: join(dbDir, `${opts.identity.stellarPublicKey}-xmtp.db3`),
    dbEncryptionKey: hexToBytes(opts.identity.xmtpDbKey),
  } as ClientOptions);

  const backendIdentifier: Identifier = { identifier: opts.backendXmtpAddress.toLowerCase(), identifierKind: ETHEREUM };
  const attempts = opts.waitAttempts ?? 90;
  for (let i = 0; ; i++) {
    const reachable = (await Client.canMessage([backendIdentifier], env)).get(backendIdentifier.identifier);
    if (reachable) break;
    if (i >= attempts) throw new Error(`backend XMTP address ${opts.backendXmtpAddress} is not registered on the ${env} network`);
    await new Promise((r) => setTimeout(r, opts.waitDelayMs ?? 2000));
  }
  const dm = await client.conversations.createDmWithIdentifier(backendIdentifier);

  // Serialize sends: seq is assigned by the session in call order, and interleaved sendText calls
  // could otherwise hit the network out of order.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    log(envelope) {
      const send = queue.then(() => dm.sendText(JSON.stringify(envelope)));
      queue = send.catch(() => {});
      return send.then(() => {});
    },
    async close() {
      await queue;
    },
  };
}
