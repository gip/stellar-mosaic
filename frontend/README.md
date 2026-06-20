# mosaic-frontend

Minimalist web client for Stellar Mosaic. Fund forms enqueue high-level operations; a recovery-
unlocked private-wallet worker performs leased signing/proving steps while the Rust backend owns
durable FIFO sequencing, submission state, and progress history.

## Run

```bash
pnpm install
pnpm dev               # http://localhost:5173, proxies /api -> backend (127.0.0.1:8787)
```

The backend (`../backend`) must be running. Override its URL with `MOSAIC_BACKEND` (build-time) or
the Soroban RPC with `VITE_SOROBAN_RPC` (defaults to testnet).

## What it does

- `/` — list desks + pairs; create a new desk (deploys a contract via the backend) or import one.
- `/desk/:id` — address book (desk contract/sponsor/token addresses + your notes), shield, place a
  limit order, and a live order book. Auto-refreshes root/book/notes.
- A global Activity drawer survives navigation/reload and shows queued, running, and historical work.

## Proving and recovery

- `note_tag` / `order_terms` Noir helpers run via `noir_js` to derive owner tags, nullifiers, and
  order leaves — byte-identical to the contract's Poseidon2 (verified against the `witness` tool).
- The lift (order) circuit is proved in-browser with `@aztec/bb.js` (`{ keccak: true }`). The full
  proof + concatenated public inputs are accepted by the on-chain Nethermind verifier (validated
  against the deployed VK).
- `shield` is fully sponsored via auth-entry signing: the user signs only the Soroban auth entry in
  Freighter, the sponsor is the tx source and pays the fee. `submit_order` is relayed sponsored too.
- Before creating notes, Freighter signs a fixed recovery message. The browser verifies that
  signature, derives domain-separated AES/lookup/write keys with HKDF-SHA-256, and uploads only an
  AES-GCM-encrypted snapshot. Plaintext `sk`/`rho` values never leave the browser. The same account
  can restore on a new device; encrypted file export is the service-independent backup.
- Notes created before recovery support have no account association and remain explicitly
  local-only. Never sign the Mosaic recovery message outside the trusted app: it unlocks the notes.
- Backend login uses a separate short-lived challenge message whose signature cannot derive the
  recovery key. Private operation journals and note reservations remain browser-side.

Compiled circuits live in `public/circuits/` — regenerate with `../scripts/08_build_web_artifacts.sh`.
