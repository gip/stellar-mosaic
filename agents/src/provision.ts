// Preflight + provisioning for one experiment run. The contract is "every agent starts with
// working identities": whatever the config omits is manufactured here — Stellar keypairs funded
// via friendbot, Ethereum keys for XMTP, a per-run demo-USDC issuer with trustlines for every
// agent (anyone may receive unshielded USDC), configured USDC funding, and the USDC Stellar Asset
// Contract. Every check fails fast, before any LLM tokens or testnet transactions are spent on a
// doomed run.

import { randomBytes } from "node:crypto";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AgentRole, ExperimentConfig, Provider } from "./experiment.js";
import { DEFAULT_API_KEY_ENV, pingModel } from "./llm.js";

const USDC_CODE = "USDC";

export interface ProvisionedIdentity {
  name: string;
  provider: Provider;
  model: string;
  role: AgentRole;
  prompt: string;
  apiKey: string;
  stellarSecret: string;
  stellarAddress: string;
  stellarGenerated: boolean;
  ethKey: `0x${string}`;
  ethAddress: `0x${string}`;
  ethGenerated: boolean;
  xmtpDbKey: `0x${string}`;
  usdcFunding: string;
}

export interface Provisioned {
  agents: ProvisionedIdentity[];
  usdc: { issuer: string; issuerSecret: string; sac: string };
}

type Log = (line: string) => void;

async function friendbot(friendbotUrl: string, address: string): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
  // 400 = already funded — fine.
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${address}: ${res.status} ${await res.text()}`);
  }
}

async function accountExists(horizon: Horizon.Server, address: string): Promise<boolean> {
  try {
    await horizon.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

async function submitClassic(
  cfg: ExperimentConfig,
  horizon: Horizon.Server,
  source: Keypair,
  ops: ReturnType<typeof Operation.payment>[],
): Promise<void> {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * 10).toString(),
    networkPassphrase: cfg.network.networkPassphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(source);
  await horizon.submitTransaction(tx);
}

/** Deploy the classic asset's SAC so desk deployment / custody can address it by contract id. */
async function deployAssetContract(cfg: ExperimentConfig, issuer: Keypair, asset: Asset): Promise<string> {
  const server = new rpc.Server(cfg.network.rpcUrl);
  const account = await server.getAccount(issuer.publicKey());
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.network.networkPassphrase,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) {
    if (/already exists|ExistingValue/i.test(sim.error)) return asset.contractId(cfg.network.networkPassphrase);
    throw new Error(`SAC deploy simulation failed: ${sim.error}`);
  }
  const tx = rpc.assembleTransaction(raw, sim).build();
  tx.sign(issuer);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`SAC deploy rejected: ${sent.status}`);
  }
  const hash = tx.hash().toString("hex");
  for (let i = 0; i < 60; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) break;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`SAC deploy tx ${hash} failed`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return asset.contractId(cfg.network.networkPassphrase);
}

export async function provision(
  cfg: ExperimentConfig,
  opts: { log: Log; checkLlm?: boolean },
): Promise<Provisioned> {
  const { log } = opts;
  const horizon = new Horizon.Server(cfg.network.horizonUrl);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    throw new Error(`Node >= 22 required (XMTP native bindings + node:sqlite); running ${process.versions.node}`);
  }

  // 1. Resolve API keys (config value or provider-default env var) — all of them, before any ping.
  const missingKeys: string[] = [];
  const agents: ProvisionedIdentity[] = cfg.agents.map((a) => {
    const apiKey = a.apiKey ?? process.env[DEFAULT_API_KEY_ENV[a.provider]];
    if (!apiKey) missingKeys.push(`${a.name}: set apiKey in the config or ${DEFAULT_API_KEY_ENV[a.provider]} in the environment`);
    const stellar = a.stellarSecret ? Keypair.fromSecret(a.stellarSecret) : Keypair.random();
    const ethKey = (a.ethKey ?? generatePrivateKey()) as `0x${string}`;
    return {
      name: a.name,
      provider: a.provider,
      model: a.model,
      role: a.role,
      prompt: a.prompt,
      apiKey: apiKey ?? "",
      stellarSecret: stellar.secret(),
      stellarAddress: stellar.publicKey(),
      stellarGenerated: !a.stellarSecret,
      ethKey,
      ethAddress: privateKeyToAccount(ethKey).address,
      ethGenerated: !a.ethKey,
      xmtpDbKey: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      usdcFunding: a.funding?.usdc ?? "0",
    };
  });
  if (missingKeys.length > 0) {
    throw new Error(`missing LLM API keys:\n  - ${missingKeys.join("\n  - ")}`);
  }
  log(`✓ API keys resolved for ${agents.map((a) => `${a.name} (${a.provider})`).join(", ")}`);

  // 2. Ping each provider/model — catches bad keys and typo'd model ids for pennies.
  if (opts.checkLlm !== false) {
    await Promise.all(
      agents.map(async (a) => {
        try {
          await pingModel(a.provider, a.apiKey, a.model);
        } catch (err) {
          throw new Error(`LLM check failed for ${a.name} (${a.provider}/${a.model}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    log(`✓ LLM check passed for ${agents.map((a) => `${a.name}=${a.model}`).join(", ")}`);
  } else {
    log("· LLM check skipped");
  }

  // 3. Stellar accounts: friendbot-fund anything that does not exist yet (generated or supplied).
  const issuer = Keypair.random();
  await Promise.all([
    friendbot(cfg.network.friendbotUrl, issuer.publicKey()),
    ...agents.map(async (a) => {
      if (a.stellarGenerated || !(await accountExists(horizon, a.stellarAddress))) {
        await friendbot(cfg.network.friendbotUrl, a.stellarAddress);
      }
    }),
  ]);
  for (const a of agents) {
    log(`✓ ${a.name} stellar ${a.stellarAddress}${a.stellarGenerated ? " (generated + friendbot)" : ""} · eth ${a.ethAddress}${a.ethGenerated ? " (generated)" : ""}`);
  }

  // 4. Demo USDC: per-run issuer, trustlines for every agent (anyone may receive unshielded USDC),
  //    configured starting inventory, and the asset's SAC for the desk.
  const usdc = new Asset(USDC_CODE, issuer.publicKey());
  await Promise.all(
    agents.map((a) => submitClassic(cfg, horizon, Keypair.fromSecret(a.stellarSecret), [Operation.changeTrust({ asset: usdc })])),
  );
  const payments = agents
    .filter((a) => Number(a.usdcFunding) > 0)
    .map((a) => Operation.payment({ destination: a.stellarAddress, asset: usdc, amount: a.usdcFunding }));
  if (payments.length > 0) await submitClassic(cfg, horizon, issuer, payments);
  const sac = await deployAssetContract(cfg, issuer, usdc);
  log(`✓ USDC issuer ${issuer.publicKey()} · SAC ${sac}${payments.length > 0 ? ` · funded ${agents.filter((a) => Number(a.usdcFunding) > 0).map((a) => `${a.name}=${a.usdcFunding}`).join(", ")}` : ""}`);

  return { agents, usdc: { issuer: issuer.publicKey(), issuerSecret: issuer.secret(), sac } };
}
