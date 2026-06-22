# Design: shared merkle tree for Stellar ⇄ Base (WS5)

Design document for the moonshot: a **note merkle tree shared between Stellar and Base**, so a
shielded note is natively spendable on either chain — and a sketch of the **KYC / permissioned desk**
variant. This is exploratory; the goal of the doc is to scope feasibility, not to commit to a build.

Read `base-bridge.md` for the one-way peg that exists today.

## Where we are today (one-way peg)

The Base bridge locks USDC on Base and a RISC Zero / Steel proof lets Stellar `shield_from_base` mint
a note into the **Stellar** note tree. The minted leaf is byte-identical to a native Stellar shield,
so the indexer, book, `settle`, and `unshield` are unchanged. But there is exactly **one** tree (on
Stellar); Base only emits deposits. There is no path back to Base, and a note never lives "on Base."

## The moonshot: one logical tree, two chains

A *shared* tree means both chains agree on the same append-only note set and the same nullifier set,
so:

- a note shielded on either chain is spendable on either chain (true two-way bridging, cross-chain
  trades), and
- a spend on one chain is visible as spent on the other (no cross-chain double-spend).

The hard parts are **root consistency** and a **shared nullifier set** across two independent ledgers
with independent finality.

### Candidate architecture A — canonical tree + mirrored root (recommended starting point)

Keep **Stellar as the canonical tree** (it already maintains the depth-32 on-chain tree with native
Poseidon). Base runs a light mirror that learns the canonical root via the **same proof mechanism
already built**: today Steel proves a Base event *to* Stellar; symmetrically, a Stellar→Base root
relay (or a ZK light-client of Stellar consensus) attests the canonical root *to* Base. Base-side
spends then prove membership against the mirrored root and emit a deposit that Stellar applies, so the
canonical nullifier set stays single-writer on Stellar. This reuses the bridge's trust model (a
relayer-attested, proof-checked root registry) instead of inventing a new one.

### Candidate architecture B — symmetric append + reconciliation

Both chains append locally and periodically reconcile via proofs of each other's appends. More
parallelism, but it needs a global ordering rule and a **shared nullifier accumulator** to make
cross-chain double-spend impossible — which is exactly the indexed-merkle-tree accumulator proposed
for WS4.1 (`noir-matching.md`). WS5 and WS4.1 share that primitive: a single nullifier root, advanced
by non-membership proofs, is the cleanest cross-chain double-spend guard.

## Feasibility risks

- **Finality / reorgs:** a note must not be spendable on chain B against a chain-A root that later
  reorgs. The bridge's *prove-then-finalize* pattern (`base-bridge.md`) already shows how to bind a
  proof to a block and wait for finality — extend it to root attestation.
- **Who maintains the canonical root** and the liveness of the relay (single attester → committee, as
  in the bridge hardening path).
- **Solvency across chains:** the current peg treats Base-USDC as fungible with Stellar-USDC; a true
  shared tree needs custody accounting that survives spends originating on either side.
- **Cost:** a Stellar light-client or root-attestation verify on Base, plus the WS4.1 accumulator, on
  top of the existing ~80M verify budget (`benchmarks.md`).

## WS5.2 — KYC / permissioned desk variant

A desk can be made **permissioned** without breaking owner-anonymity: gate entry (shield / order)
behind a credential rather than identifying the trader on-chain.

- **Allowlisted owner tags:** require `owner_tag` to be derived from a key the desk admin has
  attested, proven in-circuit — the desk knows "this is an approved participant" without learning
  which note is whose.
- **Credential proof:** carry a KYC attestation (a signed claim / verifiable credential) and prove
  possession in-circuit as an extra public input the contract checks, so compliance lives in the proof,
  not in a plaintext registry.
- **Two-tier desks:** a public desk and a permissioned desk are just different admin policies over the
  same contract — no protocol change, only an added gate on `shield`/`submit_order`.

## Verdict

Architecture A (canonical Stellar tree + proof-attested mirror on Base, reusing the bridge's Steel
machinery) is the most tractable path and shares its nullifier-accumulator primitive with WS4.1. A
fully symmetric shared tree (B) is the true moonshot and may not be worth its complexity short-term.
KYC/permissioning is independently achievable as an in-circuit gate and does not depend on the shared
tree.
