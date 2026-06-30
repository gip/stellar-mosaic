import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StellarCliDeployer } from "../dist/node.js";

const contractId = (char) => `C${char.repeat(55)}`;

test("StellarCliDeployer resolves and idempotently deploys classic SACs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mosaic-stellar-cli-"));
  const log = join(dir, "argv.jsonl");
  const fakeStellar = join(dir, "stellar");
  writeFileSync(
    fakeStellar,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "contract" && args[1] === "id" && args[2] === "asset") {
  console.log(${JSON.stringify(contractId("A"))});
  process.exit(0);
}
if (args[0] === "contract" && args[1] === "asset" && args[2] === "deploy") {
  console.log("HostError: Error(Storage, ExistingValue)");
  process.exit(1);
}
if (args[0] === "contract" && args[1] === "deploy") {
  console.log(${JSON.stringify(contractId("B"))});
  process.exit(0);
}
console.error("unexpected args", args.join(" "));
process.exit(2);
`,
  );
  chmodSync(fakeStellar, 0o755);

  const deployer = new StellarCliDeployer({
    stellarBin: fakeStellar,
    source: "S".padEnd(56, "A"),
    network: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
  });

  const result = await deployer.deploySettlement({
    admin: "G".padEnd(56, "A"),
    assets: [{ asset_id: 1, symbol: "USDC", token: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", decimals: 7, kind: "Dual" }],
    pairs: [],
  });

  assert.equal(result.contractId, contractId("B"));
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const idCall = calls.find((args) => args[0] === "contract" && args[1] === "id" && args[2] === "asset");
  assert.ok(idCall, "expected asset id call");
  assert.equal(idCall.includes("--source-account"), false);
  assert.equal(idCall.includes("--rpc-url"), true);
  assert.equal(idCall.includes("--network-passphrase"), true);
  assert.ok(calls.some((args) => args[0] === "contract" && args[1] === "asset" && args[2] === "deploy"));
});
