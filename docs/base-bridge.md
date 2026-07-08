# Base → Stellar shield bridge

Let users shield an asset on **Base (Sepolia)** and receive a spendable, owner-anonymous note on
Stellar — reusing the existing note/tree/settle machinery unchanged. One-way deposit for this phase
(lock on Base, mint on Stellar); the Base asset is treated as equivalent to its Stellar form.

The Base asset can be an **ERC-20** (e.g. USDC, deposited via `MosaicBridge.shield`) or **native
ETH** (deposited via the payable `MosaicBridge.shieldNative`; the asset is registered under the
`NATIVE` sentinel address). The deposit struct the guest proves — `{assetId, amount, ownerTag}` — is
identical either way, so the guest image id is unchanged. On Stellar the asset's `AssetKind` governs
the route: a **`Dual`** asset (e.g. USDC, real on both chains) accepts both `shield` and
`shield_from_base`; a **`BaseRepresented`** asset (e.g. ETH, with no real Stellar token) accepts only
`shield_from_base` and is **trade-only** (it can be traded into a `Stellar`/`Dual` asset and that
proceeds note unshielded, but the represented note itself is never `unshield`ed). A `Stellar`-only
asset is rejected by `shield_from_base` (`AssetNotBridgeable`). See `architecture.md` for the table.

## Flow

```
Base Sepolia                  RISC Zero / Steel + Boundless       Stellar (settlement)
────────────                  ─────────────────────────────       ────────────────────
MosaicBridge.shield(             guest: prove the Shielded log     shield_from_base(seal, journal):
  assetId, amount, ownerTag)       is in a Base block; commit       1. router.verify(seal, image_id,
  • transferFrom USDC→custody      Journal{ commitment, bridge,        sha256(journal))  [cross-call]
  • emit Shielded(depositId,       depositId, assetId, amount,     2. parse journal (8 ABI words)
      assetId, amount, ownerTag,   ownerTag }                      3. configID == expected (Base)
      token, from)               → Groth16 receipt (seal)         4. bridgeAddress == pinned
                                                                    5. blockHash ∈ attested registry
                                                                    6. depositId unused (replay)
                                                                    7. insert Poseidon(assetId,
                                                                       amount, ownerTag); emit
                                                                       `shielded` (indexer unchanged)
```

The minted leaf is byte-identical to a native `shield`'s, so the indexer, order book, `settle`, and
`unshield` need no changes.

## Trust model

A Steel proof only attests "event E is in the Base block with hash H." Canonicity of H comes from a
**relayer-attested block-hash registry** on Stellar (`attest_base_block(block_number, block_hash)`,
admin/relayer-gated). `shield_from_base` checks the journal's `commitment.digest` against it. Trust
root = the attester (single attester for v1; a committee is a later hardening). The guest image id is
pinned, so the receipt proves the exact guest ran; `configID` binds the Base Sepolia chain spec; the
bridge address is bound in-journal and checked.

**Solvency caveat (one-way peg):** the real USDC is locked in the Base `MosaicBridge`, but the
Stellar note is fungible with Stellar-custody USDC and `unshield` pays from Stellar custody. v1
accepts this per the equivalence assumption; a Stellar→Base withdraw leg is deferred.

## Components

| Workstream | Location | Status |
|---|---|---|
| WS1 Base bridge (Solidity) | `evm/` (`MosaicBridge.sol`) | ✅ 14 forge tests |
| WS2 RISC Zero / Steel guest + host | `bridge-prover/` | ✅ builds; image id fixed |
| WS3 Groth16-on-Soroban feasibility spike | `contracts/groth16_spike/` | ✅ ~26M CPU (~6.6%) |
| WS4 `shield_from_base` + registry + replay | `contracts/settlement/src/lib.rs` | ✅ 10 tests |
| WS5 indexer cross-chain note recovery | `tools/indexer`, `backend/` | ✅ works unchanged (shared `shielded` event) |
| WS6 proving + receipt → seal | `bridge-prover/host` | ✅ local Groth16 (`--prove`) |
| WS6-prover async prove service | `backend/` (`prove_manager.rs`, `prove.rs`) | ✅ submit/poll HTTP wrapper around `bridge-prover` |
| WS6-worker Base-shield lifecycle | `packages/mcp` (`baseShieldWorker.ts`) | ✅ durable submit → poll → finality → mint |
| WS7 frontend (Base wallet + shield + status) | `frontend/` | ✅ "Shield from Base" tab |
| WS8 end-to-end Base-Sepolia ↔ Stellar-testnet demo | `scripts/10_demo_base_shield_testnet.sh` | ✅ validated live (2026-06-21) |

