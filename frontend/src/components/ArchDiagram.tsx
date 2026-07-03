import { useState } from 'react'

// Interactive trust-model diagram. Three settlement paths (Trustless / Trusted / Agent);
// selecting a mode highlights that path's nodes and edges. Styling lives under `.mosaic-arch`
// in styles/components.css and sources its colors from the site design tokens.

type Mode = 'trustless' | 'trusted' | 'agent'

const MODES: { id: Mode; label: string }[] = [
  { id: 'trustless', label: 'Trustless mode' },
  { id: 'trusted', label: 'Trusted mode' },
  { id: 'agent', label: 'Agent mode' },
]

const CAPTIONS: Record<Mode, string> = {
  trustless: 'Trustless — you run the Mosaic SDK and generate proofs locally, settling straight to the Stellar desk.',
  trusted: 'Trusted — the browser delegates the SDK and proving to a hosted MCP, which drives the Steel prover and both bridges.',
  agent: 'Agent — autonomous agents prove at the edge and settle to the Stellar desk on your behalf.',
}

export default function ArchDiagram() {
  const [mode, setMode] = useState<Mode>('trustless')

  const nodeCls = (modes: Mode[]) => `n ${modes.includes(mode) ? 'on' : 'dim'}`
  const edgeCls = (modes: Mode[]) => `edge ${modes.includes(mode) ? 'on' : 'dim'}`

  return (
    <div className="mosaic-arch">
      <h2 className="ma-sr-only">
        Interactive architecture diagram of the Stellar Mosaic trading desk with three trust models;
        selecting a mode highlights that settlement path.
      </h2>

      <div className="ma-bar">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`ma-btn${mode === m.id ? ' sel' : ''}`}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="ma-cap">{CAPTIONS[mode]}</div>

      <svg viewBox="0 0 680 590" role="img">
        <title>Stellar Mosaic trust-model paths</title>
        <desc>
          You branch to agents, a trustless browser, or a trusted browser. Trustless and agent
          settle directly to the Stellar bridge and desk with edge proving; the trusted browser
          delegates to MCP, which drives the EVM Steel prover and both bridges.
        </desc>
        <defs>
          <marker
            id="ma-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path
              d="M2 1L8 5L2 9"
              fill="none"
              stroke="context-stroke"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        </defs>

        <g id="ma-edges">
          <path className={edgeCls(['agent'])} d="M317 56 L138 96" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trustless'])} d="M340 58 L340 91" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trusted'])} d="M362 55 L503 92" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['agent'])} d="M130 235 L145 425" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trustless'])} d="M328 235 L216 425" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trusted'])} d="M550 175 L550 246" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trusted'])} d="M486 388 L253 428" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trusted'])} d="M525 390 L366 436" markerEnd="url(#ma-arrow)" />
          <path className={edgeCls(['trusted'])} d="M585 390 L553 426" markerEnd="url(#ma-arrow)" />
        </g>

        <g id="ma-nodes">
          <g className={nodeCls(['trustless', 'trusted', 'agent'])}>
            <rect className="card" x="295" y="20" width="90" height="38" rx="19" />
            <text className="title" x="340" y="44" textAnchor="middle">You</text>
          </g>

          <g className={nodeCls(['agent'])}>
            <rect className="card" x="40" y="95" width="180" height="140" rx="12" />
            <text className="title" x="130" y="122" textAnchor="middle">Agents</text>
            <rect className="chip" x="60" y="138" width="140" height="88" rx="6" />
            <text className="chip-t" x="130" y="160" textAnchor="middle">Mosaic SDK</text>
            <text className="chip-t" x="130" y="178" textAnchor="middle">UTXO-style notes</text>
            <text className="chip-t" x="130" y="196" textAnchor="middle">Stellar/Base contracts</text>
            <text className="chip-t" x="130" y="214" textAnchor="middle">Edge proving</text>
          </g>

          <g className={nodeCls(['trustless'])}>
            <rect className="card" x="250" y="95" width="180" height="140" rx="12" />
            <text className="title" x="340" y="116" textAnchor="middle">Browser</text>
            <text className="sub" x="340" y="132" textAnchor="middle">Trustless setup</text>
            <rect className="chip" x="270" y="140" width="140" height="86" rx="6" />
            <text className="chip-t" x="340" y="161" textAnchor="middle">Mosaic SDK</text>
            <text className="chip-t" x="340" y="178" textAnchor="middle">UTXO-style notes</text>
            <text className="chip-t" x="340" y="195" textAnchor="middle">Stellar contract only</text>
            <text className="chip-t" x="340" y="212" textAnchor="middle">Edge proving</text>
          </g>

          <g className={nodeCls(['trusted'])}>
            <rect className="card" x="460" y="95" width="180" height="80" rx="12" />
            <text className="title" x="550" y="122" textAnchor="middle">Browser</text>
            <text className="sub" x="550" y="140" textAnchor="middle">Trusted setup</text>
            <text className="sub" x="550" y="158" textAnchor="middle">delegates to MCP</text>
          </g>

          <g className={nodeCls(['trusted'])}>
            <rect className="card" x="460" y="250" width="180" height="140" rx="12" />
            <text className="title" x="550" y="274" textAnchor="middle">MCP</text>
            <rect className="chip" x="480" y="290" width="140" height="84" rx="6" />
            <text className="chip-t" x="550" y="311" textAnchor="middle">Mosaic SDK</text>
            <text className="chip-t" x="550" y="328" textAnchor="middle">UTXO-style notes</text>
            <text className="chip-t" x="550" y="345" textAnchor="middle">Stellar/Base contracts</text>
            <text className="chip-t" x="550" y="362" textAnchor="middle">Edge proving</text>
          </g>

          <g className={nodeCls(['trustless', 'trusted', 'agent'])}>
            <rect className="card" x="40" y="430" width="210" height="120" rx="12" />
            <text className="title" x="145" y="478" textAnchor="middle">Stellar bridge &amp; desk</text>
            <text className="sub" x="145" y="500" textAnchor="middle">Settlement + OTC desk</text>
          </g>

          <g className={nodeCls(['trusted'])}>
            <rect className="card" x="280" y="440" width="160" height="100" rx="12" />
            <text className="title" x="360" y="477" textAnchor="middle">EVM Steel prover</text>
            <text className="sub" x="360" y="499" textAnchor="middle">Local or Boundless</text>
          </g>

          <g className={nodeCls(['trusted'])}>
            <rect className="card" x="460" y="430" width="180" height="120" rx="12" />
            <text className="title" x="550" y="478" textAnchor="middle">Base bridge</text>
            <text className="sub" x="550" y="500" textAnchor="middle">Cross-chain settlement</text>
          </g>
        </g>
      </svg>
    </div>
  )
}
