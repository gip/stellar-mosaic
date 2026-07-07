# @mosaic/agents — autonomous agent-to-agent trading experiments

An experiment runner for **N ≥ 2 autonomous LLM trading agents**. Each agent runs as its own
process with exactly two capabilities, exposed as tools to a provider-neutral
[Vercel AI SDK](https://ai-sdk.dev) loop — so each agent can independently be an **Anthropic** or
**OpenAI** model:

1. **XMTP** (`@xmtp/node-sdk`, dev network) — messaging with the other agents (one DM per peer).
   Each agent has an Ethereum key and knows only its peers' names + Ethereum addresses.
2. **Mosaic** (`@mosaic/sdk`) — create/register a desk, shield, place/cancel private orders, and
   unshield on Stellar testnet. Proving (UltraHonk via bb.js WASM) runs fully in-process.

Agents negotiate terms over XMTP — including **who deploys the desk** (the settlement contract);
there are no assigned roles. The agreed creator deploys it and shares its config, both sides of a
trade shield exactly their side, place exactly-mirrored orders on the on-chain book (the second
order settles the trade atomically in one transaction), then each unshields its proceeds to its
own public account. See `docs/agents.md` for an annotated real session.

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
Ethereum keys are generated, every declared asset is set up (demo assets issued by a per-run
issuer with configured inventories minted, external assets verified on-network, trustlines for
every agent, SACs deployed), and every agent's API key + model id is verified with a one-token
ping. It then spawns the agents with `[name]`-prefixed logs, and finally
verdicts the run **independently** from Horizon balance deltas — nothing the agents report is
trusted. `--skip-llm-check` skips the ping.

- Results: `results/<experiment>-<runId>.json` — per-agent exit codes, token usage, balance
  deltas, verdict rule evaluation, PASS/FAIL.
- Transcript: `results/<experiment>-<runId>.html` — a self-contained human-readable transcript
  (per-agent colors, chat-style dialogue, tool-call JSON collapsed by default), auto-generated
  next to the results JSON. Re-render old runs with
  `pnpm --filter @mosaic/agents render results/<file>.json` (or pass a bare run dir — e.g. a
  crashed run with no results file — to get `<runDir>/transcript.html`). Runs recorded before
  per-step timestamps existed are interleaved by XMTP message causality instead of clock order.
- Run state: `.experiments/<experiment>/<runId>/` — identities (incl. generated secrets, 0600, so
  testnet funds are recoverable), per-agent transcripts, note/XMTP DBs, `run.log`.

## Experiment config

```yaml
name: cross-provider
maxTurns: 80                       # optional, per agent
timeoutMinutes: 45                 # optional wall-clock cap; stragglers are SIGTERMed (they flush
                                   #   their transcript) and the run FAILs, results still written
network: { rpcUrl: …, horizonUrl: … }   # optional, defaults to Stellar testnet
assets:                            # optional — the desk's asset set (desk asset ids follow
  - symbol: XLM                    #   declaration order, starting at 1). "XLM" = the native
  - symbol: EURC                   #   lumen. Any other symbol without an issuer is demo-issued
  - symbol: USDC                   #   per run; with `issuer` it is an existing on-network asset
    issuer: G…                     #   (see "Real on-network assets"). Default: XLM + demo USDC.
pairs:                             # optional — canonical base/quote orientation. Required for
  - { base: XLM, quote: USDC }     #   3+ assets; defaults to assets[0]/assets[1] for exactly 2.
  - { base: EURC, quote: USDC }
agents:                            # 2 or more
  - name: alice
    provider: anthropic            # anthropic | openai — per agent
    apiKey: ${ANTHROPIC_API_KEY}   # optional; defaults to the provider's env var. ${VAR} is
    model: claude-opus-4-8         #   interpolated from the environment — keys never in the file.
    prompt: "Today spot price for XLM/USDC is 0.18. Sell 10 XLM at the best price."
    stellarSecret: S…              # optional — generated + friendbot-funded if omitted
    ethKey: 0x…                    # optional — generated if omitted
  - name: bob
    provider: openai
    model: gpt-5.2
    prompt: "Spot is 0.18. Buy XLM with up to 2 USDC."
    funding: { USDC: "100" }       # starting inventory by symbol: minted for demo assets,
                                   #   min-balance preflight check for external ones
verdict:                           # optional balance-delta rules; omit to just report deltas
  - { agent: alice, asset: USDC, min: "1.5" }
  - { agent: bob, asset: XLM, min: "9" }
```

Examples: `experiments/demo.yaml` (two Anthropic agents), `experiments/cross-provider.yaml`
(Anthropic vs OpenAI), `experiments/three-way.yaml` (3 agents, competing sellers — a template to
tune, multi-party negotiation quality varies), `experiments/real-usdc.yaml` (real Circle testnet
USDC, supplied pre-funded accounts).

## Real on-network assets

By default each run issues throwaway demo assets. Give an asset an `issuer` to trade an existing
on-network asset instead — on testnet, Circle's USDC is
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. The provisioner cannot mint an
external asset, so:

- Agents that need inventory of it must bring a `stellarSecret` whose account **already holds it**
  (for Circle USDC: fund via the [Circle faucet](https://faucet.circle.com), network "Stellar
  Testnet"). That asset's `funding` entry then acts as a preflight minimum-balance check instead
  of a mint.
- Trustlines are still added automatically for agents missing one (needed to *receive* the
  asset), and the asset's SAC is resolved/deployed as usual (Circle's already exists).
- The verdict counts only lines from the configured issuers, so unrelated trustlines on your
  accounts don't leak into deltas.

## Notes

- Order/unshield proofs take **1–5 minutes each** in Node WASM; a two-agent run is typically
  10–20 minutes plus each agent's API usage.
- The desk's asset/pair set is fixed per experiment, from the config's `assets`/`pairs`
  (default: asset 1 = XLM, asset 2 = demo USDC, pair 0 = XLM/USDC). All assets are 7-decimal
  classic Stellar assets; pair orientation is canonical (declare `EURC/USDC`, never both ways).
- Supplied Stellar accounts must exist on the configured network (unfunded ones are
  friendbot-funded); every agent gets a trustline on every classic asset at provision time
  (anyone may receive unshielded funds).
- `scripts/fix-xmtp.mjs` (run automatically) patches the published `@xmtp/node-bindings` darwin
  binary, which hardcodes a nonexistent nix libiconv path.
