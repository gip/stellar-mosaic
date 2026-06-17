# Full-flow review: private OTC/DEX desk

Reviews the end-to-end flow (deposit -> order -> match -> settle) against what Milestone 0
validated: native UltraHonk verify ~82% of the per-tx budget (so ONE verify per tx), cheap
verify-free settle, no trusted setup, relayer submits. See `milestone-0-results.md` and
`settlement-design.md`.

TL;DR: the flow is sound and maps cleanly onto verify-at-lift/settle-cheap, on ONE condition —
**amounts are public (lit), owners are hidden.** That single choice (already our v1 decision)
makes settlement work without a proof. There are 3 real blockers and several clarifications below.

---

## 1. Contracts and their functions

### A. Assets contract (custody + note registry)
Holds real tokens and owns the note state (commitment set + nullifier set). One registry so
there is a single source of truth for "which notes are valid / spent."

- `add_supported_asset(asset)` / `remove_supported_asset(asset)` — admin-gates which assets the
  desk supports (USDC, XLM, ETH, XRP). (NOT per-user; see clarification Q1.)
- `deposit(asset, amount, commitment, proof)` — pull `amount` of real `asset` from the caller
  (SAC `transfer`), VERIFY the proof that `commitment` encodes exactly `(asset, amount, owner)`
  with `owner` hidden, then record `commitment` as an **active** note. (One verify ~82% budget.)
- `withdraw(asset, amount, spend_proof, nullifier)` — VERIFY a spend proof for an active note,
  nullify it, pay out `amount` real tokens. (One verify.)
- `consume_and_create(...)` — internal/authorized entry the Desk calls to nullify input notes
  and insert new commitments atomically (used by order-lift and settle). Access-controlled so
  ONLY the Desk contract can move notes between states.

### B. Desk contract (orders + matching + settlement)
Stateless re: token custody; operates on notes via the Assets contract.

- `lift_order(spend_proof, public_inputs, order_terms)` — VERIFY the spend proof that consumes
  an active asset note and creates an **active** order note encoding `(side, pair, price, max,
  output_owner_key)`; value-conservation proven in-circuit; nullify the input. (One verify ~82%.)
- `cancel_order(...)` — reclaim an unmatched order note back to an asset note (needs a proof or
  an owner check). Required so funds aren't stuck (open: nullifier-timing, see Q4).
- `settle(order_id_a, order_id_b)` — **NO verify.** Read two active order notes, check price
  compatibility + value conservation in plaintext (amounts are lit), nullify both, create the
  output note commitments (proceeds + change) as **active** notes via the Assets contract,
  atomic. (Cheap — measured ~13% of a verify.)

This is exactly the lift/settle split we proved on testnet.

---

## 2. Note model and state machine

A note = `commitment C = H(asset, amount, owner_key, nonce)`. Only `C` is on-chain. Spending
reveals a `nullifier N = H(nonce, owner_secret)` (not `C`), so mint and spend are unlinkable.

```
   created                         matched/spent
   (deposit or staged)             (consumed by order or settle)
        │                                  │
        ▼            activate              ▼
   [STAGED] ───────────────────────► [ACTIVE] ───────────────────► [CONSUMED]
   not spendable;     (atomic, in     valid, spendable    nullifier recorded;
   a pre-recorded     the settle tx)                      commitment dead
   commitment
```

- **STAGED** = a commitment recorded but not yet valid. Used so the desk can pre-record a
  trade's output commitments, then flip them to ACTIVE atomically when the inputs are consumed.
  (See blocker B2 — staging may be foldable into `settle`.)
- **ACTIVE** = spendable (a deposited asset note, a resting order note, or activated proceeds).
- **CONSUMED** = nullified.

---

## 3. The flow, step by step (annotated)

