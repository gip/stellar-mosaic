# Stellar Mosaic

In the context of a hackathon, the goal is to explore the Stellar blockchain, specifically smart contracts and the new ZK features.

As AI will be heavily involved in this project, it is important to make sure the implementation goals are clear and well-defined in writing — that will be an input. Opus 4.8 was used for orchestration and documentation, cheaper models for coding.

## What are we building

Mosaic wants to give users better opportunities to trade onchain. Today users can pick from a DEX, a CEX, or OTC desks (like Binance, Coinbase, etc.) if they want some privacy. Trustless OTC trading that ensures privacy while making sure funds may not be lost even when shielded is an exciting opportunity and what we'd like to build on Mosaic. 

The goal in WS1 is to design and implement a simplistic desk on Stellar where users may shield assets and trade. WS2 is about going multichain and supporting shielded assets on Base and swapping to Stellar. WS3 is about a great UI/UX experience. WS4 is trying to move from a simplistic onchain order book to a more advanced offchain order book where trade matching happens in Noir and is verified onchain. WS5 is a moonshot to explore offchain order book matching in a decentralized manner, as that would achieve a fully trustless solution — but it is probably impossible to achieve in the short term, or at all.

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
| WS4.0 | Design document | Off-chain matching-in-Noir + tree-backed orders/nullifiers design — [noir-matching.md](docs/noir-matching.md) | 🟢 |
| WS4.1 | Orders & nullifiers in a merkle tree | Replace the per-key nullifier set with an indexed-merkle-tree accumulator (non-membership proven in-circuit) and move the order book into a commitment tree — [noir-matching.md](docs/noir-matching.md) | 🟢 |
| WS4.2 | Offchain order book with onchain verification | Move from a simple onchain order book to an offchain book where trade matching runs in Noir and is verified onchain — [noir-matching.md](docs/noir-matching.md) | 🟢 |

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
