# mosaic-frontend

Minimalist (black & white) web client for Stellar Mosaic. Vite + React + TypeScript, Freighter
wallet, browser-side ZK proving, and local private notes in IndexedDB.

## Run

```bash
npm install
npm run dev            # http://localhost:5173, proxies /api -> backend (127.0.0.1:8787)
```

The backend (`../backend`) must be running. Override its URL with `MOSAIC_BACKEND` (build-time) or
the Soroban RPC with `VITE_SOROBAN_RPC` (defaults to testnet).

## What it does

- `/` — list desks + pairs; create a new desk (deploys a contract via the backend) or import one.
- `/desk/:id` — address book (desk contract/sponsor/token addresses + your notes), shield, place a
  limit order, and a live order book. Auto-refreshes root/book/notes.

## How proving works (no secrets leave the browser)

- `note_tag` / `order_terms` Noir helpers run via `noir_js` to derive owner tags, nullifiers, and
  order leaves — byte-identical to the contract's Poseidon2 (verified against the `witness` tool).
- The lift (order) circuit is proved in-browser with `@aztec/bb.js` (`{ keccak: true }`). The full
  proof + concatenated public inputs are accepted by the on-chain Nethermind verifier (validated
  against the deployed VK).
- `shield` is user-signed (Freighter); `submit_order` is relayed fully-sponsored by the backend.

Compiled circuits live in `public/circuits/` — regenerate with `../scripts/08_build_web_artifacts.sh`.
