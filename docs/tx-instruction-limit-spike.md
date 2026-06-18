# Spike: per-transaction CPU instruction limit (it is 400M, not 100M)

Measured 2026-06-18. Supersedes the ~100M assumption that M0 and several downstream decisions were
built on.

## The limit

From `stellar network settings` (`contract_compute_v0`), identical on **testnet and mainnet**:

| setting | value |
|---|---|
| `tx_max_instructions` (per-tx CPU cap) | **400,000,000** |
| `ledger_max_instructions` (per-ledger) | 580,000,000 |
| `tx_memory_limit` | 41,943,040 (40 MiB) |
| `fee_rate_per_instructions_increment` | 7 stroops |

These are validator-voted and adjustable. The raise (from the old ~100M) lines up with Protocol 25
(X-Ray), which also added the BN254/Poseidon ZK host functions.

## The simulator gap (important)

The RPC simulator and the enforced network cap are NOT the same number:

- The simulator reports the **true metered instruction count**, linearly, with no clamping. Probe
  fit: `declared = 2,098,572 + n × 1,062,567` exactly at every `n` (no leeway padding).
- But the simulator runs with a **higher CPU budget (~416M)** than the enforced 400M. So a tx
  metering 400M-416M **simulates cleanly yet is rejected at submission**, and the CLI does not
  auto-clamp declared instructions to the cap.

Empirical confirmation (probe `insert_like(n)`, ~1.06M instr/iter):

| n | declared instr | simulate | submit |
|---|---|---|---|
| 374 | 399,498,630 (<400M) | OK | **accepted + executed on-chain** |
| 375 | 400,561,197 (>400M) | OK | (would be rejected) |
| 389 | 415,437,124 | OK | **rejected: `TxSorobanInvalid`** |
| 390 | ~416,499,691 | `Budget/ExceededLimit` | - |

**Rule: design to 400,000,000. Do not trust "simulation passed" near the ceiling** — check declared
instructions ≤ 400M, and be ready to set resources manually for txs close to the limit.

## Implications at 400M (re-derived)

| operation | instructions | % of 400M |
|---|---|---|
| one UltraHonk verify | ~80M | 20% |
| lift (verify + store), measured | 81.2M | 20% |
| unshield (verify + transfer), measured | 81.3M | 20% |
| **two verifies in one tx** | ~160M | **40% - FITS** |
| depth-32 Poseidon insert | 36M | 9% |
| **partial-fill settle, 4 on-chain inserts** | 138M | **35% - FITS** |

## Decisions this REOPENS (not re-decided here)

1. **"Two verifies in one tx is infeasible" (M0) is now FALSE.** Two spend proofs (~160M) fit in 40%
   of one tx. Settlement could collapse to a **single atomic tx that verifies both sides**, dropping
   the verify-at-lift / settle-cheap split, the pre-verified pool entries, and nullify-at-lift. Major
   simplification of the core protocol - revisit `architecture.md` settlement design.
2. **The Merkle-tree decision (off-chain builder, Option B) reopens.** An on-chain incremental tree
   (Option A) now fits easily: a depth-32 insert is 9%, and even a 4-insert partial-fill settle is
   35%. A trustless on-chain root needs no batching or depth reduction. Revisit
   `poseidon-tree-spike.md`'s recommendation.

## Caveats

- **Fits != free.** Non-refundable fee scales with instructions (rate 7 per 10k). A 160M tx costs
  ~2x an 80M tx; instructions are a surge-priced resource under contention.
- **Per-ledger cap is 580M**, so ~3 of a 160M settle per ledger max - a throughput ceiling to note
  for scale, not v1.
- Confirm a real two-verify tx also fits **memory** (40 MiB) - likely fine, but unmeasured.
