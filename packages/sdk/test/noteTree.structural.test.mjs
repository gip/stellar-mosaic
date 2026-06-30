// Structural test for the pure NoteTree assembly — mirrors the Rust path-server test
// `paths_fold_to_root_for_all_leaves` (tools/indexer/src/lib.rs). It uses a deterministic mock
// compressor (no crypto, no network): the fold-to-root invariant holds for ANY deterministic
// compressor, so this isolates the tree shape/path logic from the hash. Byte-identity of the hash
// itself is covered separately by noteTree.golden.test.mjs (real ACVM compress).
import test from "node:test";
import assert from "node:assert/strict";
import { NoteTree } from "../dist/index.js";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// Deterministic, non-crypto mixer. Distinct enough to advance the root on each insert.
const mock = async (a, b) => (((a * 0x9e3779b97f4a7c15n + b * 1000003n + 1n) % P) + P) % P;

const tag = (i) => "0x" + BigInt(i).toString(16).padStart(64, "0");

test("every leaf's path folds back to the root", async () => {
  const t = new NoteTree(mock);
  await t.ingestNote(1, "100", tag(1));
  await t.ingestNote(2, "2000", tag(2));
  await t.ingestSettled(2, "2000", tag(3), 1, "100", tag(4)); // -> leaves 2,3
  await t.ingestNote(1, "50", tag(5)); // -> leaf 4
  assert.equal(t.length, 5);

  const root = BigInt(await t.root());
  for (let i = 0; i < t.length; i++) {
    const leaf = t.leafAt(i);
    const path = await t.pathAt(i);
    const folded = await t.circuitFold(leaf, path);
    assert.equal(folded, root, `leaf ${i} path must fold to the root`);
  }
});

test("root advances on every insert", async () => {
  const t = new NoteTree(mock);
  const empty = await t.root();
  await t.ingestNote(1, "100", tag(7));
  const r1 = await t.root();
  assert.notEqual(r1, empty);
  await t.ingestNote(1, "100", tag(8));
  assert.notEqual(await t.root(), r1);
});

test("notes() and indexOfOwnerTag() track insertion order", async () => {
  const t = new NoteTree(mock);
  await t.ingestNote(1, "100", tag(1));
  await t.ingestSettled(2, "2000", tag(3), 1, "100", tag(4));
  const notes = t.notes();
  assert.equal(notes.length, 3);
  assert.equal(notes[0].owner_tag, tag(1));
  assert.equal(notes[1].owner_tag, tag(3));
  assert.equal(notes[2].owner_tag, tag(4));
  assert.equal(t.indexOfOwnerTag(tag(4)), 2);
  assert.equal(t.indexOfOwnerTag(tag(99)), -1);
});