**OP-stack note:** Base is an OP-stack chain, so the bridge proves a deposit from **contract state**
(a `deposits(uint64)` view call via `eth_getProof`, using `risc0-op-steel`), not from an event —
every Base block carries a type-`0x7e` deposit tx that the Ethereum receipt decoder (needed for
event/log proofs) rejects. State proofs read only the account/storage trie, so they sidestep it.

WS3 proved a BN254 Groth16 verify fits the budget; **production verification uses the Nethermind
[`stellar-risc0-verifier`](https://github.com/NethermindEth/stellar-risc0-verifier) router** (pins
soroban-sdk 25.1.0, so the settlement contract — on 26.0.1 — cross-calls it by address via
`env.invoke_contract` instead of linking the crate). Deploy the router separately; configure the
settlement contract with `configure_base_bridge(router, image_id, config_id, bridge)`.

Desk creation deploys this bridge in one of two ways, by mode:

- **Trusted (MCP-served) desks**: the server deploys *everything*. `create_desk` deploys the Stellar
  settlement contract (friendbot-funded sponsor keypair) and, for desks with Base-backed assets, the
  `MosaicBridge` on Base Sepolia — signed and paid by a single operator key (`MOSAIC_BASE_DEPLOYER_KEY`),
  which also becomes the bridge owner — then calls `configure_base_bridge`. The browser never touches
  MetaMask; the server records the deploy activity (Stellar deploy + bridge deploy + configure, with
  tx hashes) which the wallet pulls back via `activity_since`. A failed bridge deploy leaves the
  Stellar desk intact and is retried server-side with `retry_base_deployment`.
- **Trustless (self-funded) desks**: the browser wallet pays, so it deploys the bridge from MetaMask
  on Base Sepolia as part of the SDK `client.deploy` flow, with all selected Base ERC-20 mappings in
  the constructor. The (legacy) `complete_base_deployment` path independently checks the deployment
  receipt, exact runtime bytecode, owner, and mappings through `MOSAIC_BASE_RPC` before attaching.

Both paths deploy through the canonical CREATE2 proxy (`buildBridgeDeployment` in the SDK), so the
init-code and resulting address derivation are byte-identical across browser and server.

**Permissioned desks gate the Base leg on Base, not on Stellar.** The journal proves only
`(assetId, amount, ownerTag, depositId, bridge, block)` — the depositor's address never reaches the
Stellar contract, and extending the guest to commit it would rotate the pinned image ID and leak the
address on-chain. So a permissioned desk's bridge is deployed with two extra constructor args
(`bool permissioned, address[] initialAllowed`) and `shield`/`shieldNative` require `msg.sender` to
be on the owner-managed, add-only allowlist (`addAllowed`, `NotAllowed`/`NotPermissioned` errors,
`AllowedAdded` event). A disallowed deposit simply never happens, so the guest, journal, image ID,
and `shield_from_base` are all unchanged. The flag is a regular storage bool — **not** `immutable` —
because trustless verification compares the deployed runtime bytecode against the vendored artifact,
and immutables are embedded in runtime code.

## Server automation (WS6): a prove service + an MCP worker

Proving can't run in a browser (Steel/Groth16), and a single proof takes ~10 minutes — too long to
hold an HTTP connection open. So the server side is split into two cooperating pieces plus the
unchanged `bridge-prover`:

**The prove service (`backend/`).** A tiny, stateless-by-design async job server that wraps
`bridge-prover/run-host`. Two token-gated endpoints (bearer `MOSAIC_PROVER_TOKEN`):

- `POST /prove/base-deposit {job_id, bridge, deposit_id}` — idempotent by `job_id`: returns `done`
  if artifacts already sit on disk (`<prover_dir>/out/<job_id>/{seal,journal}.bin`), `running` if a
  task is in flight, else spawns the prover in the background and returns immediately.
