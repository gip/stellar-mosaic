# @mosaic/agent-sdk

Deterministic wallet-derived agent identities for Stellar Mosaic, plus the npx-runnable daemon
that runs them.

## Run agents (end user)

Configure agents on the Mosaic web app (Agents tab), create a **runner**, copy the one-time
identity string, then on any machine with Node ≥ 22:

```
OPENAI_API_KEY=... MOSAIC_IDENTITY=mosaic-runner-... npx @mosaic/agent-sdk start
```

The daemon authenticates with the runner credential, pulls your configured agents + desired state,
decrypts each agent's sealed key bundle, and runs one child process per agent that is toggled
"running" on the web — start/stop/new agents take effect without restarting. Provider API keys
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) travel only through the environment, never to disk or the
server. Other commands: `mosaic-agent identity` prints the credential's public half.

## Key architecture

One wallet signature over a canonical, versioned message roots the whole tree (HKDF-SHA-256,
domain-separated — see `src/derive.ts`; the golden-vector tests freeze the scheme):

```
signature ─▶ masterRoot ─▶ agentRoot(n) ─▶ stellar/v1 · eth/v1 (XMTP) · data/v1 · xmtp-db/v1
```

- Masters are a Stellar wallet (SEP-0053) or an Ethereum EOA (EIP-191, low-s normalized; contract
  wallets rejected). Re-signing re-derives the exact same agents.
- The 32-byte `agentRoot(n)` is the sealed/exported unit: the web seals it to each runner's X25519
  key (ECIES-style, AES-256-GCM, AAD-bound to the agent+runner ids), so `MOSAIC_IDENTITY` is
  revocable server-side without touching the wallet, and leaking it exposes only the agents sealed
  to that runner.
- The backend registers public keys only; private keys never leave the client/daemon.

## Library surface

- `.` (Node): everything — `startAgentSession` (auth + data + XMTP session logging), `runAgent`
  (the generic trading agent: Vercel AI SDK tool loop with Mosaic + XMTP tools), `startDaemon`.
- `./derive` (browser-safe, WebCrypto/@noble only): derivation, master signing, runner credentials
  + sealing, data crypto, and the typed `AgentBackendClient` — what the frontend Agents pages use.

Session logs travel as JSON DMs over XMTP to the backend's known address (`agent-log/v1`
envelopes, per-session seq, public/private visibility). Test: `pnpm test` (all offline; the XMTP
network is never touched in tests).
