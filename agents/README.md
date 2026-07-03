# @mosaic/agents — autonomous agent-to-agent trading demo

Two autonomous AI agents — **alice** (holds XLM) and **bob** (holds USDC) — each run as a Claude
Agent SDK subagent with exactly two capabilities, exposed as in-process MCP tools:

1. **XMTP** (`@xmtp/node-sdk`, dev network) — messaging with the other agent. Each agent has an
   Ethereum key and knows only the counterparty's Ethereum address.
2. **Mosaic** (`@mosaic/sdk`) — create/register a desk, shield, place private orders, and unshield
   on Stellar testnet. Proving (UltraHonk via bb.js WASM) runs fully in-process.

Each subagent is handed a one-line trading mandate:

- alice: *"Today spot price for XLM/USDC is 0.18. Sell 10 XLM and get me USDC at the best price."*
- bob: *"Today spot price for XLM/USDC is 0.18. Sell about 2 USDC and get me the best price in XLM."*

They negotiate terms over XMTP, alice deploys a fresh desk (settlement contract) and shares its
config, both shield exactly their side of the trade, place exactly-mirrored orders on the on-chain
book (the second order settles the trade atomically in one transaction), then each unshields its
proceeds to its own public account.

## Prerequisites

- Node ≥ 22 (XMTP native bindings + `node:sqlite`)
- `pnpm install && pnpm -r build` at the repo root
- `ANTHROPIC_API_KEY` in the environment (or ambient Claude Code credentials)

## Run

```bash
pnpm --filter @mosaic/agents setup   # provision demo identities (see below)
ANTHROPIC_API_KEY=… pnpm --filter @mosaic/agents demo
```

`demo` snapshots both wallets on Horizon, runs both agents concurrently with `[alice]`/`[bob]`
prefixed logs, and prints an independent **PASS/FAIL** verdict from the balance deltas (alice
gained USDC, bob gained XLM). For debugging, run one side at a time with `demo:alice` / `demo:bob`
in two terminals.

## Identities

The demo's contract is that each agent is *given* funded identities via `.demo/<name>.env`:

```
STELLAR_SECRET=S…        # funded testnet account (alice: XLM; bob: holds USDC too)
ETH_KEY=0x…              # XMTP identity
XMTP_DB_KEY=0x…          # 32-byte hex, encrypts the local XMTP db
PEER_ETH_ADDRESS=0x…     # the other agent's ethereum address
USDC_ISSUER=G…           # issuer of the demo USDC classic asset
```

`pnpm setup` provisions all of this: friendbot-funds alice/bob/issuer, sets USDC trustlines for
**both** agents (alice needs one to receive her unshielded USDC), pays bob 100 demo USDC, deploys
the USDC Stellar Asset Contract (the SDK's RPC deployer resolves but never deploys SACs), and
generates the eth/XMTP keys. Supply your own env files instead if you have accounts — the same
trustline/SAC preconditions apply. `AGENT_MODEL` overrides the model (default `claude-opus-4-8`).

## Notes

- Order/unshield proofs take **1–5 minutes each** in Node WASM; a full run is typically 10–20
  minutes and two concurrent agents' API usage.
- `scripts/fix-xmtp.mjs` (run automatically before setup/demo) patches the published
  `@xmtp/node-bindings` darwin binary, which hardcodes a nonexistent nix libiconv path.
- Everything mutable lives in `.demo/` (gitignored): env files, note SQLite dbs, XMTP dbs. Re-run
  `setup` for a fresh cast of identities; it wipes the stale databases.
