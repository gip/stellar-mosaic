# Stellar Mosaic

In the context of a hackathon, the goal is to explore the Stellar blockchain, specifically smart contracts and the new ZK features.

Because AI is heavily involved in this project, the implementation goals must be clear and well-defined in writing — a written spec has been the primary input. Opus 4.8 was used for orchestration and documentation, cheaper models for coding.

## What we are building

Stellar Mosaic is a privacy-preserving OTC desk on Stellar. It is owner-anonymous and amount-transparent: who is behind a trade stays confidential, while the assets and amounts settling on-chain are public.

Mosaic is non-custodial by design: users keep control of their assets at all times. Assuming the contracts are bug-free and users do not lose their notes, no loss of funds can occur.

Mosaic implements a UTXO-style model for assets and orders. Proving is done locally in the browser or in the backend depending on the trust model. UltraHonk proofs are verified onchain to establish each trade's validity.

Mosaic is multichain: while most of a desk's features are on Stellar, assets can also be traded via a bridge from another chain. Base is the first supported chain, and the proof of funds is generated using a version of [Steel](https://github.com/boundless-xyz/steel). The Groth16 proof is verified onchain on Stellar.

Finally, care has been taken to structure the code so that Mosaic's capabilities are easy to integrate into apps and agents. Most of the business logic, including the contracts, lives in the `mosaic SDK` package. Agents can even agree to create their own contracts for swapping or trading assets!

