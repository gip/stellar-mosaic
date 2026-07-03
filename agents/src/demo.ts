// Demo orchestrator: snapshots both wallets, spawns the two agent processes with prefixed output,
// waits for them to finish, then independently verifies the trade on Horizon (balance deltas) —
// the PASS/FAIL verdict does not trust anything the agents reported.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Horizon } from "@stellar/stellar-sdk";
import { DEMO_DIR, HORIZON_URL, PACKAGE_ROOT } from "./config.js";

interface Shared {
  usdcIssuer: string;
  alice: { stellar: string };
  bob: { stellar: string };
}

const horizon = new Horizon.Server(HORIZON_URL);

async function balances(address: string): Promise<{ xlm: number; usdc: number }> {
  const account = await horizon.loadAccount(address);
  let xlm = 0;
  let usdc = 0;
  for (const b of account.balances) {
    if (b.asset_type === "native") xlm = Number(b.balance);
    else if ((b as { asset_code?: string }).asset_code === "USDC") usdc = Number(b.balance);
  }
  return { xlm, usdc };
}

function runAgent(name: "alice" | "bob"): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(PACKAGE_ROOT, "dist/agent.js")], {
      env: { ...process.env, AGENT_NAME: name },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Agent stdout is already [name]-prefixed; prefix stderr (stack traces, SDK noise) ourselves.
    createInterface({ input: child.stdout }).on("line", (l) => console.log(l));
    createInterface({ input: child.stderr }).on("line", (l) => console.error(`[${name}!] ${l}`));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const shared = JSON.parse(readFileSync(join(DEMO_DIR, "shared.json"), "utf8")) as Shared;
  const before = {
    alice: await balances(shared.alice.stellar),
    bob: await balances(shared.bob.stellar),
  };
  console.log(`alice ${shared.alice.stellar}  XLM ${before.alice.xlm}  USDC ${before.alice.usdc}`);
  console.log(`bob   ${shared.bob.stellar}  XLM ${before.bob.xlm}  USDC ${before.bob.usdc}`);
  console.log("--- launching agents ---");

  const started = Date.now();
  const [aliceCode, bobCode] = await Promise.all([runAgent("alice"), runAgent("bob")]);
  console.log(`--- agents finished in ${Math.round((Date.now() - started) / 1000)}s (alice exit ${aliceCode}, bob exit ${bobCode}) ---`);

  const after = {
    alice: await balances(shared.alice.stellar),
    bob: await balances(shared.bob.stellar),
  };
  const d = {
    aliceXlm: after.alice.xlm - before.alice.xlm,
    aliceUsdc: after.alice.usdc - before.alice.usdc,
    bobXlm: after.bob.xlm - before.bob.xlm,
    bobUsdc: after.bob.usdc - before.bob.usdc,
  };
  console.log(`alice Δ  XLM ${d.aliceXlm.toFixed(7)}  USDC ${d.aliceUsdc.toFixed(7)}`);
  console.log(`bob   Δ  XLM ${d.bobXlm.toFixed(7)}  USDC ${d.bobUsdc.toFixed(7)}`);

  // Alice sold ~10 XLM for USDC; bob paid that USDC and received the XLM. Allow price slack from
  // negotiation and fee drag on XLM deltas.
  const pass = d.aliceUsdc >= 1.5 && d.bobUsdc <= -1.5 && d.bobXlm >= 9 && d.aliceXlm <= -9;
  console.log(pass ? "PASS ✅ — trade settled end to end" : "FAIL ❌ — expected alice +USDC / bob +XLM deltas not found");
  process.exit(pass && aliceCode === 0 && bobCode === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