```
STEP 1  Alice deposits 100 USDC                        Assets.deposit()
  relayer submits: transfer 100 USDC in + proof
  VERIFY commitment encodes (USDC,100,ownerA)  ──►  asset note A0 = ACTIVE
  cost: 1 verify (~82% budget)                       100 USDC now custodied

STEP 2  Alice places buy order (XLM/USDC, max 100)     Desk.lift_order()
  VERIFY spend proof: consume A0 (nullify), create
  order note Oa = (buy XLM, price, max=100 USDC,
  output_owner=Ka); value conserved (100 == 100)  ──► Oa = ACTIVE (resting offer)
  cost: 1 verify

STEP 3  Bob deposits XLM, places sell order            Assets.deposit() + Desk.lift_order()
  same as 1+2 for Bob                              ──► Ob = ACTIVE
  cost: 2 verifies

STEP 4  Desk matches Oa x Ob and settles               Desk.settle()
  NO verify. plaintext: prices cross? value
  conserved at fill amount? nullify Oa, Ob;
  create proceeds notes (Alice<-XLM, Bob<-USDC)
  + change notes if partial; activate them       ──► 2 consumed, 2-4 activated
  cost: ~13% of a verify
```

Total for one trade: per party = deposit + order = **2 verify-txs**; two parties = **4 verifies
+ 1 settle = 5 txs**. Each fits the budget individually (the whole point of the lift/settle
split — two verifies can't share a tx). See section 7 on amortizing this.

---

## 4. Privacy analysis

| Surface | Hidden | Visible (leaks) |
|---------|--------|-----------------|
| Note ownership | owner_key inside every commitment | — |
| Mint <-> spend link | broken by nullifier indirection | — |
| Order book | who owns each order | **price + size (lit pool, by design)** |
| Settlement | who owns the proceeds | **fill amount, the pair, timing** |
| Deposit | owner_key of the new note | **amount + asset + the funding account** |
| Withdraw | — | **amount + asset + the destination account** |

Two honest truths:
1. **Privacy is *within the pool*, not at the edges.** Deposits and withdrawals move REAL
   tokens to/from REAL Stellar accounts, so they reveal who put in / took out how much. Trading
   between deposit and withdraw is unlinkable (owners hidden), but the entry/exit is not. This is
   the standard shielded-pool limitation. Mitigations: relayer-submitted deposits, fixed
   denominations, time delays — all partial. **The relayer hides the trader's account on order
   and settle txs, but cannot hide a real token transfer's source on deposit.**
2. **Amounts are public (lit).** This is what makes verify-free settlement possible (see B1).
   The honest v1 claim stays "no direct wallet linkage," not "amount-private." Amount-hiding is
   the deferred hard mode.

---

## 5. BLOCKERS (real, must resolve before building)

### B1 — Output notes at settle have no proof; only LIT amounts make this sound. [CRITICAL, resolved-by-design]
`settle` does no verification, yet it must create output note commitments that encode the
*correct* value. A hiding commitment (amount inside) can't be checked by the contract without a
proof. Resolution (and it pins the privacy model): because the pool is **lit**, settle computes
the fill amount in plaintext and forms each output deterministically:
`C_out = H(asset_out, fill_amount_PUBLIC, output_owner_key_from_order, nonce_derived)`.
- The **order's lift proof must bind `output_owner_key`** (and the input value, for conservation).
  That is the concrete public-input set for the lift circuit — it closes soundness invariant 1.
- `nonce` derived deterministically (e.g. `H(order_nullifier || index)`) so it's reproducible
  and unique.
- Consequence: **fill amounts are public.** If amount-privacy is ever required, settle needs a
  proof (or a recursive/aggregated proof, or a Groth16 path), which reopens the budget question.

**Why settle needs NO proof for the output notes (common question).** Settle creates 2-4 new
notes, and new notes must be guaranteed correct — but NOT via a ZK proof, because the contract
*constructs them itself* from values it computed and checked in plaintext:
- **Conservation** is a plaintext check (amounts public): per asset, `sum(consumed) == sum(created)`
  at the agreed price. (Hidden amounts WOULD force a proof here — that's the amount-hiding hard mode.)
- **Owner** of each output (`owner_tag`) comes from the order notes, bound by the already-verified
  lift proofs — the desk can't redirect proceeds.
- **Well-formedness** — the contract computes `H(...)` itself; nothing for a prover to lie about.
An output note is ZK-verified at its NEXT use (when spent: membership + nullifier + ownership
proof), not at creation. This is also why STAGED is unnecessary: settle mints outputs straight to
ACTIVE inside the atomic tx. Conservation chain has no gap: deposit proof -> order lift proof ->
plaintext settle.

### B2 — Cross-contract note-state ownership. [ARCHITECTURE DECISION]
Asset notes (Assets contract) and order notes (Desk contract) share ONE logical note set
(commitments + nullifiers). If the two contracts keep separate state, a note consumed in one
isn't known-spent in the other -> double-spend. Decide:
- (a) Assets contract owns the single commitment+nullifier registry; Desk calls into it
  (cross-contract `consume_and_create`, access-controlled). Recommended.
- (b) One merged contract. Simpler state, but loses the clean asset/desk separation you wanted.
Cross-contract calls cost some CPU; must fit alongside a verify in the same tx (we have ~18%
headroom on a lift — measure it).

### B3 — Cross-chain assets (ETH, XRP) are not native to Stellar. [EXTERNAL DEPENDENCY]
USDC and XLM exist as Stellar assets (SACs). **ETH and XRP do not** — they require a bridge or
issuer (wrapped tokens). The desk can only custody what exists as a Soroban token. This is a
real dependency: either restrict v1 to Stellar-native assets (USDC, XLM) or commit to a bridge.

---

## 6. Clarifications needed

- **Q1 — "User can add/remove assets":** does this mean an admin manages the *supported asset
  list*, or a user *deposits/withdraws their own* assets? I assumed admin-manages-list +
  user-deposits. Confirm.
- **Q2 — Asset-note layer:** do you want the intermediate asset note (deposit -> asset note ->
  order consumes it), or can `deposit` create the order note directly? The asset-note layer
  costs an extra verify/tx per order but lets one deposit back several orders. Trade-off.
- **Q3 — Staging:** is STAGED an on-chain state, or just the desk's off-chain prep? If settle is
  atomic and computes outputs deterministically (B1), staging may be unnecessary — the outputs
  can be created directly in `settle`. What does staging buy you that atomic settle doesn't?
- **Q4 — Nullify-at-lift vs at-settle:** nullify the input when the order is placed (firm offer,
  needs `cancel`) or at settle (offer not guaranteed executable)? Affects funds-stuck risk.
- **Q5 — Partial fills / "4 or 2 outputs":** confirm the output structure: 2 proceeds notes
  (exact fill) + up to 2 change notes (partial fill). The change note returns the unfilled
  portion to the same owner.
- **Q6 — "Optionally another note so no fund creation":** this is value conservation. Confirm:
  the lift proof enforces `input note value == order amount + change`, and settle enforces
  per-asset `sum(in) == sum(out)` in plaintext. The "optional second note" is the change note.
- **Q7 — Self-custody vs desk-custody of proceeds:** after settle, proceeds are active notes the
  user later withdraws. Confirm users hold the note secrets (lose secret = lose funds; recovery
  is the M3 item).

---

## 7. Cost / UX reality (not a blocker, but plan for it)

A full trade is ~5 separate transactions (each party: 1 deposit + 1 order verify; + 1 settle),
because two verifies can't share a tx (~160M > 100M). Mitigations: an LP pre-deposits and rests
standing orders (its verifies are paid once, amortized over many fills); only the taker's
deposit+order are on the hot path. Latency and fees scale with verify count — design the UX so
verifies happen ahead of time, not at the moment of trade.
