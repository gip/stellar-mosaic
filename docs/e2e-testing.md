# End-to-end testnet testing

This is the operator's guide for running Stellar Mosaic end to end on **testnets** — compiling,
deploying the contracts on Stellar (and Base), and shielding assets from both chains. It is driven by
one stateful helper, `scripts/e2e.sh`, that wraps the existing demo scripts and remembers what they
produced so you always know what is deployed and what to run next.

## TL;DR

```bash
./scripts/e2e.sh status     # what's ready, what's blocked (and why), what's been generated
./scripts/e2e.sh stellar    # Stellar leg: deploy + shield → place → settle_match → unshield  (needs stellar CLI + nargo/bb)
./scripts/e2e.sh base       # Base leg: shield USDC on Base Sepolia → mint the note on Stellar
./scripts/e2e.sh all        # both legs in sequence, then the combined summary
./scripts/e2e.sh show       # everything generated so far (contracts, addresses) + explorer links
./scripts/e2e.sh summary    # re-print the per-stage tables from the last run(s)
./scripts/e2e.sh reset      # clean slate: force-recompile everything + drop state (see below)
./scripts/e2e.sh clean      # forget persisted state (committed fixtures untouched)
```

Always start with `status`. It is read-only and tells you exactly which leg you can run right now.

## The two legs

The driver does not replace the demo scripts — it orchestrates them and persists their outputs:

| Leg | Script wrapped | What it proves | Hard requirements |
|---|---|---|---|
| **Stellar** | `scripts/04_demo_e2e_testnet.sh` | deploy settlement → `shield` → `place_order` ×2 → `settle_match` → `unshield` the proceeds, all as real testnet txs; asserts the nullifier-accumulator root advances and a replayed `settle_match` reverts | `stellar` CLI + funded testnet identity (auto-created/funded) + the nargo/bb toolchain (proofs are generated at run time against the live clock) |
| **Base** | `scripts/10_demo_base_shield_testnet.sh` | deploy `MosaicBridge` on Base Sepolia → `shield` USDC → RISC Zero/Steel proof → `shield_from_base` mints the note on Stellar (tree root advances) | foundry, a funded Base key, a `getProof` RPC, the RISC Zero prover stack, the deployed verifier router |

The two legs deploy **separate** settlement contracts (the existing scripts each deploy their own).
That is intentional — each leg is independently runnable and the driver records both.

## Inputs

The only inputs you must supply are the credentials for the chains you spend on. Everything else has a
working default.

| Variable | Leg | Required? | Notes |
|---|---|---|---|
| `IDENTITY` | Stellar | optional | Stellar CLI identity name (default `m0`). If it doesn't exist it is **created and funded via friendbot** automatically. |
| `PRIVATE_KEY` | Base | **required** | A Base Sepolia key with some ETH for gas. The script deploys its own MockUSDC and mints, so you do **not** need USDC — only gas. |
| `BASE_RPC` | Base | **required** | Must serve `eth_getProof` — set it yourself, like `PRIVATE_KEY`. There is **no default** (the public `https://sepolia.base.org` does not serve `eth_getProof`). Use an Alchemy/Infura Base Sepolia URL, e.g. `https://base-sepolia.g.alchemy.com/v2/<key>`. |
| `ROUTER_ID` | Base | defaulted | The Nethermind RISC Zero verifier router already deployed on Stellar testnet. Pre-set in the driver to the live address; override only if you redeploy it. |
| `NETWORK` | both | defaulted | `testnet`. |

Example:

```bash
export PRIVATE_KEY=0x<funded base sepolia key>
export BASE_RPC=https://base-sepolia.g.alchemy.com/v2/<key>
./scripts/e2e.sh status
./scripts/e2e.sh all
```

