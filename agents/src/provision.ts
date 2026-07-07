// Preflight + provisioning for one experiment run. The contract is "every agent starts with
// working identities": whatever the config omits is manufactured here — Stellar keypairs funded
// via friendbot, Ethereum keys for XMTP, trustlines for every agent on every classic asset
// (anyone may receive unshielded funds), configured funding, and each asset's Stellar Asset
// Contract. A declared asset is either the native lumen (XLM), demo-issued by a per-run issuer
// (funding minted here), or an existing on-network asset via `issuer` (e.g. Circle testnet
// USDC) — then nothing can be minted and its funding amount is a fail-fast check on the
// account's pre-existing balance. Every check fails fast, before any LLM tokens or testnet
// transactions are spent on a doomed run.

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
import type { ExperimentConfig, Provider } from "./experiment.js";
import { DEFAULT_API_KEY_ENV, pingModel } from "./llm.js";

export interface ProvisionedIdentity {
  name: string;
  provider: Provider;
  model: string;
  prompt: string;
  webSearch: boolean;
  apiKey: string;
  stellarSecret: string;
  stellarAddress: string;
  stellarGenerated: boolean;
  ethKey: `0x${string}`;
  ethAddress: `0x${string}`;
  ethGenerated: boolean;
  xmtpDbKey: `0x${string}`;
  /** Starting inventory by asset symbol (validated at config load). */
  funding: Record<string, string>;
}

export interface ProvisionedAsset {
  symbol: string;
  /** Undefined = the native lumen. */
  issuer?: string;
  /** Issued by the per-run demo issuer (i.e. mintable). */
  demo: boolean;
  /** SAC contract id; undefined only for the native lumen (its token is "native"). */
  sac?: string;
}

