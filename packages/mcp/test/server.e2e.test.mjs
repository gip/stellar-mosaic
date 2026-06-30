// End-to-end test of the MCP server through the actual MCP protocol (in-memory transport): list
// tools, run the wallet auth handshake, and confirm base_shield is gated behind config.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMosaicMcpServer } from "../dist/server.js";
import { MemoryMosaicStore } from "../dist/store.js";

async function connect(opts = {}) {
  const server = createMosaicMcpServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

const textOf = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

test("exposes the MCP-only frontend tool set", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const name of [
    "auth_challenge",
    "auth_verify",
    "auth_session",
    "auth_logout",
    "list_desks",
    "get_desk",
    "create_operation",
    "claim_client_action",
    "relay_shield",
    "relay_order",
    "get_wallet_backup",
    "put_wallet_backup",
    "base_shield_config",
    "enqueue_base_shield",
    "base_shield",
  ]) {
    assert.ok(names.has(name), `missing tool ${name}`);
  }
});

test("wallet auth handshake over the protocol, then base_shield gated by config", async () => {
  const kp = Keypair.random();
  const client = await connect();

  const ch = textOf(await client.callTool({ name: "auth_challenge", arguments: { address: kp.publicKey() } }));
  assert.ok(ch.message.includes(kp.publicKey()));
  const signature = kp
    .sign(Buffer.from(sep53Digest(new TextEncoder().encode(ch.message))))
    .toString("base64");
  const verified = textOf(
    await client.callTool({
      name: "auth_verify",
      arguments: { address: kp.publicKey(), challengeId: ch.challengeId, signature },
    }),
  );
  assert.ok(verified.token);

  const bs = await client.callTool({
    name: "base_shield",
    arguments: {
      session: verified.token,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset_id: 1,
      amount: "1",
      owner_tag: "0x00",
      baseTxHash: "0x00",
    },
  });
  assert.ok(bs.isError, "base_shield must error when the prover/relayer is not configured");
});

test("base_shield_config reports desk bridge and worker readiness", async () => {
  const store = new MemoryMosaicStore();
  const desk = {
    id: "desk-base",
    name: "Base desk",
    contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sponsor_pubkey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    event_start_ledger: 123,
    assets: [],
    pairs: [],
    base_deployment: {
      status: "active",
      deployer_address: "0x1111111111111111111111111111111111111111",
      tx_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      bridge_address: "0xabababababababababababababababababababab",
      error: null,
      assets: [],
    },
  };
  await store.insertDesk(desk, null);

  const disabled = textOf(
    await (await connect({ store })).callTool({
      name: "base_shield_config",
      arguments: { desk_id: "desk-base" },
    }),
  );
  assert.deepEqual(disabled, {
    available: false,
    chain_id: 84532,
    network: "base-sepolia",
    bridge: "0xabababababababababababababababababababab",
    worker_ready: false,
    reason: "worker_disabled",
  });

  const ready = textOf(
    await (await connect({
      store,
      baseShield: {
        proverDir: "/tmp/prover",
        castBin: "cast",
        baseRpc: "https://example.invalid",
        bridgeAddress: "0xabababababababababababababababababababab",
        stellar: {
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
          sponsorSecret: "SA_SPONSOR_SECRET",
        },
      },
    })).callTool({
      name: "base_shield_config",
      arguments: { desk_id: "desk-base" },
    }),
  );
  assert.deepEqual(ready, {
    available: true,
    chain_id: 84532,
    network: "base-sepolia",
    bridge: "0xabababababababababababababababababababab",
    worker_ready: true,
    reason: null,
  });
});

test("base_shield_config reports unconfigured desks separately", async () => {
  const store = new MemoryMosaicStore();
  await store.insertDesk(
    {
      id: "desk-no-base",
      name: "No Base desk",
      contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sponsor_pubkey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      event_start_ledger: 123,
      assets: [],
      pairs: [],
      base_deployment: null,
    },
    null,
  );

  const config = textOf(
    await (await connect({
      store,
      baseShield: {
        proverDir: "/tmp/prover",
        castBin: "cast",
        baseRpc: "https://example.invalid",
        bridgeAddress: "0xabababababababababababababababababababab",
        stellar: {
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
          sponsorSecret: "SA_SPONSOR_SECRET",
        },
      },
    })).callTool({
      name: "base_shield_config",
      arguments: { desk_id: "desk-no-base" },
    }),
  );
  assert.deepEqual(config, {
    available: false,
    chain_id: 84532,
    network: "base-sepolia",
    bridge: null,
    worker_ready: true,
    reason: "contract_unconfigured",
  });
});
