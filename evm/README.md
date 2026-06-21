# evm — Base-side bridge (Workstream 1)

`MosaicBridge.sol` is the Base counterpart of Soroban `settlement.shield`. A user locks an ERC20
(USDC) and names an opaque `ownerTag`; the contract emits a `Shielded` event with exactly the data
needed to recreate the Stellar note `Poseidon(assetId, amount, ownerTag)`. A RISC Zero / Boundless
(Steel) proof later attests this event and the Stellar settlement contract mints the note. Plan:
[`../docs/base-bridge.md`] / the Base-shield phase in the repo `README.md`.

This phase is a **one-way peg**: tokens lock here; the Stellar note is treated as fungible with
native Stellar USDC. No withdraw-back-to-Base path yet.

## The `Shielded` event — the cross-chain contract

```solidity
event Shielded(
    uint64  indexed depositId,  // monotonic; the single-use replay key consumed on Stellar
    uint32  indexed assetId,    // == Stellar register_asset id (USDC == USDC by assumption)
    uint256         amount,     // amount ACTUALLY received (delta-measured); fits Stellar i128
    bytes32         ownerTag,   // BN254 Fr element (< r); Poseidon(pk_o, rho), chosen client-side
    address         token,      // ERC20 locked (informational / indexing)
    address         from        // depositor (informational / indexing)
);
```

The note minted on Stellar is `leaf = Poseidon(assetId, amount, ownerTag)`, byte-identical to a
native `shield` leaf (Soroban `asset_note_leaf(asset_id: u32, amount: i128, owner_tag: BytesN<32>)`),
so the indexer, order book, `settle`, and `unshield` are unchanged.

- **WS2 (guest/journal)** must commit at least `(chainId, bridgeAddress, depositId, assetId, amount,
  ownerTag)`. `chainId` + `bridgeAddress` scope the `depositId` so it is globally unique; Steel binds
  the event to a Base block whose hash the Stellar registry attests.
- **WS4 (Stellar `shield_from_base`)** parses the journal, checks the block commitment, guards the
  `depositId` replay set, and inserts the leaf.

Validation enforced on Base (fail-fast, mirrors Stellar's constraints):
`assetId` registered · `0 < amount ≤ i128::MAX` · `ownerTag < BN254_SCALAR_FIELD` · received amount
(post-transfer delta) re-checked, so fee-on-transfer/rebasing tokens can't over-mint.

## Develop

Vendored deps (`lib/`) are gitignored; fetch the pinned versions once:

```bash
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts && rm -rf lib/openzeppelin-contracts/.git
git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std        lib/forge-std        && rm -rf lib/forge-std/.git
```

```bash
forge build
forge test -vv            # 14 tests
```

## Deploy (Base Sepolia)

```bash
export PRIVATE_KEY=0x...                 # deployer = admin
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export BASESCAN_API_KEY=...              # for --verify
# USDC_ADDRESS defaults to Circle's Base Sepolia USDC; USDC_ASSET_ID defaults to 1
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```

Record the deployed `MosaicBridge` address + `assetId` — WS4 pins them, and WS2's journal binds the
address + chain id.
