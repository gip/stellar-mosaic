import test from "node:test";
import assert from "node:assert/strict";
import { SponsoredStellarDeployHandlers } from "../dist/deploy.js";

const DUMMY_KEY = `0x${"11".repeat(32)}`;

test("baseDeploymentConfig reports base deployment unconfigured without an RPC", async () => {
  const handlers = new SponsoredStellarDeployHandlers({ baseRpc: undefined, baseDeployerKey: undefined });
  const config = await handlers.baseDeploymentConfig();
  assert.equal(config.available, false);
  assert.equal(config.server_deploys, false);
  assert.equal(config.reason, "base_deploy_not_configured");
});

test("baseDeploymentConfig advertises server_deploys only when a deployer key is set", async () => {
  const withoutKey = new SponsoredStellarDeployHandlers({ baseRpc: "http://base.example", baseDeployerKey: undefined });
  const a = await withoutKey.baseDeploymentConfig();
  assert.equal(a.available, true);
  assert.equal(a.server_deploys, false, "no deployer key → server cannot deploy");

  const withKey = new SponsoredStellarDeployHandlers({ baseRpc: "http://base.example", baseDeployerKey: DUMMY_KEY });
  const b = await withKey.baseDeploymentConfig();
  assert.equal(b.available, true);
  assert.equal(b.server_deploys, true, "RPC + deployer key → server deploys the bridge");
});

test("createDesk rejects a Base-backed desk when Base deployment is not configured", async () => {
  // No baseRpc / key configured: a desk that needs a bridge must fail loudly rather than silently
  // dropping the Base side or falling back to the browser wallet.
  const handlers = new SponsoredStellarDeployHandlers({
    baseRpc: undefined,
    baseDeployerKey: undefined,
    // A friendbot URL that is never reached: the base-config guard must trip first.
    network: { rpcUrl: "http://stellar.invalid", networkPassphrase: "Test SDF Network ; September 2015", friendbotUrl: "" },
  });
  await assert.rejects(
    () =>
      handlers.createDesk({
        name: "Needs bridge",
        assets: [{ asset_id: 1, symbol: "ETH", token: "native", decimals: 18, kind: "BaseRepresented" }],
        pairs: [],
        base_assets: [{ asset_id: 1, symbol: "ETH", token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }],
      }),
    /Base deployment is not configured|Base bridge/i,
  );
});
