# @mosaic/agents — autonomous agent-to-agent trading experiments

An experiment runner for **N ≥ 2 autonomous LLM trading agents**. Each agent runs as its own
process with exactly two capabilities, exposed as tools to a provider-neutral
[Vercel AI SDK](https://ai-sdk.dev) loop — so each agent can independently be an **Anthropic** or
**OpenAI** model:

1. **XMTP** (`@xmtp/node-sdk`, dev network) — messaging with the other agents (one DM per peer).
   Each agent has an Ethereum key and knows only its peers' names + Ethereum addresses.
2. **Mosaic** (`@mosaic/sdk`) — create/register a desk, shield, place/cancel private orders, and
   unshield on Stellar testnet. Proving (UltraHonk via bb.js WASM) runs fully in-process.

Agents negotiate terms over XMTP, the designated desk creator deploys a fresh desk (settlement
contract) and shares its config, both sides of a trade shield exactly their side, place
exactly-mirrored orders on the on-chain book (the second order settles the trade atomically in one
transaction), then each unshields its proceeds to its own public account. See `docs/agents.md` for
an annotated real session.

## Prerequisites

- Node ≥ 22 (XMTP native bindings + `node:sqlite`)
- `pnpm install && pnpm -r build` at the repo root
- An API key per provider used: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`

## Run

One YAML/JSON config file per experiment; one result file per run:

```bash
ANTHROPIC_API_KEY=… pnpm --filter @mosaic/agents demo          # = experiment experiments/demo.yaml
pnpm --filter @mosaic/agents experiment <config.yaml>          # any experiment
pnpm --filter @mosaic/agents experiment <config.yaml> --check  # preflight/provision only, no agents
```

The runner validates the config and **provisions whatever it omits** before any agent starts
(fail-fast preflight): missing Stellar keys are generated and funded via friendbot, missing
Ethereum keys are generated, a per-run demo-USDC issuer is created (trustlines for every agent,
configured starting inventories paid out, SAC deployed), and every agent's API key + model id is
verified with a one-token ping. It then spawns the agents with `[name]`-prefixed logs, and finally
verdicts the run **independently** from Horizon balance deltas — nothing the agents report is
trusted. `--skip-llm-check` skips the ping.

- Results: `results/<experiment>-<runId>.json` — per-agent exit codes, token usage, balance
  deltas, verdict rule evaluation, PASS/FAIL.
- Run state: `.experiments/<experiment>/<runId>/` — identities (incl. generated secrets, 0600, so
  testnet funds are recoverable), per-agent transcripts, note/XMTP DBs, `run.log`.

## Experiment config

```yaml
name: cross-provider
maxTurns: 80                       # optional, per agent
timeoutMinutes: 45                 # optional wall-clock cap; stragglers are SIGTERMed (they flush
                                   #   their transcript) and the run FAILs, results still written
network: { rpcUrl: …, horizonUrl: … }   # optional, defaults to Stellar testnet
agents:                            # 2 or more
  - name: alice
    provider: anthropic            # anthropic | openai — per agent
    apiKey: ${ANTHROPIC_API_KEY}   # optional; defaults to the provider's env var. ${VAR} is
    model: claude-opus-4-8         #   interpolated from the environment — keys never in the file.
    role: desk_creator             # exactly one agent deploys the desk (default: first agent)
    prompt: "Today spot price for XLM/USDC is 0.18. Sell 10 XLM at the best price."
    stellarSecret: S…              # optional — generated + friendbot-funded if omitted
    ethKey: 0x…                    # optional — generated if omitted
  - name: bob
    provider: openai
    model: gpt-5.2
    prompt: "Spot is 0.18. Buy XLM with up to 2 USDC."
    funding: { usdc: "100" }       # starting demo-USDC inventory, issued at provision time
verdict:                           # optional balance-delta rules; omit to just report deltas
  - { agent: alice, asset: USDC, min: "1.5" }
  - { agent: bob, asset: XLM, min: "9" }
```

Examples: `experiments/demo.yaml` (two Anthropic agents), `experiments/cross-provider.yaml`
(Anthropic vs OpenAI), `experiments/three-way.yaml` (3 agents, competing sellers — a template to
tune, multi-party negotiation quality varies).

## Notes

- Order/unshield proofs take **1–5 minutes each** in Node WASM; a two-agent run is typically
  10–20 minutes plus each agent's API usage.
- The desk's asset/pair set is fixed: asset 1 = XLM (base), asset 2 = USDC (quote, demo asset
  issued per run), pair 0 = XLM/USDC.
- Supplied Stellar accounts must exist on the configured network (unfunded ones are
  friendbot-funded); every agent gets a USDC trustline at provision time (anyone may receive
  unshielded USDC).
- `scripts/fix-xmtp.mjs` (run automatically) patches the published `@xmtp/node-bindings` darwin
  binary, which hardcodes a nonexistent nix libiconv path.
