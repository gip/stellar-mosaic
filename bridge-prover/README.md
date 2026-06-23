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

The reviewed image ID is committed in [`image-id.hex`](image-id.hex). It must equal
`bridge_methods::BRIDGE_GUEST_ID`, which changes whenever the compiled guest changes. Inspect the
currently embedded ID without RPC access:

```bash
./run-host -- --print-image-id
```

The Base e2e checks this value against `image-id.hex` before deploying or proving. On a mismatch,
first use the preflight's `--force-rebuild` command to rule out stale build artifacts. If an
intentional guest source, dependency, or toolchain change still produces a new ID, review that
change, then rotate the pin with the exact command printed by the preflight. Configure the Stellar
contract with the reviewed pin; never accept a newly built ID automatically.

## Prerequisites

- Rust 1.96 (pinned in `rust-toolchain.toml`) + the RISC Zero toolchain (`cargo-risczero`, `r0vm`).
- Network access for the crates.io dependencies and the pinned `boundless-xyz/steel` git dependency
  on the first build. No external Steel checkout is required.

## Build & run

```bash
# Execute only (fast journal-only check). Needs a real Shielded event on-chain:
# deploy via ../evm and shield first.
RPC_URL=https://sepolia.base.org RUST_LOG=info \
  ./run-host -- --bridge 0x<MosaicBridge> --deposit-id 0

# Prove (Groth16) and write the router-ready artifacts to out/{seal.hex,journal.hex}.
RPC_URL=https://sepolia.base.org RUST_LOG=info \
  ./run-host -- --bridge 0x<MosaicBridge> --deposit-id 0 --prove
```

`run-host` builds the fat-LTO release binary on the first invocation, then executes it directly
while its content fingerprint is unchanged. This avoids `risc0_build::embed_methods()` rewriting
`methods.rs` and making Cargo relink the full prover stack on every `cargo run`. Host, methods, or
guest source changes; manifests and lockfiles; toolchain/configuration changes; and build-affecting
environment changes invalidate the cache. Use `./run-host --force-rebuild -- <arguments>` after an
untracked build-environment change. `CARGO_TARGET_DIR` is respected.

The launcher does not change the proof or guest image. An actual guest/dependency change still
changes the image ID and requires regenerating the committed ID and on-chain configuration together.

`./run-host -- --print-image-id` is a local inspection mode: it prints one lowercase hex digest and
exits without requiring `RPC_URL`, a bridge address, or a deposit ID.

`--prove` produces a Groth16 `Receipt`, verifies it locally against the pinned image id, and
`encode_seal`s it. The emitted `seal` + `journal` are exactly the two arguments Stellar
`shield_from_base(seal, journal)` consumes (the contract computes the sha256 journal digest itself).
The seal format is identical to what the Boundless marketplace returns and what the Nethermind
verifier router accepts.

Local Groth16 proving needs the RISC Zero prover stack (`r0vm` / Docker on Apple Silicon, or
`RISC0_PROVER=bonsai`). The executor-only mode and the live preflight (RPC → block → event query)
run without it.

### Boundless (production proving)

Rather than proving locally, submit the guest + input to the Boundless marketplace and use the
returned `fulfillment.seal` / `journal` unchanged (same router-compatible format). The flow mirrors
`boundless/examples/counter/apps/src/main.rs`: build a `boundless_market::Client`, `new_request()
.with_program(BRIDGE_GUEST_ELF).with_stdin(<the same input the host writes>)`, `submit`,
`wait_for_request_fulfillment`, then feed `seal`/`journal` to `shield_from_base`. This is the path
the backend orchestrator (WS6-backend) will drive; it needs a funded Boundless account, an RPC, and
a program/input storage uploader, so it is not wired into this CLI.

## Base Sepolia chain spec

Host and guest build an identical `ChainSpec::new_single(84532, SpecId::PRAGUE)` so the committed
`configID` matches. If live proving rejects Base (OP-stack) headers under the Ethereum header type or
the chosen fork, revisit the `SpecId` / chain spec here — flagged for WS8 live verification.
