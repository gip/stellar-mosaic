import test from "node:test";
import assert from "node:assert/strict";
import { NoteEventReplayer, replayNoteEvents } from "../dist/index.js";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const mock = async (a, b) => (((a * 0x9e3779b97f4a7c15n + b * 1000003n + 1n) % P) + P) % P;
const tag = (i) => "0x" + BigInt(i).toString(16).padStart(64, "0");

const events = [
  { kind: "shielded", asset: 1, amount: "100", owner_tag: tag(1) },
  { kind: "noteins", asset: 2, amount: "200", owner_tag: tag(2) },
  {
    kind: "settled",
    a_asset_out: 2,
    b_amount_in: "100",
    a_output_owner_tag: tag(3),
    b_asset_out: 1,
    a_amount_in: "200",
    b_output_owner_tag: tag(4),
  },
];

test("replayNoteEvents rebuilds notes, root, and paths from tree events", async () => {
  const state = await replayNoteEvents({ events, compress: mock });
  assert.equal(state.event_count, 3);
  assert.equal(state.notes.length, 4);
  assert.deepEqual(
    state.notes.map((note) => note.owner_tag),
    [tag(1), tag(2), tag(3), tag(4)],
  );
  const proof = await state.tree.noteProofAt(3);
  assert.equal(proof.leaf_index, 3);
  assert.equal(proof.root, state.root);
});

test("NoteEventReplayer caches and exposes NoteSource plus full replay state", async () => {
  let calls = 0;
  const replayer = new NoteEventReplayer({
    compress: mock,
    events: async () => {
      calls += 1;
      return events;
    },
    fills: async () => [{ id: "f", ledger: 1, tx_hash: "tx", asset_in: 1, amount_in: "100", asset_out: 2, amount_out: "200", owner_tag: tag(3) }],
  });
  assert.equal((await replayer.notes("desk")).length, 4);
  assert.equal((await replayer.fills("desk")).length, 1);
  assert.equal((await replayer.notePath("desk", tag(4))).root, await replayer.root("desk"));
  assert.equal((await replayer.replay("desk")).events.length, 3);
  assert.equal(calls, 5);
});