- `GET /prove/base-deposit/:job_id` — `running | done | error | not_started`; `done` carries
  `{seal_hex, journal_hex, block_number, block_hash}`.

Proving is serialized (a permit semaphore of 1) and proves at a recent in-window head, which the
seal commits and never expires. Disk artifacts are the durable "done" cache, so a completed proof
survives a service restart; an interrupted one reports `not_started` and is safely re-proven.
Requires `MOSAIC_BASE_RPC`, `MOSAIC_PROVER_DIR`, `MOSAIC_CAST_BIN`, `MOSAIC_PROVER_TOKEN`.

**The MCP worker (`packages/mcp/src/baseShieldWorker.ts`).** A durable, crash-resumable loop that
owns the whole lifecycle and drives the prove service by **submit + poll** (never a held
connection). Each tick advances the oldest `base_shields` job **per lifecycle stage** through
`proving → awaiting_finality → minting → active|failed`, so the stages pipeline: one deposit's
finality wait never blocks the next deposit's proving (the prove service serializes proving
itself, so concurrent submits just queue there):

- `proving` — `submitProve` (idempotent), then `pollProve`; on `done` it persists
  seal/journal + committed block and moves to `awaiting_finality`.
- `awaiting_finality` — a direct `eth_getBlockByNumber("finalized")` JSON-RPC check against
  `MOSAIC_BASE_RPC` (no `eth_getProof`, no foundry on the MCP host) — the prove-then-finalize design.
- `minting` — `attest_base_block` + `shield_from_base` via the desk sponsor (the `stellar` CLI).

