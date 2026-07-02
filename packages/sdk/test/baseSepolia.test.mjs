import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_SEPOLIA_CONFIG_ID,
  DEFAULT_BASE_SEPOLIA_ROUTER_ID,
  DeployDeskError,
  MemoryStore,
  MosaicClient,
  NATIVE_EVM_SENTINEL,
  StaticDeskProvider,
  baseTokenAddress,
} from "../dist/index.js";

const signer = {
  address: async () => "GADMIN",
  signTransaction: async (xdr) => xdr,
  signAuthEntry: async (xdr) => xdr,
  signMessage: async () => new Uint8Array(),
};

function clientWith(ports) {
  return new MosaicClient({
    network: { rpcUrl: "", networkPassphrase: "" },
    signer,
    store: new MemoryStore(),
    source: {},
    desks: new StaticDeskProvider([]),
    circuits: () => {
      throw new Error("circuits should not be used by deploy");
    },
    ...ports,
  });
}

test("baseTokenAddress maps native ETH to the MosaicBridge sentinel", () => {
  assert.equal(baseTokenAddress("native"), NATIVE_EVM_SENTINEL);
  assert.equal(baseTokenAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
});

test("deploy with Base assets deploys Stellar, deploys Base, then configures Stellar bridge", async () => {
  const calls = [];
  const client = clientWith({
    deployer: {
      deploySettlement: async () => {
        calls.push("stellar");
        return { contractId: "CCONTRACT" };
      },
    },
    baseBridgeDeployer: {
      estimate: async () => ({ gas: 1n, maxFee: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      verify: async () => ({ ok: true }),
      deploy: async ({ assetIds, tokens }) => {
        calls.push(["base", assetIds, tokens]);
        return {
          txHash: "0x" + "1".repeat(64),
          bridgeAddress: "0xabababababababababababababababababababab",
          deployer: "0x1111111111111111111111111111111111111111",
        };
      },
    },
    submitter: {
      submit: async (call) => {
        calls.push(["configure", call.method, call.args.length]);
        return { txHash: "stellar-config", status: "SUCCESS" };
      },
    },
  });

  const desk = await client.deploy({
    name: "Base desk",
    assets: [{ asset_id: 1, symbol: "USDC", token: "native", decimals: 7, kind: "Dual" }],
    pairs: [],
    base: {
      assets: [{ asset_id: 1, symbol: "USDC", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }],
      router_id: DEFAULT_BASE_SEPOLIA_ROUTER_ID,
      image_id: "0x" + "2".repeat(64),
      config_id: BASE_SEPOLIA_CONFIG_ID,
    },
  });

  assert.deepEqual(calls, [
    "stellar",
    ["base", [1], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"]],
    ["configure", "configure_base_bridge", 4],
  ]);
  assert.equal(desk.baseDeployment?.status, "active");
  assert.equal(desk.baseDeployment?.bridge_address, "0xabababababababababababababababababababab");
});

test("deploy preserves partial desk metadata when Base deployment fails", async () => {
  const client = clientWith({
    deployer: { deploySettlement: async () => ({ contractId: "CCONTRACT" }) },
    baseBridgeDeployer: {
      estimate: async () => ({ gas: 1n, maxFee: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      verify: async () => ({ ok: false }),
      deploy: async () => {
        throw new Error("wallet rejected");
      },
    },
    submitter: { submit: async () => ({ txHash: "unused", status: "SUCCESS" }) },
  });

  await assert.rejects(
    () =>
      client.deploy({
        assets: [{ asset_id: 1, symbol: "USDC", token: "native", decimals: 7, kind: "Dual" }],
        pairs: [],
        base: {
          assets: [{ asset_id: 1, symbol: "USDC", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }],
          router_id: DEFAULT_BASE_SEPOLIA_ROUTER_ID,
          image_id: "0x" + "2".repeat(64),
          config_id: BASE_SEPOLIA_CONFIG_ID,
        },
      }),
    (error) => {
      assert.ok(error instanceof DeployDeskError);
      assert.equal(error.partialDesk?.contractId, "CCONTRACT");
      assert.equal(error.partialDesk?.baseDeployment?.status, "failed");
      return true;
    },
  );
});