> The Stellar leg **needs the Noir/bb toolchain** (`nargo` 1.0.0-beta.9, `bb` v0.87.0): WS4 binds the
> live ledger clock (placement TTL + the match's 300s `now` skew), so the leg generates proofs at run
> time against the current clock into a temp dir (the committed `tests/fixtures/ws4/` set is never
> touched). The committed VKs are reused as-is.

## Per-stage tables and the summary

As each leg runs it prints a small **table after every stage** (context, deploy, setup, shield, place,
settle_match, stale-root, unshield for Stellar; context, deploy, shield, prove, configure,
shield_from_base for Base) listing the addresses, contracts, transactions, roots, and CPU costs that
stage produced:

```
  ┌─ Stellar · deploy
  │ settlement contract    CD…ABC
  │ admin                  GA…9
  │ explorer               https://stellar.expert/explorer/testnet/contract/CD…ABC
  └──────────────────────────────────────────────────────
```

At the end of a run, a **combined summary** re-prints every stage's table in one place
(`════ E2E SUMMARY ════`). `./scripts/e2e.sh all` prints the summary across both legs; each leg also
prints its own summary when it finishes. You can re-print it any time with `./scripts/e2e.sh summary`
(add a leg name — `summary Stellar` / `summary Base` — to filter). The rows are stored in
`.e2e/runlog.tsv`, so the summary survives across terminals and re-runs (a re-run of a leg replaces
that leg's section).

## What gets persisted, and where

Once a leg runs, the addresses/contracts it created are written to **`<repo>/.e2e/state.env`**
(gitignored) as simple `KEY=VALUE` lines. This is what makes the driver stateful: `status` and `show`
read it back, so after closing your terminal you can still see what is deployed.

`./scripts/e2e.sh show` prints it with explorer links. Keys include:

- Stellar leg: `STELLAR_IDENTITY`, `STELLAR_ADDR`, `SETTLEMENT_CID`, `XLM_SAC`, `STELLAR_ROOT`, `STELLAR_LAST_RUN`
- Base leg: `BASE_DEPOSITOR`, `BASE_USDC`, `BASE_BRIDGE`, `BASE_DEPOSIT_BLOCK`, `ROUTER_ID`, `BASE_SETTLEMENT_CID`, `BASE_ROOT_AFTER`, `BASE_LAST_RUN`

The persistence is implemented by `scripts/lib/e2e_state.sh` (sourced by both demo scripts). Running
`04`/`10` directly still works and still records state — the driver just adds the status/show/run UX
on top.

Each run **deploys fresh** contracts (the demo scripts always redeploy); the state file reflects the
most recent run. To start clean, `./scripts/e2e.sh clean` removes `.e2e/` (it never touches the
committed fixtures).

## Regenerating everything from scratch

The demo scripts already redeploy fresh on every run — each `stellar`/`base` deploys a **new** Stellar
settlement contract, and `base` also deploys a **new** MockUSDC + MosaicBridge. What persists between
runs is only: cargo/forge build caches (so unchanged code isn't recompiled), the `m0` Stellar
identity (same address), and `.e2e/` state. To force a true clean slate:

```bash
./scripts/e2e.sh reset                 # force-recompile everything + drop generated outputs & state
./scripts/e2e.sh reset --new-stellar   # ^ and ALSO rotate to a brand-new funded Stellar address
./scripts/e2e.sh all                   # then redeploy + run both legs from scratch
```

`reset` does:
- `cargo clean -p settlement` and `cargo clean -p host -p bridge-methods` (forces the Soroban wasm and
  the risc0 host+guest to fully recompile; dependency caches are kept so it isn't a 20-min rebuild),
  `forge clean` (EVM), and removes `bridge-prover/out`, `artifacts/*`, `circuits/*/target`;
- clears `.e2e/` (state + run log);
- with `--new-stellar`, generates and friendbot-funds a **fresh** identity (`e2e-<timestamp>`), leaves
  your existing `m0` keys untouched, and persists it so subsequent `stellar`/`base` runs use that new
  address (visible in `status`).

The next `stellar`/`base` then recompiles and deploys brand-new contracts on both chains. The Base
guest image ID is deterministic from source, so a clean rebuild reproduces the same pinned ID (no
re-pinning needed).

## Regenerating fixtures

The Stellar leg generates its proofs at run time, so you don't normally regenerate anything. The
committed `tests/fixtures/ws4/` set (used by the contract tests) is rebuilt with:

```bash
./scripts/e2e.sh regen       # wraps scripts/05_gen_book_fixtures.sh -> tests/fixtures/ws4/regen.py
```

This needs the pinned Noir/bb toolchain (`nargo` 1.0.0-beta.9, `bb` v0.87.0 — see `CLAUDE.md`).

## How the Base leg works (and why it's slow)

`shield_from_base` verifies a RISC Zero/Steel Groth16 proof on Soroban that the Base deposit is in a
Base block, then mints the note. The script:

1. deploys MockUSDC + `MosaicBridge` on Base Sepolia, mints, and `shield`s;
2. proves the deposit **immediately** at its (recent, in-`getProof`-window) block;
3. **mints** — by default immediately (fast mode); with `WAIT_FINALITY=1`, first holds the proof
   until that block **finalizes** on Base (~10–15 min — a pure block-number check, no archive RPC);
4. deploys + configures settlement on Stellar, `attest_base_block`s the proven block's hash, and
   calls `shield_from_base`, asserting the tree root advanced.

The Groth16 wrap runs locally via Docker (~4.5 min) — that's why `docker` is a prerequisite (or set
`RISC0_PROVER=bonsai`).

The Base script invokes `bridge-prover/run-host`, which builds the release host once and then runs
the cached binary while its content fingerprint remains current. Avoid replacing it with
`cargo run`: RISC Zero intentionally regenerates the embedded-methods output on every Cargo
invocation, which forces an otherwise unnecessary fat-LTO host relink. Use
`bridge-prover/run-host --force-rebuild -- <arguments>` to rebuild explicitly.

Before deploying, the script compares the cached host's embedded guest image ID with the reviewed
pin in `bridge-prover/image-id.hex`. This catches guest source, dependency, or toolchain drift before
the Groth16 proof. Inspect the built ID with:

```bash
bridge-prover/run-host -- --print-image-id
```

If they differ, use the printed `--force-rebuild` command once to rule out stale build artifacts.
If the rebuilt ID still differs, review the guest change and use the exact rotation command printed
by the preflight; do not update the pin merely to make the check pass. The same reviewed value is
supplied to `configure_base_bridge` on Stellar.

### Finality toggle

By **default the Base leg runs in fast mode**: it mints as soon as the proof is ready, against the
proven (not-yet-finalized) block. That's quick but reorg-risky, so it's demo-only — if the proven
block reorgs out before the relayer attests, the mint fails safely (`BaseBlockNotAttested`) and you
re-run. For the reorg-safe path, set `WAIT_FINALITY=1`, which holds the proof and waits ~10–15 min
for the block to finalize on Base before minting:

```bash
WAIT_FINALITY=1 ./scripts/e2e.sh base    # reorg-safe (slow)
./scripts/e2e.sh base                     # fast (default)
```

`status` shows which mode is active. (This replaces the old `UNSAFE_FAST` flag — fast is now the
default, and the wait is opt-in.)

The EVM contracts depend on OpenZeppelin + forge-std, vendored into `evm/lib/` (gitignored). The
driver **fetches the pinned versions automatically** the first time you run the Base leg (`status`
shows whether they're present); no manual `forge install` needed.

See `docs/base-bridge.md` for the full trust model and the journal contract.

## Troubleshooting

- **`status` shows the Base leg blocked on `PRIVATE_KEY`/`docker`/etc.** — set the listed item. The
  Stellar leg can still run independently.
- **Proving hangs after `execution time: …` with low CPU** — the STARK→Groth16 wrap shells out to
  Docker and prints nothing while it runs; a wedged Docker daemon makes it hang forever. The driver
  now pre-checks this (`status` shows "Docker daemon responding"); if it's stuck, `killall Docker &&
  open -a Docker`, wait until `docker info` returns, and re-run. Or offload proving with
  `RISC0_PROVER=bonsai` (no local Docker).
- **`block … not found` immediately after the Base deposit** — the bridge host retries this RPC
  visibility lag automatically up to five times at five-second intervals, before proving starts.
  A persistent failure means the RPC still cannot serve the selected block.
- **Other `eth_getProof` errors / empty proof** — your `BASE_RPC` doesn't serve state proofs; switch
  to Alchemy/Infura.
- **`BaseBlockNotAttested` from `shield_from_base`** — the proven block reorged out before finalizing.
  Just re-run `./scripts/e2e.sh base`.
- **Transient `502`/timeout from the Stellar public RPC** — the Base leg retries invokes 5×; for the
  Stellar leg, re-run.
- **Want to redeploy the verifier router** — see `docs/base-bridge.md` (it is normally already live on
  testnet; the driver defaults `ROUTER_ID` to it).
