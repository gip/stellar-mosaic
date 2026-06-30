// Phase 4: the self-contained bundle. Validates that the Node asset loaders resolve the packaged
// circuits/VKs/manifest, and that the bundled `circuitProvider` drives makeWalletMath to the same
// byte-identical owner_tag as the witness bin — i.e. the assets -> CircuitProvider -> wallet-math
// chain works end to end with zero external files.
import test from "node:test";
import assert from "node:assert/strict";
import { loadVk, loadProtocolRelease, circuitProvider } from "../dist/assets.node.js";
import { makeWalletMath } from "../dist/index.js";

const GOLDEN_TAG = "0x2031ab2419820a34de7a7dc3ab86454fb63f10cc4a8950993264442eb1b957ae";

test("bundled circuitProvider drives makeWalletMath to the golden owner_tag", async () => {
  const wm = makeWalletMath(circuitProvider);
  assert.equal(await wm.noteTag("5", "9"), GOLDEN_TAG);
});

test("bundled VKs and manifest load", async () => {
  const lift = await loadVk("lift");
  assert.ok(lift.length > 0, "lift vk has bytes");
  const release = await loadProtocolRelease();
  assert.equal(typeof release.schema_version, "number");
  assert.ok(release.vk_hashes.lift, "manifest has lift vk hash");
});