> 📊 For an interactive overview of how these pieces fit together, see the [trust-model & architecture overview](https://stellar-mosaic.vercel.app/overview).

## What has been delivered

| Feature | Description |
|---------|-------------|
| Mosaic SDK | A TypeScript SDK (`@mosaic/sdk`) that packages the contract bindings and desk business logic, so apps and agents can shield, order, and settle against a Mosaic desk without re-implementing the protocol. |
| Trustless Mode | Fully self-custodial flow in which the user generates their own UltraHonk order proofs in the browser. No third party ever learns the owner behind a note or handles the user's keys. |
| Trusted Mode using MCP | An MCP server that hosts the desk registry, order queues, relayer, and encrypted wallet backups, and drives proving and settlement on the user's behalf — trading some privacy for a smoother, agent-friendly experience. |
| Cross-chain asset shielding | A Base → Stellar bridge: funds are locked on Base, the deposit is proven with RISC Zero / Steel, the Groth16 seal is verified onchain, and a shielded note is minted on Stellar. |
| Local proving | In-browser UltraHonk proof generation (`@noir-lang/noir_js` + `@aztec/bb.js`), so order proofs never leave the user's device. |
| Benchmarks | Measured proving and settlement costs against Stellar's 400M-instruction per-tx budget — one UltraHonk verify ≈ 80M, an atomic two-sided `settle` ≈ 230M — with the full provenance behind the verifier choice ([benchmarks.md](docs/benchmarks.md)). |

## What's not there

| Feature | Description |
|---------|-------------|
| Unshield to Base | Withdrawing a note back out to Base is not supported: the peg is one-way (Base → Stellar shield only), so notes bridged in from Base are trade-only on Stellar. |
| Liquidity management between Stellar and Base | Managing liquidity across the two chains — there is no mechanism to rebalance or move liquidity between Stellar and Base. |
| Permissioned contracts | Access control on desks: today any address can interact with a deployed contract. Needed for KYC'd / permissioned desks (see WS5.2). |
| Boundless integration | Move proof generation onto the Boundless proving market rather than a self-hosted prover, for decentralized, on-demand proving of Base deposits. |
| Order book in a Merkle tree | Replace the simple onchain order book with a commitment-tree book where matching and proving happen offchain in Noir and only verification is onchain (WS4). |
| More robust MCP backend | Reimplement the MCP server's stateful services (desk registry, queues, relayer, Base-shield worker) in Rust for a more production-grade backend. |

## Trying it out

At the time of writing you can try the hosted demo at [https://stellar-mosaic.vercel.app/](https://stellar-mosaic.vercel.app/). You will need a wallet (e.g. Freighter) funded with XLM on the Stellar testnet.

A few caveats:

- **Trustless mode** should always work, since proving runs entirely in your browser.
- **Trusted mode (MCP)** depends on the backend being up, so it may occasionally be down.
- **Shield from Base** depends on the prover being available and unpaid — and because proving currently takes 30 minutes or more (until Boundless is integrated), it can take a while.

To run things locally, the fastest check is the settlement contract's integration suite, which exercises the full shield → settle → unshield loop against the real verifier with no testnet required:

```bash
cd contracts/settlement
cargo test --test integration
```

For a full end-to-end run on testnet (Stellar and Base legs), use the stateful driver. Invoked with no arguments it prints a status report of what is set up, ready, or blocked:

```bash
./scripts/e2e.sh          # status: inspect tools, env, and state
./scripts/e2e.sh all      # run the Stellar leg, then the Base leg
```

The e2e driver needs the Noir/`bb`, Soroban, and (for the Base leg) Foundry toolchains, a funded testnet identity, and an `eth_getProof`-capable Base RPC. See [docs/e2e-testing.md](docs/e2e-testing.md) for the full setup.

## Implementation

This section outlines the implementation plan, organized as workstreams (WS). It is background on how the project is structured and sequenced. Feel free to skip and go try the product.

- **WS1** designs and implements a simple desk on Stellar where users can shield assets and trade.
- **WS2** goes multichain: supporting shielded assets on Base and swapping them to Stellar.
- **WS3** delivers a great UI/UX experience.
- **WS4** moves from a simple onchain order book to a more advanced offchain book, where trade matching happens in Noir and is verified onchain.
- **WS5** is a moonshot: exploring offchain order-book matching in a decentralized manner, which would achieve a fully trustless solution — though that is likely impossible in the short term, if at all.

## Workstreams

**Status legend:** ⬜ not started · 🟡 in progress · 🟢 done · 🔴 impossible / not pursued for now

### WS0 — AI loop & foundations

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS0.0 | Set up the AI loop | Opus 4.8 for orchestration, smaller models for coding | 🟢 |
| WS0.1 | Create a knowledge base for AI | Stellar skills, own ZK skills, Ethereum | 🟢 |
| WS0.2 | Simple smart contract | Deploy a simple smart contract to test Stellar | 🟢 |

### WS1 — Simple Stellar OTC built on private notes

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS1.0 | High-level architecture | Specify the overall desk architecture and components — [architecture.md](docs/architecture.md) | 🟢 |
| WS1.1 | Private note design | Define the private-note scheme underpinning shielded balances — [note-types.md](docs/note-types.md), [privacy-model.md](docs/privacy-model.md) | 🟢 |
| WS1.2 | Ability to shield USDC or XLM | Enable users to shield USDC or XLM into private notes — [implementation.md](docs/implementation.md) | 🟢 |
| WS1.3 | Sponsored transactions | Support sponsored (fee-paid) transactions for smoother UX — [implementation.md](docs/implementation.md) | 🟢 |
| WS1.4 | Simple UX/UI | Build a minimal interface for shielding and trading — [ui-ux.md](docs/ui-ux.md) | 🟢 |
| WS1.5 | Benchmark | Measure performance / proving costs of the desk — [benchmarks.md](docs/benchmarks.md) | 🟢 |

### WS2 — Going multichain (Base → Stellar)

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS2.0 | Design document | Base → Stellar shield bridge design and trust model — [base-bridge.md](docs/base-bridge.md) | 🟢 |
| WS2.1 | Base bridge contract | `MosaicBridge.sol`: lock USDC on Base and emit a `Shielded` event matching the Stellar note | 🟢 |
| WS2.2 | ZK deposit proof | RISC Zero / Steel guest + host proving the Base deposit via an OP-stack state proof (`eth_getProof`) | 🟢 |
| WS2.3 | On-chain verify + mint | Groth16 router verify + `shield_from_base` on Stellar, with the block-hash registry and deposit-id replay guard — [benchmarks.md](docs/benchmarks.md) | 🟢 |
| WS2.4 | Orchestration, recovery & UI | Durable backend Base-shield worker, indexer making bridged notes discoverable/spendable, "Shield from Base" frontend tab | 🟢 |
| WS2.5 | E2E functional test | Shield funds on Base and swap to Stellar, end to end — validated live on testnet | 🟢 |
| WS2.6 | Deploy contract to Base | Ability to deploy the contract to the Base during desk creation | 🟢 |
| WS2.7 | Hosted proving service | Build and deploy a standalone proving server (Base deposit → Groth16 seal) reachable over HTTP, decoupled from the backend | ⬜ |

### WS3 — UI/UX

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS3.0 | Design document | UI/UX principles, information architecture, and planned refinements — [ui-ux.md](docs/ui-ux.md) | 🟢 |
| WS3.1 | Great UI/UX experience | Deliver a polished, intuitive trading experience | 🟡 |

### WS4 — Order book matching in Noir

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS4.0 | Design document | Off-chain matching-in-Noir + tree-backed orders/nullifiers design — [noir-matching.md](docs/noir-matching.md) | 🟡 |
| WS4.1 | Orders & nullifiers in a merkle tree | Replace the per-key nullifier set with an indexed-merkle-tree accumulator (non-membership proven in-circuit) and move the order book into a commitment tree — [noir-matching.md](docs/noir-matching.md) | ⬜ |
| WS4.2 | Offchain order book with onchain verification | Move from a simple onchain order book to an offchain book where trade matching runs in Noir and is verified onchain — [noir-matching.md](docs/noir-matching.md) | ⬜ |

### WS5 — Shared merkle tree for Stellar ⇄ Base

| ID | Title | Description | Status |
|------|-------|-------------|:------:|
| WS5.0 | Design document | Shared cross-chain note tree + KYC/permissioned desk design — [shared-merkle-tree.md](docs/shared-merkle-tree.md) | 🟡 |
| WS5.1 | Shared merkle tree feasibility | Explore the feasibility of sharing the note merkle tree between Stellar and Base — [shared-merkle-tree.md](docs/shared-merkle-tree.md) | ⬜ |
| WS5.2 | KYC / permissioned desk | Investigate a KYC'd / permissioned desk variant — [shared-merkle-tree.md](docs/shared-merkle-tree.md) | ⬜ |

## Non-goals

- Hardening
- Connection to Boundless
- Contract auditing
