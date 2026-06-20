# Note types: asset note and order note

Two note types. Proceeds and change from a trade are just new asset notes, so these two cover
everything. Model: **owner-anonymous, amount-transparent** (see `privacy-model.md` and
`architecture.md`).

## Shared crypto

```
  SECRET (wallet only):  sk_o , rho        (fresh rho per note)
  derived:  pk_o      = Poseidon(sk_o)
            owner_tag = Poseidon(pk_o, rho)       PUBLIC, opaque, one-time address
            nullifier = Poseidon(sk_o, rho)       revealed only when the note is spent
```

`owner_tag` is PUBLIC. Privacy is not from hiding it; it is from: one-way (no tag->identity),
one-time (tags don't cluster), and spends reveal a nullifier + a membership proof that hides
WHICH note (so a spend can't be linked to the note's creation). Only `sk_o` and `rho` are secret.

## Asset note (a unit of value)

```
  AssetNote {                 // ALL fields public
    asset      : AssetId      // USDC/XLM native; ETH/XRP require wrapped issuers or bridges
    amount     : u128         // e.g. 100_000000 (100 USDC)
    owner_tag  : Field        // Poseidon(pk_o, rho)
  }
  leaf      = Poseidon(asset, amount, owner_tag)
  nullifier = Poseidon(sk_o, rho)     // when spent
```
Created by: `shield`, or `settle` (proceeds/change). Consumed by: `lift_order`, `unshield`.

## Order note (a resting limit order)

```
  OrderNote {                       // ALL fields public (this IS the lit order book)
    asset_in         : AssetId      // USDC offered  (side implied: in=USDC,out=XLM => buy XLM)
    amount_in        : u128         // 100 USDC max
    asset_out        : AssetId      // XLM wanted
    min_out          : u128         // limit terms, scaled integer / fixed-point policy
    output_owner_tag : Field        // proceeds destination = Poseidon(pk_o, rho_out)
    cancel_owner_tag : Field        // cancel auth          = Poseidon(pk_o, rho_ord)
    expiry           : u64          // validity deadline (unix seconds); book rejects when past
    partial_allowed  : bool         // may this order be partially filled in the book
  }
  leaf      = Poseidon8(asset_in, amount_in, asset_out, min_out,
                        output_owner_tag, cancel_owner_tag, expiry, partial_allowed)
```
Created by: `lift_order` (consuming an asset note). Consumed by `settle`/`settle_exact` (atomic) or
rested in the on-chain book and consumed by fills, `cancel_order`, or `prune_expired` (see
`order-book.md`). The book stores these terms in plaintext; `cancel_order` proves knowledge of the
`cancel_owner_tag` secret (no nullifier — removing the book entry is the single-use guard).

## How settle creates proceeds (no proof, no secret)

`settle` reads the order's PUBLIC `output_owner_tag` (bound by the lift proof, so authentic) and
stamps it onto a new asset note with the PUBLIC fill amount it computed:

```
  proceeds leaf = Poseidon(asset_out, fill_amount, output_owner_tag)
```

The order-placer chose `rho_out` themselves, so they already know the secret behind
`output_owner_tag`; they scan for the proceeds note carrying it, read the public amount, and
spend it later with `sk_o` + `rho_out`. settle needs no secret and no proof — it stamps a public
tag onto a public amount.

Cost of public tags: order and proceeds visibly share `output_owner_tag` -> the order is linkable
to its proceeds note (acceptable: the order is already public; no identity revealed; the link
breaks at the proceeds' next spend via membership). To hide even that, use a separate claim step
(extra tx; proceeds publicly claimable meanwhile) — deferred.

## Lifecycle

```
  shield            lift_order                      settle
  AssetNote(USDC,100) --consume--> OrderNote(buy XLM,100 USDC) --consume--> AssetNote(XLM,15000)
                                                                            + AssetNote(USDC,40) if partial
```

## Notes for circuit/contract design
- Limit terms are scaled integers (fixed-point), never floats, so the contract crosses orders in
  plaintext. Choose the scale to avoid rounding leak/loss.
- `amount` should snap to standard denominations (1/10/100/1000 + change) for a real anonymity
  set (`privacy-model.md`).
- The `lift_order` proof's public inputs must bind: the consumed nullifier, value conservation
  (input note amount == amount_in + change), and the new order note's fields including
  `output_owner_tag` and `cancel_owner_tag`.
