# On-chain order book

The contract keeps a **resting limit-order book on-chain**, in addition to the atomic `settle` /
`settle_exact` paths. It preserves the owner-anonymous model: order *terms* (pair, price, amount) are
public anyway (`privacy-model.md`), so the book stores them in plaintext, while owner *identity* stays
hidden exactly as for shielded notes — the order is authorized by an order proof and matched against a
hidden input note via its nullifier.

See `architecture.md` for where this sits, `implementation.md` for the (12-field) order proof, and
`note-types.md` for the note/order shapes. Cost measurements are in `benchmarks.md`.

## Model

- **Pairs** are registered once at construction in a canonical orientation (`PairDef { base, quote }`,
  e.g. `XLM/USDC`, never `USDC/XLM`); they are immutable (no post-deploy mutator). An order's side is
  derived from its `(asset_in, asset_out)` against the pair, never from how the user phrased it.
  SELL = give base / want quote; BUY = give quote / want base.
- **Orders are price+quantity limit orders.** The canonical integer terms the order proof binds
  (`amount_in`, `min_out`) define an exact limit price *ratio* — no floating point, no global price
  scale. Each order also binds `expiry` (unix seconds) and `partial_allowed` (0/1).
- **Depth:** up to `BOOK_CAPACITY` (64) resting orders per side, per pair. Each side is kept
  price-sorted, best first (asks ascending, bids descending), with FIFO tie-breaking → price-time
  priority.

## Entry points

- `submit_order(proof, public_inputs)` — relayer-submittable (no caller auth; the order proof is the
  spend authority, like `unshield`). Verifies the proof, rejects if expired, locks the input note
  (records its nullifier), then the incoming order is the **taker**: it walks the best opposing
  resting orders and fills, then rests or IOC-returns the remainder.
- `cancel_order(pair_id, side, proof, public_inputs)` — relayer-submittable. The cancel proof
  (`circuits/cancel`, domain 3) proves knowledge of the order's `cancel_owner_tag` secret and binds
  `order_leaf` + `return_owner_tag`. The contract finds the entry by `(order_leaf, cancel_owner_tag)`
  and returns its remaining locked funds. Removing the entry is the replay guard.
- `prune_expired(pair_id, side, max)` — permissionless. Removes expired entries and returns each one's
  locked funds to its own bound `output_owner_tag` (safe: the destination is fixed by the maker, not
  the caller).
- `book(pair_id, side)` — read-only view of a side.

## Matching: exact-ratio lots (why there is no rounding)

A match executes at the **maker's** limit price (price-time priority). To keep integer conservation
exact, the trade is decomposed into whole **lots** of the maker's *reduced* price ratio:

```
g          = gcd(maker.amount_in, maker.min_out)
base_lot   = (maker SELL ? amount_in : min_out) / g     # base per lot
quote_lot  = (maker SELL ? min_out  : amount_in) / g     # quote per lot
k          = min(maker_remaining / maker_lot, taker_remaining / taker_lot)   # lots to fill
fill_base  = k * base_lot ;  fill_quote = k * quote_lot
```

Because every lot is `base_lot` base for exactly `quote_lot` quote, the executed price equals the
maker's limit exactly and both legs are integers — **no flooring, no dust**. Sub-lot leftovers stay
locked as `remaining_in` and are returned on cancel/prune. Lot size = the reduced denominator of the
price; round-number orders (e.g. 100 base for 2000 quote → 1:20) fill one base unit at a time, while
pathologically coprime amounts can only fill whole-order (a documented limitation).

Crossing test (do limit prices overlap), computed in `U256` since factors are `< 2^127`:
`maker.min_out * taker.min_out <= maker.amount_in * taker.amount_in`.

## Conservation invariant

Per order, per asset: `sum(proceeds minted across fills) + funds returned (cancel/prune/IOC) ==
amount_in locked at submit`. The conserved quantity is `OrderEntry.remaining_in` (locked `asset_in`
still held); every payout flows through one `mint_note` choke point, which decrements locked balances
by exactly what it mints. The book test asserts this end to end.

## Partial-execution flag

- A **maker** with `partial_allowed = false` is only matched if the fill consumes it entirely;
  otherwise it is skipped.
- A **taker** with `partial_allowed = false` is fill-or-kill: if it cannot fully fill on arrival, the
  whole transaction reverts (so its funds are never locked).
- With the flag set, the taker fills what crosses (capped at `MAX_FILLS_PER_SUBMIT`), then rests if a
  slot is free, else IOC-returns the remainder as a note.

## Storage & cost

v1 stores each book side as a bounded `Vec<OrderEntry>` (≤64) under `DataKey::Book(pair, side)`,
read-modify-written per op. The real cost driver is **proceeds inserts** (each fill mints 2 asset
notes, each a depth-32 Poseidon chain), not book depth; `MAX_FILLS_PER_SUBMIT = 4`, sized so the full
worst case fits the per-tx budget with ~11% margin. The planned optimization is individually-keyed
entries (`DataKey::Order(pair, side, slot)`) + a price-sorted index, deferred until the byte cost is
measured. Full cost figures and the worst-case measurement are in `benchmarks.md`.

## Off-chain indexer

The contract emits a replay-complete, globally sequenced book log. `ordupsert` carries the full
current value of a new or partially-filled entry; `ordremove` identifies a filled, cancelled, or
expired entry by its unique `order_id` (the already-public input nullifier). A client starts at the
constructor's `bookinit`, validates every consecutive sequence, and sorts equal-price entries by
their first-upsert sequence. `assetreg` and `pairreg` make the market registry independently
replayable as well. The frontend persists this state and the RPC cursor atomically in IndexedDB.

Each leaf the book inserts (fill proceeds, cancel/prune/IOC returns) is announced with a `noteins`
`(asset, amount, owner_tag)` event, in insertion order. The path server (`tools/indexer`) replays them
via `ingest_note`, exactly like `shielded`, so a wallet can rebuild membership paths for its
book-created notes and later `unshield` them. The book test cross-checks that the replayed root equals
the on-chain root.
