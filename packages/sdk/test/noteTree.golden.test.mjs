// Golden cross-check: build the tree with the REAL ACVM `compress` (circuits/wallet/compress) and
// assert (a) compress(1,2) matches the known-answer vector the contract/circuits/indexer agree on,
// and (b) the tree root for a fixed event log equals the root produced by the canonical Rust
// `tools/indexer` witness bin. This proves the TS path server is byte-identical to the on-chain
// note tree.
//
// Requires the compiled circuit (circuits/wallet/compress/target/compress.json) and
// @noir-lang/noir_js (resolved from the frontend workspace until the SDK gains it as a dep). The
// test SKIPS cleanly if either is unavailable, so it never blocks `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { NoteTree, makeNoirCompressor, toFieldHex } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const circuitPath = resolve(repo, "circuits/wallet/compress/target/compress.json");

// Known-answer vector and the golden root for the 5-leaf sequence below (from `witness` bin).
const KAT_1_2 = "0x299bfccd7daf3c917e51291383929049ec0eaed800af245056cbf135f7dea636";
const GOLDEN_ROOT = "0x0c1d8cc1d3cc20a82a22a8b677d5d6f9dbb90c39a3b660c0306b067c5470b784";
const tag = (i) => "0x" + BigInt(i).toString(16).padStart(64, "0");

async function loadNoir() {
  if (!existsSync(circuitPath)) return null;
  let NoirCtor;
  try {
    NoirCtor = (await import("@noir-lang/noir_js")).Noir;
  } catch {
    try {
      const req = createRequire(resolve(repo, "frontend/package.json"));
      const noirUrl = pathToFileURL(req.resolve("@noir-lang/noir_js")).href;
      NoirCtor = (await import(noirUrl)).Noir;
    } catch {
      return null;
    }
  }
  const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));
  const noir = new NoirCtor(circuit);
  return makeNoirCompressor(noir);
}

test("ACVM compress matches the known-answer vector and the witness-bin root", async (t) => {
  const compress = await loadNoir();
  if (!compress) {
    t.skip("compress.json or @noir-lang/noir_js unavailable");
    return;
  }

  assert.equal(toFieldHex(await compress(1n, 2n)), KAT_1_2, "compress(1,2) KAT");

  const tree = new NoteTree(compress);
  await tree.ingestNote(1, "100", tag(1));
  await tree.ingestNote(2, "2000", tag(2));
  await tree.ingestSettled(2, "2000", tag(3), 1, "100", tag(4));
  await tree.ingestNote(1, "50", tag(5));
  assert.equal(await tree.root(), GOLDEN_ROOT, "tree root must equal the witness-bin golden root");

  // The path for every leaf must fold back to the (real) root.
  const root = BigInt(await tree.root());
  for (let i = 0; i < tree.length; i++) {
    const folded = await tree.circuitFold(tree.leafAt(i), await tree.pathAt(i));
    assert.equal(folded, root, `leaf ${i} path folds to root`);
  }
});
