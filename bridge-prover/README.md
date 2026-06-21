# bridge-prover — RISC Zero / Steel guest + host (Workstream 2)

Proves that the Base `MosaicBridge` contract (`../evm`) emitted a specific `Shielded` event, and
commits the data needed to mint the matching note on Stellar. A RISC Zero **Steel** proof binds the
event to a Base block; Boundless (WS6) turns the execution into a Groth16 receipt that the Stellar
settlement contract verifies (WS4) via the Nethermind `stellar-risc0-verifier` router.

Layout mirrors `steel/examples/events`:

- `methods/guest` — the zkVM guest (`src/main.rs`): reads the Steel EVM input + a bridge address +
  a `depositId`, queries the `Shielded` event filtered to that address and indexed `depositId`,
  asserts exactly one match, and commits the `Journal`.
- `host` — preflights the event query against a Base Sepolia RPC, builds the Steel input, runs the
  guest (executor / dev mode), and decodes the journal.
- `methods` — embeds the guest ELF + image id (`embed_methods`).

## The Journal — the WS2→WS4 contract

```solidity
struct Journal {
    Commitment commitment;   // Steel: id (version<<240 | blockNumber), digest = blockHash, configID
    address    bridgeAddress;// the MosaicBridge queried (WS4 pins the expected value)
    uint64     depositId;    // single-use replay key on Stellar
    uint32     assetId;      // == Stellar register_asset id
    uint256    amount;       // note amount (fits Stellar i128)
    bytes32    ownerTag;     // BN254 Fr; note leaf = Poseidon(assetId, amount, ownerTag)
}
```

WS4 verifies the receipt against the pinned **image id**, then checks: `commitment.configID` ==
the expected Base Sepolia config digest, `bridgeAddress` == the pinned bridge, `commitment.digest`
∈ the relayer-attested Base block-hash registry, and `depositId` unused — then inserts the leaf.

Current image id (`bridge_methods::BRIDGE_GUEST_ID`, changes if the guest or its deps change):

```
[2405514352, 3264694768, 3562173843, 541524737, 3246893697, 3843912044, 1625681094, 2179075711]
```

## Prerequisites

- Rust 1.96 (pinned in `rust-toolchain.toml`) + the RISC Zero toolchain (`cargo-risczero`, `r0vm`).
- The PICO/bless **steel** checkout at `../../PICO/bless/steel` relative to this repo — the path deps
  in `Cargo.toml` and `methods/guest/Cargo.toml` point at `crates/steel` there (external, like
  `vendor/`). Adjust the two `risc0-steel = { path = ... }` lines if your checkout differs.

## Build & run

```bash
cargo build                       # builds host + cross-compiles the guest, fixes the image id

# Needs a real Shielded event on-chain: deploy via ../evm and shield first.
RPC_URL=https://sepolia.base.org RUST_LOG=info \
  cargo run --release -- --bridge 0x<MosaicBridge> --deposit-id 0
```

Local executor (dev mode) only proves the guest runs and produces the journal. A real Groth16
receipt for Stellar comes from Boundless (WS6).

## Base Sepolia chain spec

Host and guest build an identical `ChainSpec::new_single(84532, SpecId::PRAGUE)` so the committed
`configID` matches. If live proving rejects Base (OP-stack) headers under the Ethereum header type or
the chosen fork, revisit the `SpecId` / chain spec here — flagged for WS8 live verification.
