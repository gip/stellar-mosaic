// Wallet-math golden test: exercise makeWalletMath end-to-end over the REAL compiled note_tag
// circuit (via a fs-backed CircuitProvider), and assert noteTag(sk,rho) matches the value the
// canonical Rust witness bin computes. Proves the injected-CircuitProvider extraction of the
// frontend's noir.ts is byte-identical. SKIPS if the circuit ACIR isn't compiled.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeWalletMath } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const circuitFile = (name) => resolve(repo, `circuits/wallet/${name}/target/${name}.json`);

// witness `notetag 0x..05 0x..09` -> owner_tag = compress(compress(sk,0), rho).
const GOLDEN_TAG = "0x2031ab2419820a34de7a7dc3ab86454fb63f10cc4a8950993264442eb1b957ae";

test("makeWalletMath.noteTag matches the witness-bin owner_tag", async (t) => {
  if (!existsSync(circuitFile("note_tag"))) {
    t.skip("note_tag circuit not compiled");
    return;
  }
  const provider = async (name) => JSON.parse(readFileSync(circuitFile(name), "utf8"));
  const wm = makeWalletMath(provider);
  const tag = await wm.noteTag("5", "9");
  assert.equal(tag, GOLDEN_TAG);
});
