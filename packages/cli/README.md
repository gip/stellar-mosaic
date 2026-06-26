# @mosaic/cli (`mosaic`)

Headless CLI for **Stellar Mosaic** — drive the privacy DEX entirely locally with your own funded
key. No backend: it signs and pays its own fees, rebuilds Merkle paths locally (bundled `compress`
circuit), proves in-process (UltraHonk via `bb.js`), and tracks notes in a local SQLite store. It is
a thin shell over `@mosaic/sdk` (`createNodeClient`), so it shares one code path with the web app.

## Install / build

```bash
# from the repo root (npm workspaces)
npm run build:sdk && npm -w @mosaic/cli run build
node packages/cli/dist/cli.js --help     # or `npm link` to get the `mosaic` bin
```

State lives under `$MOSAIC_HOME` (default `~/.mosaic`): `config.json` (key + desks + network) and
`notes.db` (SQLite note store). Network defaults to testnet; override with `MOSAIC_RPC`,
`MOSAIC_NETWORK_PASSPHRASE`, `MOSAIC_FRIENDBOT`.

## Commands

| Command | What it does |
| --- | --- |
| `keys generate` / `keys show` | create / show the signing key |
| `fund [address]` | Friendbot-fund an account (default: your own) |
| `deploy <spec.json>` | deploy a fresh desk via the `stellar` CLI and register it |
| `desk add <desk.json>` / `desk list` | register / list a known desk |
| `shield <deskId> <assetId> <amount>` | shield an asset into a private note |
| `order <deskId> <pairId> <buy\|sell> <amountIn> <minOut> [--partial]` | place a private limit order |
| `unshield <deskId> <assetId> <amount> <recipient>` | withdraw to a Stellar address |
| `cancel <deskId> <noteId>` | cancel a resting order, reclaim funds |
| `notes [deskId]` | list local notes |
| `watch <deskId> [--interval ms]` | reconcile notes against the chain continuously |

`deploy` requires the `stellar` CLI and the bundled `settlement.wasm` (run
`scripts/08_build_web_artifacts.sh` once to build it into `packages/sdk/assets/`).

## End-to-end (testnet)

The single-user happy path (a full two-sided settle mirrors `scripts/04` with a second key):

```bash
mosaic keys generate
mosaic fund
mosaic deploy ./desk-spec.json          # -> desk id + contract id
mosaic shield <deskId> 1 1000000        # shield 0.1 XLM (raw stroops)
mosaic notes <deskId>                    # watch it become indexed
mosaic order <deskId> 0 sell 1000000 950000
mosaic unshield <deskId> 1 500000 <G...recipient>
```

A `desk-spec.json` for `deploy`:

```json
{
  "name": "demo",
  "assets": [
    { "asset_id": 1, "symbol": "XLM", "token": "native", "decimals": 7, "kind": "Stellar" }
  ],
  "pairs": [{ "base_asset": 1, "quote_asset": 1 }]
}
```