The job row (with persisted seal/journal) survives an MCP restart, so a mid-flight restart just
resubmits or re-polls; nothing re-holds a connection or loses work. Every step failure bumps the
job's persisted `attempts` counter and retries in-stage until an attempt cap (tight for prove
errors and mint submissions, generous for transport-level throws like an unreachable prove
service or Base RPC), then goes terminally `failed`; a re-mint the contract rejects as
`DepositAlreadyProcessed` (#27) resolves to `active` — an earlier attempt landed. Enqueue is
drift-guarded: a
bridge that isn't the desk's configured `base_deployment.bridge_address` is rejected. The worker runs
only when the MCP server is pointed at a prove service via `MOSAIC_PROVE_SERVICE_URL`,
`MOSAIC_PROVE_TOKEN`, and `MOSAIC_BASE_RPC` (plus `MOSAIC_RPC` / `MOSAIC_NETWORK_PASSPHRASE` for the
mint). Proving is local Groth16 on the prove box; swapping that step for the Boundless marketplace
(same router-compatible seal) is a drop-in future change.

## The journal — the WS2 ↔ WS4 contract

ABI-encoded, fixed 256 bytes (8 × 32-byte words), all fields static:

| word | field | meaning |
|---|---|---|
| 0 | `commitment.id` | version (top 16 bits, 0 = Block) ‖ block number (low 64 bits) |
| 1 | `commitment.digest` | Base block hash (checked against the attested registry) |
| 2 | `commitment.configID` | Base Sepolia chain-spec digest |
| 3 | `bridgeAddress` | EVM address (12 zero bytes ‖ 20 addr bytes) |
| 4 | `depositId` | single-use replay key |
| 5 | `assetId` | protocol asset id (must be registered) |
| 6 | `amount` | note amount (fits Stellar `i128`) |
| 7 | `ownerTag` | BN254 Fr; leaf = `Poseidon(assetId, amount, ownerTag)` |

The reviewed guest image ID is committed in `bridge-prover/image-id.hex`; query the built host with
`bridge-prover/run-host -- --print-image-id`. The Base e2e requires those values to match before it
deploys or proves. The Base Sepolia config digest is
`3519660d6ecbd34367740f5ca18449cba8b389594f69f177bbf21c46e505c61e`; the seal selector is
`73c457ba`.

An intentional guest source, dependency, or RISC Zero toolchain change can change the image ID.
On a mismatch, force-rebuild once to rule out stale build artifacts. If the rebuilt ID still
differs, review the resulting guest before updating `image-id.hex`, then deploy or reconfigure
Stellar with that reviewed pin. The e2e deliberately fails on drift instead of trusting the local
build automatically.

## Running the end-to-end demo (WS8)

`scripts/10_demo_base_shield_testnet.sh` orchestrates: deploy `MosaicBridge` on Base Sepolia →
shield → prove → wait for finality → deploy + configure settlement on Stellar testnet →
`attest_base_block` (the relayer step, for the block the proof committed to) → `shield_from_base` →
assert the tree root advanced. It deploys a MockUSDC on Base (no faucet) and reuses the deployed
router.

Before creating either Base or Stellar state, the script builds or loads the cached prover host,
queries `--print-image-id`, and compares it with `bridge-prover/image-id.hex`. A mismatch stops the
run before the expensive Groth16 proof and prints the explicit pin-rotation command.

**Prove-then-finalize.** `eth_getProof` only serves a recent block window (~128 on a non-archive
RPC), but a *finalized* block is hundreds of blocks back — so you can't prove directly at a finalized
block without an archive endpoint. Instead the script always proves **immediately** at the deposit's
block (recent → in-window); the seal/journal commit `(blockNumber, blockHash)` and never expire.

By **default the script then mints immediately** (fast mode) — quick but reorg-risky, so demo only:
if the proven block reorgs out before the relayer attests it, `shield_from_base` fails safely
(`BaseBlockNotAttested`) and you just re-run. Set **`WAIT_FINALITY=1`** for the reorg-safe path: it
**holds the proof and waits for that block to finalize** on Base (a pure block-number check — no
`getProof`) before minting. True finality, no archive RPC. (Earlier versions defaulted to the wait
and exposed the inverse `UNSAFE_FAST` flag; fast is now the default and the wait is opt-in.)

Prerequisites (the script gates on them): foundry + a funded Base Sepolia key (`PRIVATE_KEY`); the
RISC Zero Groth16 prover stack (`r0vm`/Docker, or `RISC0_PROVER=bonsai`); the stellar CLI + a funded
testnet identity; and the **Nethermind verifier router deployed on Stellar testnet** with its address
in `ROUTER_ID`. Deploy the router once from `vendor/stellar-risc0-verifier`:

```bash
./scripts/manage.sh deploy-router         -n testnet -a <acct> --min-delay 0
./scripts/manage.sh deploy-verifier       -n testnet -a <acct>
./scripts/manage.sh schedule-add-verifier -n testnet -a <acct> --selector 73c457ba
./scripts/manage.sh execute-add-verifier  -n testnet -a <acct> --selector 73c457ba
```

## Validated live (2026-06-21, Base Sepolia ↔ Stellar testnet)

Full chain proven end to end: Base deposit → `risc0-op-steel` state proof → local Groth16 (Docker
wrap) → Nethermind router verify on Soroban → `shield_from_base` minted the note (tree root advanced;
`shielded` event `{assetId 1, amount 1000000, ownerTag 0x11..11}`).

| thing | value |
|---|---|
| Base `MosaicBridge` | `0x0217703571840aCcb70eF602A788F5fbBC599e47` (Base Sepolia) |
| RISC Zero router | `CB3ISULTPMQXHUH6BVRO7VQIQE3TTDRGSHWBJ72V7GRO6VF63BMGNWOU` (testnet) |
| groth16 verifier / selector | `CDAWHGC5CX6JZAWYFVVKMRHVM7Z5PAXBERKVMLQ2ZFYFVNCIYZ373UEN` / `73c457ba` |
| seal / journal | 260 bytes / 256 bytes; STARK exec ~40ms, Groth16 wrap ~4.5 min |
| mint tx | `146096d8e4980c74489b3b98b322766a1477a4c478b7bd04219aa272e9786245` |

Resolved unknowns: Groth16 proving works locally (Docker); risc0 3.0 seal matches the Nethermind
verifier (selector `73c457ba`); the op-steel `configID` matches between guest and host; OP-stack state
proofs work on Base (the receipt/`0x7e` issue is avoided by proving from state, not events). The
`eth_getProof` window means proofs must target a recent block, not the deposit's block — the bridge
records the deposit in state so any recent block works, and the host reports the committed block to
attest.
