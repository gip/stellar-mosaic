# Agent-to-agent trading demo (`agents/`)

Two autonomous AI agents negotiate and settle a private XLM/USDC trade end to end, with no human
in the loop. Each agent is a Claude Agent SDK subagent whose entire world is two capabilities,
exposed as in-process MCP tools:

- **XMTP** (`@xmtp/node-sdk`, dev network) — messaging with the counterparty. Each agent holds an
  Ethereum key and knows only the *other agent's Ethereum address*.
- **Mosaic** (`@mosaic/sdk`) — create/register a desk, `shield`, place private orders on the
  on-chain book, and `unshield` on Stellar testnet. Order/unshield proofs (UltraHonk) are generated
  in-process via bb.js WASM.

Each subagent is handed a one-line mandate and left alone:

- **alice** (holds XLM): *"Today spot price for XLM/USDC is 0.18. Sell 10 XLM and get me USDC at
  the best price."*
- **bob** (holds USDC): *"Today spot price for XLM/USDC is 0.18. Sell about 2 USDC and get me the
  best price in XLM."*

See `agents/README.md` for setup/run instructions. Below is an annotated real session (Stellar
testnet, 2026-07-03; the whole run took **134 seconds** and both agents exited 0).

## Cast

| | Stellar account | Role |
|---|---|---|
| alice | `GCVKNSSGSSBNUGB7SO577AAGUPHAEL6BCM2E7LTTOKGTHPRWQG6WFCEQ` | XLM seller, desk creator, maker |
| bob | `GBFBNKPWLCHZJBNE5IV3JTAXUECTFXJE2YJFZDTLJYXNP45WWZBNAUWG` | USDC seller, taker |

Starting balances: alice 10 000 XLM / 0 USDC · bob 10 000 XLM / 100 USDC (demo USDC, issued at
setup). The desk deployed during the session: contract
`CAP2LA6RQOM2AEUIFK23DLB6XREOTDCOFJ7FCWMC7VKPT3CYUTYOOLPU`, assets `1 = XLM (native)`,
`2 = USDC (SAC)`, pair `0 = XLM/USDC`.

## Act 1 — negotiation (XMTP only, nothing on-chain)

The agents discover each other by Ethereum address on the XMTP dev network and haggle in plain
language:

> **alice:** Hi — I'm looking to sell 10 XLM for USDC. Spot is 0.18 USDC/XLM. I'd like 0.18. What can you do?
>
> **bob:** Hi — bob here. I have USDC, want XLM. Looking to buy ~2 USDC worth at spot 0.18. Clean fill: I pay 1.98 USDC for 11 XLM (exactly 0.18). You good to sell 11 XLM? You create the desk.
>
> **alice:** I'm capped at 10 XLM on my side. Let's do 10 XLM for 1.80 USDC, flat 0.18.
>
> **bob:** 10 XLM works for me. Can you do 0.178? That's 1.78 USDC for your 10 XLM.
>
> **alice:** Spot's 0.18, so 0.178 is under. Meet in the middle at 0.179 — 1.79 USDC for 10 XLM. Deal?
>
> **bob:** Deal — 10 XLM for 1.80 USDC at 0.18. Confirming terms: `{"type":"order_terms","xlm_amount":"100000000","usdc_amount":"18000000","price_usdc_per_xlm":"0.18"}`

Note the wrinkle: bob tried to shade the price to 0.178, alice countered 0.179, but their messages
crossed in flight and bob's confirmation echoed 0.18. Both agents spotted the mismatch and
resolved it rather than risk placing non-mirroring orders:

> **bob:** Our msgs crossed. You echoed usdc_amount 18000000 (0.18) but I'd offered 0.179 (17900000). Mirror must match exactly. I'm fine taking your 0.18 to keep it clean. LOCKING: `{"type":"order_terms","xlm_amount":"100000000","usdc_amount":"18000000",…}` Reply "LOCKED 18000000".

This matters because the settlement contract fills at exact integer ratios: the two orders must
mirror (`seller.amount_in == buyer.min_out` and `seller.min_out == buyer.amount_in`) for the trade
to fully cross. All protocol amounts are raw 7-decimal integers — 10 XLM = `100000000`,
1.80 USDC = `18000000`.

## Act 2 — the desk

Alice deploys a fresh settlement contract (`mosaic_create_desk` → the SDK's RPC deployer uploads
the wasm and invokes the constructor with the UltraHonk VKs and the immutable asset/pair set), then
sends bob the desk config verbatim over XMTP:

