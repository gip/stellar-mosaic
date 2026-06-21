# Base → Stellar shield bridge

Let users shield USDC on **Base (Sepolia)** and receive a spendable, owner-anonymous note on
Stellar — reusing the existing note/tree/settle machinery unchanged. One-way deposit for this phase
(lock on Base, mint on Stellar); Base-USDC is treated as equivalent to Stellar-USDC.

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
| WS5 indexer cross-chain note recovery | `tools/indexer`, `backend/` | ◻ |
| WS6 Boundless proving + receipt → seal | `bridge-prover/host`, `backend/` | ◻ |
| WS7 frontend (Base wallet + shield + status) | `frontend/` | ◻ |
| WS8 end-to-end Base-Sepolia ↔ Stellar-testnet demo | `scripts/10_demo_base_shield_testnet.sh` | ◻ script authored (live run pending infra) |

WS3 proved a BN254 Groth16 verify fits the budget; **production verification uses the Nethermind
[`stellar-risc0-verifier`](https://github.com/NethermindEth/stellar-risc0-verifier) router** (pins
soroban-sdk 25.1.0, so the settlement contract — on 26.0.1 — cross-calls it by address via
`env.invoke_contract` instead of linking the crate). Deploy the router separately; configure the
settlement contract with `configure_base_bridge(router, image_id, config_id, bridge)`.

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

Reference values for the current guest (regenerate via `bridge-prover` `print_journal_fixture`):
image id `703c618ff04997c2937552d40103472081aa87c16c711de5c6ece5607f0ee281`, Base Sepolia config
digest `96db42921002cf403b4d9b5255f9743aa8ab15f0f8480f4296ddf068d322e71d`.

## Running the end-to-end demo (WS8)

`scripts/10_demo_base_shield_testnet.sh` orchestrates: deploy `MosaicBridge` on Base Sepolia →
shield → prove (`bridge-prover --prove`, pinned to the deposit's block) → deploy + configure
settlement on Stellar testnet → `attest_base_block` (the relayer step) → `shield_from_base` → assert
the tree root advanced.

Prerequisites (the script gates on them): foundry + a funded Base Sepolia key (`PRIVATE_KEY`); the
RISC Zero Groth16 prover stack (`r0vm`/Docker, or `RISC0_PROVER=bonsai`); the stellar CLI + a funded
testnet identity; and the **Nethermind verifier router deployed on Stellar testnet** with its address
in `ROUTER_ID`. Deploy the router once from `vendor/stellar-risc0-verifier`:

```bash
./scripts/manage.sh deploy-router   -n testnet -a <acct> --min-delay 0
./scripts/manage.sh deploy-verifier -n testnet -a <acct>
./scripts/manage.sh schedule-add-verifier -n testnet -a <acct> --selector <seal-selector>
```

What a live run still validates (untested locally without the above): that Groth16 proving succeeds;
that the live router accepts our seal selector; that the `configID` our chain spec computes matches
what Steel commits at proving time; and that Base (OP-stack) headers validate inside the guest during
proving (the host preflight already fetches Base blocks fine under `SpecId::PRAGUE`).
