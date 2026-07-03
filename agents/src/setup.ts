// One-shot demo provisioner. The demo's contract is "each agent is GIVEN funded identities"; this
// script manufactures them for convenience: two funded Stellar accounts (alice XLM-only, bob also
// holding demo USDC), a USDC issuer + its SAC (StellarRpcDeployer resolves but never deploys SACs),
// two eth keys for XMTP, and per-agent env files under .demo/.
//
// Alice also gets a USDC trustline up front — her final `unshield` pays classic USDC to her
// G-address and would fail without it. Bob symmetrically holds XLM natively (friendbot).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
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
import { DEMO_DIR, HORIZON_URL, NETWORK } from "./config.js";

const USDC_CODE = "USDC";
const BOB_USDC = "100";

const horizon = new Horizon.Server(HORIZON_URL);

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`${NETWORK.friendbotUrl}?addr=${encodeURIComponent(address)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${address}: ${res.status} ${await res.text()}`);
  }
}

async function submitClassic(source: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * 10).toString(),
    networkPassphrase: NETWORK.networkPassphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(source);
  await horizon.submitTransaction(tx);
}

/** Deploy the classic asset's SAC so desk deployment / custody can address it by contract id. */
async function deployAssetContract(issuer: Keypair, asset: Asset): Promise<string> {
  const server = new rpc.Server(NETWORK.rpcUrl);
  const account = await server.getAccount(issuer.publicKey());
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.networkPassphrase,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) {
    if (/already exists|ExistingValue/i.test(sim.error)) return asset.contractId(NETWORK.networkPassphrase);
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
  return asset.contractId(NETWORK.networkPassphrase);
}

function agentEnv(opts: {
  name: string;
  stellar: Keypair;
  ethKey: `0x${string}`;
  peer: `0x${string}`;
  usdcIssuer: string;
}): string {
  return [
    `AGENT_NAME=${opts.name}`,
    `STELLAR_SECRET=${opts.stellar.secret()}`,
    `STELLAR_ADDRESS=${opts.stellar.publicKey()}`,
    `ETH_KEY=${opts.ethKey}`,
    `XMTP_DB_KEY=0x${randomBytes(32).toString("hex")}`,
    `PEER_ETH_ADDRESS=${opts.peer}`,
    `USDC_ISSUER=${opts.usdcIssuer}`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  mkdirSync(DEMO_DIR, { recursive: true });
  // Fresh identities invalidate old note/XMTP state — wipe it.
  for (const f of readdirSync(DEMO_DIR)) {
    if (/\.(db|db3)(-|$)/.test(f) || f.endsWith(".sqlitedb")) rmSync(join(DEMO_DIR, f), { force: true });
  }

  const alice = Keypair.random();
  const bob = Keypair.random();
  const issuer = Keypair.random();
  console.log(`alice  ${alice.publicKey()}`);
  console.log(`bob    ${bob.publicKey()}`);
  console.log(`issuer ${issuer.publicKey()}`);

  console.log("funding via friendbot…");
  await Promise.all([alice, bob, issuer].map((kp) => friendbot(kp.publicKey())));

  const usdc = new Asset(USDC_CODE, issuer.publicKey());
  console.log("setting USDC trustlines (alice + bob)…");
  await Promise.all([
    submitClassic(alice, [Operation.changeTrust({ asset: usdc })]),
    submitClassic(bob, [Operation.changeTrust({ asset: usdc })]),
  ]);
  console.log(`paying bob ${BOB_USDC} USDC…`);
  await submitClassic(issuer, [
    Operation.payment({ destination: bob.publicKey(), asset: usdc, amount: BOB_USDC }),
  ]);
  console.log("deploying the USDC stellar asset contract…");
  const sac = await deployAssetContract(issuer, usdc);
  console.log(`USDC SAC ${sac}`);

  const aliceEth = generatePrivateKey();
  const bobEth = generatePrivateKey();
  const aliceEthAddr = privateKeyToAccount(aliceEth).address;
  const bobEthAddr = privateKeyToAccount(bobEth).address;

  writeFileSync(
    join(DEMO_DIR, "alice.env"),
    agentEnv({ name: "alice", stellar: alice, ethKey: aliceEth, peer: bobEthAddr, usdcIssuer: issuer.publicKey() }),
  );
  writeFileSync(
    join(DEMO_DIR, "bob.env"),
    agentEnv({ name: "bob", stellar: bob, ethKey: bobEth, peer: aliceEthAddr, usdcIssuer: issuer.publicKey() }),
  );
  writeFileSync(
    join(DEMO_DIR, "shared.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        usdcIssuer: issuer.publicKey(),
        usdcSac: sac,
        alice: { stellar: alice.publicKey(), eth: aliceEthAddr },
        bob: { stellar: bob.publicKey(), eth: bobEthAddr },
      },
      null,
      2,
    ) + "\n",
  );

  console.log("\nProvisioned. Balances:");
  for (const [name, kp] of [["alice", alice], ["bob", bob]] as const) {
    const account = await horizon.loadAccount(kp.publicKey());
    for (const b of account.balances) {
      const label = b.asset_type === "native" ? "XLM" : `${(b as { asset_code?: string }).asset_code}`;
      console.log(`  ${name}  ${label}  ${b.balance}`);
    }
  }
  console.log(`\nEnv files written to ${DEMO_DIR}. Next: ANTHROPIC_API_KEY=… pnpm demo`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err as Error & { response?: { data?: unknown } }).response?.data ?? err.message : err);
  process.exit(1);
});
