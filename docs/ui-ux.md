# Design: UI/UX (WS3)

Design document for the web client. The goal of WS3 is a *polished, intuitive* trading experience on
top of the privacy machinery — without leaking the complexity (notes, proofs, nullifiers, leases)
into the user's face. Grounded in the implemented frontend (`frontend/`, see `implementation.md` for
the trust boundary); this doc captures the principles and the planned refinements.

## Principles

1. **The pool is invisible plumbing.** Users think in *balances* and *orders*, not notes, leaves, or
   nullifiers. Denominations, coin selection, and split/join are planned by the client and never
   surfaced unless the user asks.
2. **No surprise wallet prompts.** Everything is fully sponsored. The only signature a user ever sees
   is the single Soroban auth-entry on `shield` (their own funds moving in) — never a fee approval,
   never a sequence bump. `submit_order` / `unshield` / `cancel` are relayer-submitted and prompt-free.
3. **Proving is a first-class state, not a hang.** In-browser UltraHonk proving takes seconds; the UI
   shows an explicit "proving" affordance with progress, and the leased client-action model keeps the
   operation alive across it. No spinner that looks like a freeze.
4. **Durable, replayable progress.** Every fund action is a server-side operation streamed over SSE
   with `Last-Event-ID` resume, so a refresh or a dropped connection never loses the user's place. The
   Activity drawer is the single source of truth for "what is happening to my money."
5. **Recovery is one action.** Notes are reconstructable from an encrypted backup unlocked by a
   Freighter `signMessage`; the recovery panel makes "I switched browsers" a one-click restore, with
   encrypted file export as the offline fallback.

## Information architecture

```
Home ──▶ pick / create / import a Desk
Desk page
  ├─ Assets & balances        (shield / unshield; balances grouped by asset)
  ├─ Order book (BookView)     place order (OrderForm) · cancel · live depth
  ├─ Shield from Base          cross-chain deposit + status
  ├─ Activity drawer           durable SSE timeline of every operation
  └─ Recovery panel            backup / restore notes
```

Implemented components: `ShieldForm`, `UnshieldForm`, `OrderForm`, `BookView`, `CancelOrderButton`,
`ShieldFromBaseForm`, `CreateDeskForm`, `ImportDeskForm`, `RecoveryPanel`, `ActivityDrawer`,
`AssetList`.

## Proposed refinements (the "great" in great UX)

- **Denomination-aware shielding.** When a user shields a non-standard amount, suggest splitting into
  standard denominations (1/10/100/1000 + change) inline, with a one-line explanation of why it
  improves their anonymity set (`privacy-model.md`). Make the privacy-maximizing choice the default,
  not a hidden expert setting.
- **Anonymity-set hint.** Surface a lightweight "this amount blends with N other notes" indicator at
  shield/order time, so users feel the privacy trade-off of off-denomination amounts.
- **Order ticket = price-per-base.** Quote orders by a single quote-per-base limit price (already the
  model) and render the implied lot size + worst-case partial-fill behavior, so "why didn't my order
  fully fill" is answered before submit.
- **Optimistic, reversible UI.** Show the intended end-state immediately, reconcile against SSE, and
  roll back visibly on failure — never leave the user guessing whether a relayed tx landed.
- **First-run desk tour.** A desk is a deployed contract + sponsor + assets/pairs; a guided first-run
  flow (shield → place → fill → unshield on testnet) turns the demo scripts into an in-app onboarding.

## Open questions

- How much of the note/denomination model to ever expose (power-user "coin control" view vs. fully
  hidden).
- Mobile / wallet-deeplink story for Freighter signing on small screens.
- Multi-desk portfolio view (balances across desks) vs. strict per-desk isolation.
