# Contract roadmap

Status of the settlement contract's remaining work, tiered by what blocks production vs. polish.
The original phased implementation plan (now executed) was the order-book build: pair registry +
`settle_exact` (Phase 1) and the on-chain ZK order book (Phase 2). This file tracks what's left.

Legend: ✅ done · ◻ open

## Tier 1 — safety / correctness (production-blocking) — COMPLETE

- ✅ **Storage durability.** All fund-critical state is persistent/instance (never temporary, so never
  deletable; archived persistent entries are restorable and can't be silently read as absent → no
  loss, no archival double-spend). TTL is bumped to max on write, with permissionless `keep_alive` /
  `keep_alive_keys` heartbeats + restore as the backstop. See [storage-durability.md](storage-durability.md).
- ✅ **Worst case fits all per-tx resource limits.** Measured on testnet from the worst-case taker's
  on-chain footprint: 359.8M instructions (~89% of 400M), 25,776 write bytes (~20% of the ~130 KB
  cap), 0 disk-read bytes (Protocol 23 in-memory model). Network acceptance confirms every cap is
  satisfied. See [order-book.md](order-book.md).

## Tier 2 — robustness

- ◻ **Crossed-book crank (`match_book`).** Liquidity-quality fix: a partial-allowed taker that sweeps
  a book deeper than `MAX_FILLS_PER_SUBMIT` rests its remainder over still-crossing makers, leaving a
  price-crossed book until the next taker arrives. Add a permissionless crank that crosses top-of-book
  resting orders (reusing `compute_lots`, no new proof — both sides were verified when they rested).
  Not a fund-safety issue; only reachable with a deep crossing book + the fill cap.
- ◻ **Unbounded root history** → bounded-ring eviction (every produced root currently stays accepted
  forever; nullifiers prevent double-spend regardless of root recency).
- ◻ **Book storage: keyed entries + sorted index.** v1 stores each side as a bounded
  `Vec<OrderEntry>` (re-(de)serialized per op). Move to `DataKey::Order(pair, side, slot)` + a
  price-sorted index so a fill touches only the entries it consumes. Do only if the measured
  write-bytes / CPU headroom demands it (currently comfortable).
- ◻ **Test gaps.** FOK taker revert (`NotPartialAllowed`) with a real proof; `prune_expired` on
  testnet (awkward against the real clock — needs a near-future-expiry fixture).
- ◻ **Richer events + stable order ids.** Only `noteins` is emitted today; add
  `placed`/`filled`/`cancelled`/`pruned` with an order id for indexers/UX.

## Tier 3 — productionization / design

- ◻ **Admin surface.** Contract upgradeability + a pause switch; pair relisting/delisting (pairs are
  currently permanent).
- ◻ **Nullifier accumulator.** Replace the per-spend nullifier set (the only unbounded rent surface)
  with a single accumulator root, proving non-membership in-circuit. Bounds live state to O(1).
- ◻ **Lot-granularity / tick-size policy.** Partial fills execute in whole "lots" = the reduced price
  denominator, so coprime-priced orders can't partially fill. A tick-size policy would tame it.
- ◻ **Relayer / MEV ordering.** `submit_order` ordering is relayer-controlled; do a threat-model pass.

## Demo status

Functionally complete and demonstrable end-to-end on testnet (un-hardened):
- Atomic settle lifecycle: `scripts/04_demo_e2e_testnet.sh` (shield → order → settle → unshield).
- Order book lifecycle: `scripts/06_book_budget_testnet.sh` (shield → rest → cross/partial-fill →
  cancel); worst-case stress: `scripts/07_book_worstcase_testnet.sh`.
- 34 local tests (real UltraHonk + cancel proofs on the Soroban host).

Not hardened: no keeper running (TTL upkeep manual; data safe regardless), demo scripts use literal
owner tags + map both asset-ids to the native XLM SAC, no frontend/wallet/relayer, plus the Tier 2/3
items above. None of the gaps can lose funds.
