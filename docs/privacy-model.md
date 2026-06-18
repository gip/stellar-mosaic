# Privacy model: owner-anonymous, amount-transparent

Decision (2026-06-17): **amounts are public, ownership is hidden.** This is what makes
proof-free settlement and plaintext value conservation possible (see `architecture.md`).

## Note structure

```
  on-chain leaf:    commit = Poseidon(asset, amount, owner_tag)
  published PUBLIC: asset, amount, owner_tag    (all readable; owner_tag is an opaque
                                                 one-time address)
  SECRET (wallet):  sk_o, rho   where pk_o=Poseidon(sk_o), owner_tag=Poseidon(pk_o, rho)
```

**owner_tag is PUBLIC, not hidden** (corrected). It must be public so `settle` can stamp it onto
proceeds notes with no proof. Ownership privacy does NOT come from hiding the tag; it comes from:
the tag being one-way (can't recover identity), one-time (fresh `rho`, so a user's tags don't
cluster), and spends revealing a nullifier (never the tag, and membership hides which note).
The only secrets are `sk_o` and per-note `rho`.

## Ownership privacy = four mechanisms (public amounts remove none of them)

1. **Merkle note set** — spending proves "I own SOME note in the tree" without revealing which.
   This is the anonymity set. No tree -> spend points at a specific note -> links to its creator.
2. **Nullifiers (not note IDs)** — spend reveals `N = H(owner_secret, nonce)`, never the
   commitment. Unlinks a spend from the note's creation. Contract checks N unused (no double-spend).
3. **One-time / stealth owner tags** — owner_tag is fresh per note (derived from the recipient's
   viewing key + randomness, randomness encrypted to them). So a user's notes aren't mutually
   linkable, and only the recipient can scan/recognize/spend their notes (also = note discovery).
4. **Relayer** — submits txs so the Stellar source account isn't the trader's.

Spend proof (ZK): "a note in the tree has an owner_tag I can open, its nullifier is N, value is
conserved" — reveals N + public amounts, never which note or who.

## Public vs hidden

```
  PUBLIC:  every note's asset+amount; order book (pair, price, size); the match;
           the amount-flow graph through the pool
  HIDDEN:  the identity/key owning any note; the create<->spend link; which note a spend consumed
```

## The catch: public amounts shrink the anonymity set

- **Amount + timing correlation:** distinctive values (137.42 USDC shield -> 137.42 order ->
  137.42 unshield) are followable even with hidden owners. Anonymity set per spend ≈ "notes of a
  compatible amount," not "all notes."
- **Mitigation: standard denominations** (1/10/100/1000 + change notes) so many notes share each
  amount -> large anonymity set (Tornado-style). Main lever without hiding amounts.
- **Edges leak:** shields/unshields move real tokens to/from real accounts -> amounts +
  accounts visible. Privacy is inside the pool; entry/exit is pseudonymous at best.

## One-liner

**Owner-anonymous, amount-transparent.** No cryptographic link from a note/trade to an identity;
but amounts + timing are followable (strongest with standard denominations, weakest at the edges).
Defeating amount-correlation too = the deferred "hide amounts" hard mode (reintroduces proofs at
settle, reopening the budget question).
