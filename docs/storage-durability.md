# Storage durability: why fund-critical data can't be lost

The contract custodies real funds, so the accounting that governs them (nullifiers, the note tree,
published roots, the order book, pairs, VKs) must never disappear. This documents the guarantees and
the mechanism.

## The guarantee

Soroban has three storage tiers:

| tier | on TTL expiry | used here for |
|---|---|---|
| **temporary** | **permanently deleted**, unrecoverable | nothing (banned for fund-critical data) |
| **persistent** | **archived, not deleted** — restorable via `RestoreFootprint` (pay rent) | all protocol state |
| **instance** | archives with the contract instance; restorable | admin |

The contract uses **only persistent and instance** (verified: zero `temporary()` calls). Two protocol
properties make this safe:

1. **Archived ≠ deleted.** An archived persistent entry is moved out of the live state but kept in the
   archive forever; anyone can restore it by paying rent. There is no permanent-loss path for
   persistent data.
2. **No silent miss.** You cannot transact against an archived persistent entry as if it were absent —
   accessing an archived key fails the transaction until it is restored (preflight surfaces the
   restore). So a spent **nullifier** can never read back as "unspent" because it archived; there is
   no archival-driven double-spend.

So the worst realistic failure is **temporary inaccessibility until someone pays to restore** — never
loss, never double-spend. And restoration is **permissionless**, so a user can always recover access
to their own funds even if no keeper is running.

## The mechanism (keep it from ever archiving)

Persistent TTLs decay and the network caps how far out they can be extended (no pay-once-forever), so
durability is an ongoing job. The contract:

- **Bumps on write.** Every fund-critical write extends the entry's TTL to `max_ttl()`. The
  always-present hot state (instance, the incremental-tree singletons `TreeFilled`/`TreeNext`/
  `TreeRoot`, and the current root's membership marker) is refreshed by `bump_core` at the end of
  every state-changing call; nullifiers, books, pairs, assets and VKs are bumped where written. This
  is cheap — measured at ~0.04% of `submit_order`'s worst case (a TTL bump is a flat cost, not a
  rewrite), so it does not affect the instruction budget.
- **`keep_alive()`** — permissionless heartbeat. Re-extends all the **bounded** structural state
  (instance, tree singletons + current root, the pair registry, every pair's book sides) to max. A
  keeper calls this periodically so nothing archives in practice.
- **`keep_alive_keys(nullifiers, roots)`** — permissionless targeted heartbeat for the **unbounded**
  sets. A keeper, or a user about to spend an old note / prove against an old root, refreshes exactly
  the entries they need. Archived entries in these sets are restorable on demand regardless.

The contract instance and Wasm code entries also have TTLs; `bump_core` extends the instance, and the
code entry is extended operationally (CLI `stellar contract extend` / restore) as part of the keeper
routine.

## Operational checklist

- Run a keeper that calls `keep_alive()` on an interval comfortably shorter than `max_ttl` and bumps
  the instance + Wasm code entries.
- For the unbounded nullifier/root sets, either periodically sweep recent entries via
  `keep_alive_keys`, or rely on permissionless restore at spend time (safe, just a one-off fee).
- Long term, the per-nullifier set is the only unbounded rent surface; replacing it with a single
  accumulator root (non-membership proven in-circuit) is the scaling redesign — see the open items in
  `architecture.md`.

## Tests

`contracts/settlement/tests/book.rs::critical_state_ttl_is_extended_and_kept_alive` asserts entries
are at max TTL on write, decay (but stay live) as ledgers pass, and are re-extended to max by both
`keep_alive` and `keep_alive_keys`.