> **alice:** `{"type":"desk","config":{"id":"60e50f09-…","contractId":"CAP2LA6R…","assets":[{"asset_id":1,"symbol":"XLM","token":"native",…},{"asset_id":2,"symbol":"USDC","token":"USDC:GDRFK5QC…",…}],"pairs":[{"base_asset":1,"quote_asset":2,"pair_id":0}]}}`

Bob validates it is the expected XLM/USDC desk and registers it locally (`mosaic_register_desk`).
Both agents now watch the same contract's note-tree events and can independently rebuild Merkle
paths — there is no shared server.

## Act 3 — on-chain settlement

Six transactions, all on the one desk contract:

| # | tx (testnet) | who | contract call | what happens on-chain |
|---|---|---|---|---|
| 1 | `6b87b9ce…90adf4c6` | alice | `shield(asset 1, 100000000)` | 10 XLM move into contract custody; an owner-anonymous `AssetNote` leaf is appended to the depth-32 Merkle tree (`shielded` event). No proof needed — the token transfer itself authorizes the amount. |
| 2 | `9bc5fc12…67c63582` | alice | `submit_order(proof, public_inputs)` | Alice's UltraHonk **order proof** is verified (~80M instructions): it proves membership of her note in a published root and binds nullifier, `asset_in=XLM`, `amount_in=100000000`, `min_out=18000000`, her output owner tag, expiry and `partial_allowed=1`. Her nullifier is recorded (note spent), and the order **rests** on the book's sell side. `partial_allowed=true` is required here — a non-partial order that can't fill immediately is rejected fill-or-kill. |
| 3 | `4ea32e0e…0f3fd7ec` | bob | `shield(asset 2, 18000000)` | 1.80 USDC into custody; second note leaf appended. |
| 4 | `2a4dc080…e7eb0b61` | bob | `submit_order(proof, public_inputs)` | Bob's order proof is verified: `amount_in=18000000` USDC, `min_out=100000000` XLM, `partial_allowed=0` (fill-or-kill). The contract cross-checks the resting sell — the mirrored integer ratios cross exactly — records bob's nullifier, consumes alice's resting order entirely, and **atomically mints both proceeds notes** in the same transaction: 1.80 USDC to alice's bound owner tag, 10 XLM to bob's (`noteins` + `filled` events). Nobody could redirect the proceeds: the output owner tags were bound inside each order proof. |
| 5 | `6a27c9bc…ae9bc4fa` | alice | `unshield(proof, to=alice)` | Alice proves ownership of her USDC proceeds note; the proof **binds the recipient address**, the nullifier is recorded, and the contract pays 1.80 USDC (classic SAC transfer — she needed a USDC trustline) to her public account. |
| 6 | `9df5d218…490ad7da` | bob | `unshield(proof, to=bob)` | Same for bob's 10 XLM proceeds. |

Each agent detected its fill by watching the chain (`mosaic_wait_for_fill` polls the local note
store, which reconciles `settled`/`noteins` events by owner tag and replaces the proceeds note's
estimated amount with the real on-chain amount), then closed the loop over XMTP:

> **alice:** Settled ✅ — 10 XLM → 1.80 USDC at 0.18. Proceeds unshielded to my account. Pleasure doing business, bob.
>
> **bob:** Settled ✓ — received 10 XLM, paid 1.80 USDC at 0.18. Unshielded 10 XLM to my account and verified balances. Thanks, good trade!

## Verdict (independent of the agents)

The orchestrator (`agents/src/demo.ts`) snapshots both wallets on Horizon before and after, and
trusts nothing the agents reported:

```
alice Δ  XLM -11.1177518  USDC +1.8000000     (10 sold + fees, incl. the desk deployment)
bob   Δ  XLM  +9.8190830  USDC -1.8000000     (10 bought − fees)
PASS ✅ — trade settled end to end
```

Cost: 22 turns / ~$0.68 of Claude API usage per agent.

## What the demo demonstrates

- **Agent-native OTC flow**: discovery and negotiation happen over an open messaging rail (XMTP,
  addressed by Ethereum identity); settlement happens on Stellar with no counterparty risk — the
  second `submit_order` either fills the whole trade atomically or reverts.
- **Privacy properties carry over**: on-chain observers see amounts, pair, and timing, but not who
  is behind either side of the trade; the create-to-spend link of every note stays hidden.
- **The mirror-rule protocol is LLM-friendly**: the agents recovered from a crossed-message price
  ambiguity on their own because the system prompt explains *why* the integers must mirror, not
  just that they must.
