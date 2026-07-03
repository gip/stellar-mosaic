// Per-agent configuration. Each agent is *given* its identities: a funded Stellar secret (alice
// holds XLM, bob holds USDC), an Ethereum key (XMTP identity), and the counterparty's eth address.
// They are read from `.demo/<name>.env` (written by `pnpm setup`, or by hand) with process.env
// taking precedence, so operator-supplied accounts work without the provisioner.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@mosaic/sdk";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEMO_DIR = join(PACKAGE_ROOT, ".demo");

export const HORIZON_URL = process.env.MOSAIC_HORIZON ?? "https://horizon-testnet.stellar.org";
export const NETWORK: NetworkConfig = {
  rpcUrl: process.env.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.MOSAIC_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  friendbotUrl: process.env.MOSAIC_FRIENDBOT ?? "https://friendbot.stellar.org",
};

export type AgentName = "alice" | "bob";

export interface AgentConfig {
  name: AgentName;
  /** Stellar secret seed (S...) of a funded testnet account. */
  stellarSecret: string;
  /** Ethereum private key — the agent's XMTP identity. */
  ethKey: `0x${string}`;
  /** 32-byte hex key encrypting the local XMTP db. */
  xmtpDbKey: `0x${string}`;
  /** The counterparty's Ethereum address (the only thing each agent knows about the other). */
  peerEthAddress: `0x${string}`;
  /** Issuer (G...) of the demo USDC classic asset backing asset_id 2 on the desk. */
  usdcIssuer: string;
  model: string;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function loadAgentConfig(name?: string): AgentConfig {
  const agentName = (name ?? process.env.AGENT_NAME) as AgentName | undefined;
  if (agentName !== "alice" && agentName !== "bob") {
    throw new Error(`AGENT_NAME must be "alice" or "bob" (got "${agentName ?? ""}")`);
  }
  const file = parseEnvFile(join(DEMO_DIR, `${agentName}.env`));
  const get = (key: string): string => {
    const v = process.env[key] ?? file[key];
    if (!v) throw new Error(`Missing ${key} (set it in the environment or ${DEMO_DIR}/${agentName}.env — run \`pnpm setup\` to provision demo identities)`);
    return v;
  };
  return {
    name: agentName,
    stellarSecret: get("STELLAR_SECRET"),
    ethKey: get("ETH_KEY") as `0x${string}`,
    xmtpDbKey: get("XMTP_DB_KEY") as `0x${string}`,
    peerEthAddress: get("PEER_ETH_ADDRESS") as `0x${string}`,
    usdcIssuer: get("USDC_ISSUER"),
    model: process.env.AGENT_MODEL ?? file.AGENT_MODEL ?? "claude-opus-4-8",
  };
}

/** Raw 7-decimal integer string → human decimal string (for logs only; tools always use raw). */
export function fmt7(raw: string): string {
  const v = BigInt(raw);
  const whole = v / 10_000_000n;
  const frac = (v % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
