# Design: order-book matching in Noir (WS4)

Design document for moving from the **simplistic on-chain order book** to an **off-chain book whose
matching runs in Noir and is verified on-chain** — and, as the enabling step, moving orders and
nullifiers from flat per-key storage into **merkle trees**.

Read `simple-order-book.md` for what exists today and `architecture.md` for the settlement shape.

## Where we are today

The contract stores book and spend state as flat Soroban entries (`contracts/settlement/src/lib.rs`):

- **Nullifiers:** one persistent key per spend, `DataKey::Nullifier(BytesN<32>)` — an **unbounded
  set**. This is the only unbounded rent surface in the protocol.
- **Orders:** `DataKey::Book(pair_id, side) -> Vec<OrderEntry>` (≤64), read-modify-written every op.
- **Roots:** `DataKey::Root(BytesN<32>)` — an unbounded set of accepted tree roots.

Matching itself happens in plaintext: `settle` crosses two verified order proofs in the clear, and
`submit_order` walks the sorted `Vec` and fills. The proof authorizes the *spend*; the *match* is
trusted contract logic. That caps book depth at 64/side and makes each fill pay depth-32 Poseidon
inserts (see `benchmarks.md`).

## WS4.1 — orders and nullifiers in a merkle tree (the enabling step)

**Nullifiers → an indexed merkle tree (accumulator).** Replace the per-spend key set with a single
accumulator root and prove **non-membership in-circuit** at spend time. An *indexed* merkle tree
(each leaf stores `{value, next_value, next_index}`, à la Aztec/Tornado-Nova) lets a spend prove "my
nullifier is not yet in the set" with one low-leaf membership proof, then insert it. Effect: live
state for nullifiers collapses from O(spends) to **O(1)** (one root + a small append structure),
removing the unbounded rent surface flagged in `implementation.md`.

**Orders → a commitment tree.** Move resting orders out of the monolithic `Vec` into an append-only
order-commitment tree keyed per pair/side, with cancellation handled by a nullifier (already the
model — `cancel_order` proves knowledge of `cancel_owner_tag`). This unbounds depth beyond 64, makes
a fill touch only the entries it consumes (vs. re-serializing the whole side), and lets resting
*orders* gain the same owner-anonymity the note tree already gives *balances*.

Both reuse the contract's existing on-chain Poseidon2 `compress` (byte-identical to the circuits), so
the indexer (`tools/indexer`) extends to these trees with no new hash.

## WS4.2 — matching in Noir, verified on-chain

With orders and nullifiers in trees, the matcher becomes a **prover**: an off-chain matcher selects
crossing orders and produces a Noir proof that the match is valid against the public order-tree root,
which the contract verifies in one shot instead of re-deriving the cross itself.

Proposed matching-circuit public interface (sketch):

```
public:  order_root         // root the matched orders are members of
         nullifier_root_in  // accumulator before this match
         nullifier_root_out // accumulator after consuming the matched orders' spend-nullifiers
         proceeds[]         // (asset, amount, output_owner_tag) leaves to mint
private: matched orders + their membership paths
         the lot decomposition (exact-ratio lots; see simple-order-book.md)
assert:  each order is a member of order_root
         prices cross (U256 cross-multiplication, in-circuit)
         conservation: proceeds + returns == amounts consumed
         nullifier_root_out = insert(nullifier_root_in, spend nullifiers)
```

The contract then: verifies the proof (~80M, fixed), checks `nullifier_root_in` is current, advances
to `nullifier_root_out`, and mints `proceeds`. Matching trust moves from contract code to a verified
circuit, and a single proof can settle a multi-order sweep that today costs many on-chain inserts.

## Why this is WS4, not WS1

It is a strictly harder, optional evolution: the v1 plaintext book already settles soundly and fits
the budget. WS4 buys **unbounded depth, O(1) nullifier state, resting-order privacy, and cheaper deep
sweeps** — at the cost of a matching circuit and the tree migrations. Sequencing: WS4.1 (trees) first,
because the matching circuit proves against those roots.

## Data availability: a fully-direct frontend (no backend for reads)

Order terms are public (the model is owner-anonymous, *amount-transparent*), so a client may read the
whole book. The design makes the **book fully event-derived** so a frontend can reconstruct it
straight from Soroban RPC, with the desk backend reduced to optional conveniences (sponsored
relaying, durable queues, fast path-serving) — never a trust anchor. The on-chain roots are the only
trust anchor.

**Active vs. consumed.** Two event streams suffice:

- `OrderInserted` (topic `orderins`) is emitted on every placement *and* every re-rested match
  remainder, carrying the **full public terms** (`asset_in, amount_in, asset_out, min_out,
  output_owner_tag, cancel_owner_tag, expiry, partial_allowed`) **plus the leaf**. So the book needs
  no per-tx calldata fetching.
- Consumption (match **or** cancel, identically) inserts the order's consumption nullifier
  `compress(ORDER_NULLIFIER_DOMAIN, order_leaf)` into the IMT and emits `NullifierSpent` (topic
  `nfspent`).

An order is **active** iff its leaf appears in `orderins` and `compress(ORDER_NULLIFIER_DOMAIN,
order_leaf)` is **not** in the set of `nfspent` nullifiers — one Poseidon2 hash per order to test.
(`nfspent` also carries secret-derived note-spend nullifiers, but those are structurally different
values, so the membership test never collides.)

**Bounded retention.** A correct book would naively need all events from genesis. Instead,
`place_order` enforces `MAX_ORDER_TTL` (7 days): an order can neither be already-expired nor rest
longer than that, and the **match circuit refuses `expiry < now`**. So any order older than the
window is provably unmatchable, and a fully-direct client only needs `getEvents` over `[now −
MAX_ORDER_TTL, now]` (cursor-paginated, cached locally, incremental on reload). Set `MAX_ORDER_TTL`
at or below the RPC's `eventLedgerRetentionWindow`.

**The one piece that still needs a tree source.** Reading the book is fully-direct; *building proofs*
is not. A membership path in an append-only tree needs **all earlier leaves** (note tree:
`shielded`+`noteins`; order tree: `orderins`) from genesis — more than any retention window, and
growing forever. The contract's stored `TreeFilled` frontier (readable via `getLedgerEntries`) lets a
client append / compute the *current root* but not an arbitrary leaf's path.

| Capability | Fully-direct from RPC? |
|---|---|
| Active order book / quotes (within `MAX_ORDER_TTL`) | yes |
| Detecting your own fills / consumption | yes |
| Membership paths for proving | no — needs full tree history |

That tree source is a **decentralizable, read-only indexer** (the desk's, a third party's, or
self-hosted — it only *reconstructs* public data) or a periodically published **tree snapshot**
clients sync once and extend incrementally. WS4 ships the event-derived book + bounded retention now;
third-party indexers / a snapshot scheme for path-serving come later.

## Open questions

- Indexed-merkle-tree vs. sparse-merkle-tree for the nullifier accumulator (insert cost vs. proof
  size on Soroban). *(Resolved for the build: IMT.)*
- ~~Who runs the matcher~~ — permissionless submission; the residual MEV/ordering freedom (a valid but
  not necessarily best-priced match can be the one that lands first) is a documented limitation, since
  proving *global* optimality over an open-ended book is infeasible in a fixed circuit. WS5 territory.
- ~~Migration~~ — hard cutover (fresh deploy); no production funds to migrate.
- Path-serving without any indexer: a verifiable tree-snapshot / checkpoint scheme so even proving is
  backend-optional.