export interface Provisioned {
  agents: ProvisionedIdentity[];
  /** Same order as the config's declaration (desk asset id = index + 1). */
  assets: ProvisionedAsset[];
  /** Present only when at least one asset is demo-issued (secret kept to reclaim testnet funds). */
  demoIssuer?: { address: string; secret: string };
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

/** Every classic trustline the account holds, keyed "CODE:ISSUER" → balance. */
async function heldLines(horizon: Horizon.Server, address: string): Promise<Map<string, string>> {
  const account = await horizon.loadAccount(address);
  const lines = new Map<string, string>();
  for (const b of account.balances) {
    const line = b as { asset_code?: string; asset_issuer?: string };
    if (line.asset_code && line.asset_issuer) lines.set(`${line.asset_code}:${line.asset_issuer}`, b.balance);
  }
  return lines;
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

/**
 * Deploy the classic asset's SAC so desk deployment / custody can address it by contract id.
 * Anyone may deploy a SAC, so `source` is just a funded account; if the SAC already exists
 * (always the case for Circle testnet USDC) this is a no-op returning the contract id.
 */
async function deployAssetContract(cfg: ExperimentConfig, source: Keypair, asset: Asset): Promise<string> {
  const server = new rpc.Server(cfg.network.rpcUrl);
  const account = await server.getAccount(source.publicKey());
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
  tx.sign(source);
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
      prompt: a.prompt,
      webSearch: a.webSearch ?? false,
      apiKey: apiKey ?? "",
      stellarSecret: stellar.secret(),
      stellarAddress: stellar.publicKey(),
      stellarGenerated: !a.stellarSecret,
      ethKey,
      ethAddress: privateKeyToAccount(ethKey).address,
      ethGenerated: !a.ethKey,
      xmtpDbKey: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      funding: a.funding ?? {},
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
  //    A demo issuer is only manufactured when some declared asset needs one.
  const demoIssuer = cfg.assets.some((a) => a.symbol !== "XLM" && !a.issuer) ? Keypair.random() : undefined;
  await Promise.all([
    ...(demoIssuer ? [friendbot(cfg.network.friendbotUrl, demoIssuer.publicKey())] : []),
    ...agents.map(async (a) => {
      if (a.stellarGenerated || !(await accountExists(horizon, a.stellarAddress))) {
        await friendbot(cfg.network.friendbotUrl, a.stellarAddress);
      }
    }),
  ]);
  for (const a of agents) {
    log(`✓ ${a.name} stellar ${a.stellarAddress}${a.stellarGenerated ? " (generated + friendbot)" : ""} · eth ${a.ethAddress}${a.ethGenerated ? " (generated)" : ""}`);
  }

  // 4. Assets: resolve each declared asset (native / demo-issued / external), verify external
  //    ones exist on the network, add missing trustlines (anyone may receive unshielded funds),
  //    arrange funding (minted for demo assets, asserted pre-existing for external ones), and
  //    deploy each classic asset's SAC.
  const assets: ProvisionedAsset[] = cfg.assets.map((a) =>
    a.symbol === "XLM"
      ? { symbol: a.symbol, demo: false }
      : { symbol: a.symbol, issuer: a.issuer ?? demoIssuer!.publicKey(), demo: !a.issuer },
  );
  const classic = assets.filter((a) => a.issuer !== undefined);
  const lineKey = (a: ProvisionedAsset) => `${a.symbol}:${a.issuer}`;
  const classicAsset = (a: ProvisionedAsset) => new Asset(a.symbol, a.issuer);

  await Promise.all(
    classic
      .filter((a) => !a.demo)
      .map(async (a) => {
        const known = await horizon.assets().forCode(a.symbol).forIssuer(a.issuer!).call();
        if (known.records.length === 0) {
          throw new Error(`issuer ${a.issuer} has issued no ${a.symbol} on this network`);
        }
      }),
  );

  const linesByAgent = new Map<string, Map<string, string>>();
  await Promise.all(
    agents.map(async (a) => linesByAgent.set(a.name, await heldLines(horizon, a.stellarAddress))),
  );
  await Promise.all(
    agents.map((agent) => {
      const missing = classic.filter((a) => !linesByAgent.get(agent.name)!.has(lineKey(a)));
      if (missing.length === 0) return Promise.resolve();
      return submitClassic(
        cfg,
        horizon,
        Keypair.fromSecret(agent.stellarSecret),
        missing.map((a) => Operation.changeTrust({ asset: classicAsset(a) })),
      );
    }),
  );

  const mints: ReturnType<typeof Operation.payment>[] = [];
  const mintNotes: string[] = [];
  const short: string[] = [];
  for (const agent of agents) {
    for (const [symbol, amount] of Object.entries(agent.funding)) {
      if (Number(amount) <= 0) continue;
      const asset = classic.find((a) => a.symbol === symbol)!; // non-XLM + declared, per config validation
      if (asset.demo) {
        mints.push(Operation.payment({ destination: agent.stellarAddress, asset: classicAsset(asset), amount }));
        mintNotes.push(`${agent.name}=${amount} ${symbol}`);
      } else {
        const held = linesByAgent.get(agent.name)!.get(lineKey(asset));
        if (Number(held ?? "0") < Number(amount)) {
          short.push(`${agent.name} ${agent.stellarAddress}: ${symbol} has ${held ?? "no trustline"}, needs ${amount}`);
        }
      }
    }
  }
  if (short.length > 0) {
    throw new Error(`external assets cannot be minted — accounts below their funding:\n  - ${short.join("\n  - ")}`);
  }
  if (mints.length > 0) await submitClassic(cfg, horizon, demoIssuer!, mints);

  const sacSource = demoIssuer ?? Keypair.fromSecret(agents[0].stellarSecret);
  for (const a of classic) {
    a.sac = await deployAssetContract(cfg, sacSource, classicAsset(a));
  }
  for (const a of assets) {
    log(
      a.issuer
        ? `✓ asset ${a.symbol} issuer ${a.issuer} (${a.demo ? "demo" : "external"}) · SAC ${a.sac}`
        : `✓ asset ${a.symbol} (native)`,
    );
  }
  if (mintNotes.length > 0) log(`✓ funded ${mintNotes.join(", ")}`);

  return {
    agents,
    assets,
    demoIssuer: demoIssuer ? { address: demoIssuer.publicKey(), secret: demoIssuer.secret() } : undefined,
  };
}
