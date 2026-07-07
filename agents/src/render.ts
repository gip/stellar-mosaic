// Renders a run's transcripts as a single self-contained HTML page (inline CSS/JS, no external
// assets): per-agent colors, chat bubbles for the XMTP dialogue, tool-call JSON collapsed by
// default, verdict/balances/usage tables from the results file.
//
// Library use: renderRunHtml(results, transcripts) — called by run.ts after every run.
// CLI use:     node dist/render.js <results/<file>.json | runDir> [...more]
//   A results JSON gets a sibling .html; a bare run dir (e.g. a crashed run with no results file)
//   gets <dir>/transcript.html rendered from whatever *.transcript.json files it contains.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// --- shapes (mirrors what agentMain.ts / run.ts write) ---------------------------------------

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface TranscriptStep {
  text?: string;
  at?: string; // ISO; absent in transcripts written before timestamps were added
  toolCalls: { toolName: string; input: unknown }[];
  toolResults: { toolName: string; output: unknown }[];
  finishReason: string;
  usage?: unknown;
}

export interface Transcript {
  name: string;
  provider: string;
  model: string;
  /** Exact prompts the agent ran with; absent in transcripts written before they were recorded. */
  system?: string;
  prompt?: string;
  startedAt: string;
  finishedAt: string;
  steps: TranscriptStep[];
  finishReason?: string;
  totalUsage?: TokenUsage;
  finalText?: string;
  error?: string;
}

export interface AgentOutcome {
  name: string;
  provider: string;
  model: string;
  stellarAddress?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  finishReason?: string;
  steps?: number;
  totalUsage?: TokenUsage;
  transcript?: string;
}

type Balances = Record<string, number>;

export interface RunResults {
  experiment: string;
  runId: string;
  startedAt?: string;
  durationSeconds?: number;
  assets?: { symbol: string; issuer?: string; demo?: boolean }[];
  agents: AgentOutcome[];
  balances?: { before: Record<string, Balances>; after: Record<string, Balances>; delta: Record<string, Balances> };
  verdict?: {
    rules: { agent: string; asset: string; min?: string; max?: string; delta: number; pass: boolean }[];
    allAgentsExitedClean: boolean;
    timedOut: boolean;
    pass: boolean;
  };
  runDir?: string;
}

// --- timeline events ---------------------------------------------------------------------------

type Ev =
  | { kind: "chat"; agent: number; to?: string; text: string; at?: string }
  | { kind: "recv"; agent: number; from: string; text: string; at?: string } // ordering only, never rendered
  | { kind: "thought"; agent: number; text: string; at?: string }
  | { kind: "tool"; agent: number; toolName: string; input: unknown; output: unknown; at?: string };

/** Parse a tool output that may be a JSON-encoded string (the XMTP/Mosaic tools stringify). */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function extractEvents(agent: number, t: Transcript): Ev[] {
  const out: Ev[] = [];
  for (const step of t.steps) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const call = step.toolCalls[i];
      const result = step.toolResults[i];
      const output = result?.output ?? "— no result recorded —";
      if (call.toolName === "xmtp_send") {
        const input = call.input as { to?: string; text?: string };
        if (typeof input?.text === "string") {
          out.push({ kind: "chat", agent, to: input.to, text: input.text, at: step.at });
          continue;
        }
      }
      if (call.toolName === "xmtp_wait_for_message") {
        const msg = parseMaybeJson(output) as { from?: string; text?: string };
        if (msg && typeof msg === "object" && typeof msg.from === "string" && typeof msg.text === "string") {
          out.push({ kind: "recv", agent, from: msg.from, text: msg.text, at: step.at });
          continue;
        }
        // fall through: timeouts / errors render as a regular tool row
      }
      out.push({ kind: "tool", agent, toolName: call.toolName, input: call.input, output, at: step.at });
    }
    if (step.text?.trim()) out.push({ kind: "thought", agent, text: step.text.trim(), at: step.at });
  }
  return out;
}

/** Chronological merge when every step carries a timestamp. */
function mergeByTime(perAgent: Ev[][]): Ev[] {
  const all: { ev: Ev; seq: number }[] = [];
  let seq = 0;
  for (const events of perAgent) for (const ev of events) all.push({ ev, seq: seq++ });
  // Per-agent seq order is already chronological; sort only across agents by timestamp.
  return all
    .sort((a, b) => {
      const ta = a.ev.at ?? "";
      const tb = b.ev.at ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : a.seq - b.seq;
    })
    .map((x) => x.ev);
}

/**
 * Merge without timestamps (old transcripts): the XMTP messages give a causal order — an agent's
 * received message can only appear after the sender's matching xmtp_send. Greedily advance agents,
 * consuming receives as soon as their send has been emitted, so replies land after what they
 * answer; force-advance on deadlock (unmatched receive) rather than dropping events.
 */
function mergeByConversation(perAgent: Ev[][], names: string[]): Ev[] {
  const ptr = perAgent.map(() => 0);
  const sent = new Map<string, number>(); // "<from>|<text>" -> times emitted
  const consumed = new Map<string, number>(); // "<agent>|<from>|<text>" -> times consumed
  const out: Ev[] = [];
  const done = () => ptr.every((p, i) => p >= perAgent[i].length);
  const recvReady = (i: number): boolean => {
    const ev = perAgent[i][ptr[i]];
    if (ev.kind !== "recv") return true;
    const key = `${ev.from}|${ev.text}`;
    return (sent.get(key) ?? 0) > (consumed.get(`${i}|${key}`) ?? 0);
  };
  const advance = (i: number) => {
    const ev = perAgent[i][ptr[i]++];
    if (ev.kind === "chat") {
      const key = `${names[i]}|${ev.text}`;
      sent.set(key, (sent.get(key) ?? 0) + 1);
      out.push(ev);
    } else if (ev.kind === "recv") {
      const key = `${i}|${ev.from}|${ev.text}`;
      consumed.set(key, (consumed.get(key) ?? 0) + 1);
    } else {
      out.push(ev);
    }
  };
  while (!done()) {
    // Receives whose send is already out go first — they position the reply right after the message.
    const readyRecv = perAgent.findIndex((evs, i) => ptr[i] < evs.length && evs[ptr[i]].kind === "recv" && recvReady(i));
    if (readyRecv >= 0) {
      advance(readyRecv);
      continue;
    }
    // Least-progressed unblocked agent next, so no agent's whole transcript dumps at once.
    let pick = -1;
    for (let i = 0; i < perAgent.length; i++) {
      if (ptr[i] >= perAgent[i].length || !recvReady(i)) continue;
      if (pick < 0 || ptr[i] / perAgent[i].length < ptr[pick] / perAgent[pick].length) pick = i;
    }
    if (pick < 0) pick = ptr.findIndex((p, i) => p < perAgent[i].length); // deadlock: unmatched recv
    advance(pick);
  }
  return out;
}

// --- HTML --------------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function prettyJson(value: unknown): string {
  const parsed = parseMaybeJson(value);
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
}

function preview(value: unknown, max = 90): string {
  const parsed = parseMaybeJson(value);
  const s = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const fmtDelta = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(7)}`;
const num = (v: number | undefined): string => (v === undefined ? "?" : v.toLocaleString("en-US"));

const STYLE = `
:root {
  --bg: #f2f3f5; --surface: #ffffff; --ink: #16181d; --muted: #667085; --line: #e3e5ea;
  --pass: #15803d; --fail: #b91c1c; --code-bg: #f6f7f9;
  --a0: #0e7490; --a1: #7c3aed; --a2: #c2410c; --a3: #1d4ed8;
  --a4: #be185d; --a5: #15803d; --a6: #a16207; --a7: #475569;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --surface: #171a20; --ink: #e7e9ee; --muted: #8b93a1; --line: #262b34;
    --pass: #4ade80; --fail: #f87171; --code-bg: #10131a;
    --a0: #22d3ee; --a1: #c084fc; --a2: #fb923c; --a3: #7dabf8;
    --a4: #f472b6; --a5: #4ade80; --a6: #eab308; --a7: #9aa5b5;
  }
}
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
.wrap { max-width: 860px; margin: 0 auto; padding: 36px 20px 72px; }
.eyebrow { font: 600 11px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
h1 { font: 700 30px/1.2 var(--mono); margin: 8px 0 2px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
h1 .run-id { font-size: 15px; font-weight: 400; color: var(--muted); }
.badge { font: 700 12px/1 var(--mono); letter-spacing: 0.08em; padding: 5px 10px; border-radius: 4px; }
.badge.pass { color: var(--pass); border: 1.5px solid var(--pass); }
.badge.fail { color: var(--fail); border: 1.5px solid var(--fail); }
.meta { font: 12.5px var(--mono); color: var(--muted); margin: 6px 0 14px; }
.chips { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 26px; }
.chip { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--surface);
        border-radius: 6px; padding: 7px 12px; font: 12.5px var(--mono); }
.chip b { color: var(--accent); font-weight: 700; }
.chip .sub { color: var(--muted); }
.tape { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 26px; }
.tape .cell { font: 12.5px var(--mono); border: 1px solid var(--line); background: var(--surface);
              border-radius: 4px; padding: 6px 10px; }
.tape .ok { border-color: color-mix(in srgb, var(--pass) 45%, var(--line)); }
.tape .ok .mark { color: var(--pass); font-weight: 700; }
.tape .bad { border-color: color-mix(in srgb, var(--fail) 55%, var(--line)); }
.tape .bad .mark { color: var(--fail); font-weight: 700; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; }
.panel > summary { cursor: pointer; padding: 10px 14px; font: 600 12px/1 var(--mono);
                   letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); user-select: none; }
.panel > div { padding: 4px 14px 14px; overflow-x: auto; }
table { border-collapse: collapse; font: 12.5px var(--mono); width: 100%; }
th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: 0.08em;
     text-transform: uppercase; padding: 4px 16px 6px 0; border-bottom: 1px solid var(--line); }
td { padding: 5px 16px 5px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: none; }
td.r, th.r { text-align: right; }
.pos { color: var(--pass); } .neg { color: var(--fail); }
.tl-head { display: flex; align-items: baseline; justify-content: space-between; margin: 30px 0 14px; }
.tl-head h2 { font: 600 12px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
#xall { font: 12px var(--mono); color: var(--muted); background: none; border: 1px solid var(--line);
        border-radius: 4px; padding: 5px 10px; cursor: pointer; }
#xall:hover { color: var(--ink); }
.timeline { display: flex; flex-direction: column; gap: 12px; border-left: 2px solid var(--line); padding-left: 18px; }
.ev { max-width: 82%; align-self: flex-start; }
.ev.side-r { align-self: flex-end; }
.who { font: 700 11px/1 var(--mono); color: var(--accent); margin-bottom: 4px; letter-spacing: 0.04em; }
.who .to { color: var(--muted); font-weight: 400; }
.bubble { background: color-mix(in srgb, var(--accent) 9%, var(--surface));
          border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
          border-radius: 10px; padding: 9px 13px; white-space: pre-wrap; overflow-wrap: break-word; }
.thought { border-left: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
           padding-left: 10px; font-style: italic; font-size: 13.5px; color: var(--muted);
           white-space: pre-wrap; overflow-wrap: break-word; }
.tool { font: 12.5px var(--mono); width: 100%; max-width: 100%; }
.tool summary { cursor: pointer; color: var(--muted); padding: 3px 0; user-select: none; }
.tool summary .tn { color: var(--accent); font-weight: 700; }
.tool summary .pv { opacity: 0.75; }
.tool .io { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 10px 12px; margin-top: 6px; }
.tool .io .lbl { font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
                 color: var(--muted); margin: 6px 0 4px; }
pre { font: 12px/1.5 var(--mono); background: var(--code-bg); border: 1px solid var(--line);
      border-radius: 6px; padding: 9px 11px; overflow-x: auto; }
.agent-error { font: 12.5px var(--mono); color: var(--fail); border: 1px dashed var(--fail);
               border-radius: 6px; padding: 8px 12px; white-space: pre-wrap; }
footer { margin-top: 34px; font: 12px var(--mono); color: var(--muted); }
footer div { padding: 2px 0; }
@media (max-width: 640px) { .ev { max-width: 100%; } h1 { font-size: 24px; } }
`;

const SCRIPT = `
const btn = document.getElementById('xall');
let open = false;
btn.addEventListener('click', () => {
  open = !open;
  document.querySelectorAll('.timeline details').forEach((d) => { d.open = open; });
  btn.textContent = open ? 'collapse all' : 'expand all';
});
`;

export function renderRunHtml(results: RunResults, transcripts: ReadonlyMap<string, Transcript>): string {
  const names = results.agents.map((a) => a.name);
  const agentClass = (name: string) => `agent-${Math.max(0, names.indexOf(name)) % 8}`;
  const accentRules = names.map((_, i) => `.agent-${i % 8} { --accent: var(--a${i % 8}); }`).join("\n");
  const twoSided = names.length === 2;

  // -- timeline --
  const perAgent = names.map((name, i) => {
    const t = transcripts.get(name);
    return t ? extractEvents(i, t) : [];
  });
  const timestamped = perAgent.every((evs) => evs.every((e) => typeof e.at === "string"));
  const merged = (timestamped ? mergeByTime(perAgent) : mergeByConversation(perAgent, names)).filter(
    (e) => e.kind !== "recv",
  );

  const eventHtml = merged
    .map((ev) => {
      const name = names[ev.agent];
      const side = twoSided && ev.agent === 1 ? " side-r" : "";
      const cls = agentClass(name);
      if (ev.kind === "chat") {
        const to = ev.to ? ` <span class="to">→ ${esc(ev.to)}</span>` : "";
        return `<div class="ev ${cls}${side}"><div class="who">${esc(name)}${to}</div><div class="bubble">${esc(ev.text)}</div></div>`;
      }
      if (ev.kind === "thought") {
        return `<div class="ev ${cls}${side}"><div class="who">${esc(name)} <span class="to">· thought</span></div><div class="thought">${esc(ev.text)}</div></div>`;
      }
      return `<details class="tool ${cls}"><summary>🔧 <span class="tn">${esc(name)}</span> ${esc(ev.toolName)} <span class="pv">${esc(preview(ev.input))}</span></summary><div class="io"><div class="lbl">input</div><pre>${esc(prettyJson(ev.input))}</pre><div class="lbl">output</div><pre>${esc(prettyJson(ev.output))}</pre></div></details>`;
    })
    .join("\n");

  const errorHtml = names
    .map((name) => {
      const err = transcripts.get(name)?.error;
      return err ? `<div class="ev ${agentClass(name)} agent-error">⚠ ${esc(name)}: ${esc(err)}</div>` : "";
    })
    .filter(Boolean)
    .join("\n");

  // -- header / summary --
  const pass = results.verdict?.pass;
  const badge =
    pass === undefined ? "" : `<span class="badge ${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span>`;
  const meta = [
    results.startedAt && new Date(results.startedAt).toUTCString().replace("GMT", "UTC"),
    results.durationSeconds !== undefined && `${results.durationSeconds}s`,
    timestamped ? "chronological" : "conversation-ordered",
  ]
    .filter(Boolean)
    .join(" · ");
  const chips = results.agents
    .map(
      (a) =>
        `<span class="chip ${agentClass(a.name)}"><b>● ${esc(a.name)}</b> <span class="sub">${esc(a.provider)}/${esc(a.model)}</span></span>`,
    )
    .join("\n");

  const verdictCells: string[] = [];
  if (results.verdict) {
    if (results.verdict.timedOut) verdictCells.push(`<span class="cell bad"><span class="mark">✗</span> timed out</span>`);
    else if (!results.verdict.allAgentsExitedClean)
      verdictCells.push(`<span class="cell bad"><span class="mark">✗</span> unclean exit</span>`);
    else verdictCells.push(`<span class="cell ok"><span class="mark">✓</span> clean exits</span>`);
    for (const r of results.verdict.rules) {
      const bounds = [r.min !== undefined && `≥ ${r.min}`, r.max !== undefined && `≤ ${r.max}`].filter(Boolean).join(", ");
      verdictCells.push(
        `<span class="cell ${r.pass ? "ok" : "bad"}"><span class="mark">${r.pass ? "✓" : "✗"}</span> ${esc(r.agent)} ${esc(r.asset)} Δ ${fmtDelta(r.delta)} (${bounds || "any"})</span>`,
      );
    }
  }

  let balancesHtml = "";
  if (results.balances) {
    const assets = results.assets?.map((a) => a.symbol) ?? Object.keys(Object.values(results.balances.before)[0] ?? {});
    const rows = names
      .flatMap((name) =>
        assets.map((sym) => {
          const before = results.balances!.before[name]?.[sym];
          const after = results.balances!.after[name]?.[sym];
          const delta = results.balances!.delta[name]?.[sym] ?? 0;
          const dCls = delta > 0 ? "pos" : delta < 0 ? "neg" : "";
          return `<tr><td class="${agentClass(name)}" style="color:var(--accent)">${esc(name)}</td><td>${esc(sym)}</td><td class="r">${before ?? "?"}</td><td class="r">${after ?? "?"}</td><td class="r ${dCls}">${fmtDelta(delta)}</td></tr>`;
        }),
      )
      .join("\n");
    balancesHtml = `<details class="panel" open><summary>Balances</summary><div><table><thead><tr><th>agent</th><th>asset</th><th class="r">before</th><th class="r">after</th><th class="r">Δ</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  }

  const usageRows = results.agents
    .map((a) => {
      const u = a.totalUsage;
      const t = transcripts.get(a.name);
      const finish = a.finishReason ?? t?.finishReason ?? (t?.error ? "error" : "?");
      return `<tr><td class="${agentClass(a.name)}" style="color:var(--accent)">${esc(a.name)}</td><td>${esc(finish)}</td><td class="r">${a.steps ?? t?.steps.length ?? "?"}</td><td class="r">${num(u?.inputTokens)}</td><td class="r">${num(u?.cachedInputTokens)}</td><td class="r">${num(u?.outputTokens)}</td><td class="r">${num(u?.reasoningTokens)}</td><td class="r">${num(u?.totalTokens)}</td></tr>`;
    })
    .join("\n");
  const usageHtml = `<details class="panel"><summary>Agents &amp; token usage</summary><div><table><thead><tr><th>agent</th><th>finish</th><th class="r">steps</th><th class="r">in</th><th class="r">cached</th><th class="r">out</th><th class="r">reasoning</th><th class="r">total</th></tr></thead><tbody>${usageRows}</tbody></table></div></details>`;

  const promptSections = names
    .map((name) => {
      const t = transcripts.get(name);
      if (!t?.system && !t?.prompt) return "";
      const parts = [
        t.prompt && `<div class="lbl">task</div><pre>${esc(t.prompt)}</pre>`,
        t.system && `<div class="lbl">system</div><pre>${esc(t.system)}</pre>`,
      ]
        .filter(Boolean)
        .join("\n");
      return `<details class="tool ${agentClass(name)}"><summary><span class="tn">${esc(name)}</span> <span class="pv">${esc(preview(t.prompt ?? t.system ?? ""))}</span></summary><div class="io">${parts}</div></details>`;
    })
    .filter(Boolean)
    .join("\n");
  const promptsHtml = promptSections
    ? `<details class="panel"><summary>Prompts</summary><div>${promptSections}</div></details>`
    : "";

  const footer = results.agents
    .map((a) => {
      // exitCode null = killed by signal; undefined = unknown (e.g. rendered from a bare run dir)
      const exit = a.exitCode === undefined ? "" : ` · exit ${a.exitCode ?? "killed"}`;
      return `<div>${esc(a.name)}${exit}${a.timedOut ? " · timed out" : ""}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(results.experiment)} · ${esc(results.runId)}</title>
<style>${STYLE}
${accentRules}</style>
</head>
<body>
<div class="wrap">
<header>
<div class="eyebrow">Mosaic agent experiment</div>
<h1>${esc(results.experiment)} ${badge} <span class="run-id">run ${esc(results.runId)}</span></h1>
<div class="meta">${esc(meta)}</div>
<div class="chips">${chips}</div>
</header>
${verdictCells.length ? `<section class="tape">${verdictCells.join("\n")}</section>` : ""}
${balancesHtml}
${usageHtml}
${promptsHtml}
<div class="tl-head"><h2>Transcript</h2><button id="xall" type="button">expand all</button></div>
<main class="timeline">
${eventHtml}
${errorHtml}
</main>
<footer>
${footer}
${results.runDir ? `<div>run dir ${esc(results.runDir)}</div>` : ""}
</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// --- CLI ---------------------------------------------------------------------------------------

function loadTranscripts(results: RunResults): Map<string, Transcript> {
  const transcripts = new Map<string, Transcript>();
  for (const a of results.agents) {
    const candidates = [a.transcript, results.runDir && join(results.runDir, `${a.name}.transcript.json`)];
    for (const p of candidates) {
      if (!p) continue;
      try {
        transcripts.set(a.name, JSON.parse(readFileSync(p, "utf8")) as Transcript);
        break;
      } catch {
        // try the next candidate
      }
    }
  }
  return transcripts;
}

/** A run dir without a results file (crashed run): synthesize a minimal results object. */
function synthesizeFromRunDir(dir: string): RunResults {
  const files = readdirSync(dir).filter((f) => f.endsWith(".transcript.json"));
  if (files.length === 0) throw new Error(`no *.transcript.json files in ${dir}`);
  const agents: AgentOutcome[] = files.map((f) => {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript;
    return {
      name: t.name,
      provider: t.provider,
      model: t.model,
      finishReason: t.finishReason,
      steps: t.steps.length,
      totalUsage: t.totalUsage,
      transcript: join(dir, f),
    };
  });
  return { experiment: basename(dirname(dir)), runId: basename(dir), agents, runDir: dir };
}

function renderPath(arg: string): string {
  const path = resolve(arg);
  let results: RunResults;
  let htmlPath: string;
  if (statSync(path).isDirectory()) {
    results = synthesizeFromRunDir(path);
    htmlPath = join(path, "transcript.html");
  } else {
    results = JSON.parse(readFileSync(path, "utf8")) as RunResults;
    htmlPath = path.replace(/\.json$/, "") + ".html";
  }
  writeFileSync(htmlPath, renderRunHtml(results, loadTranscripts(results)));
  return htmlPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node dist/render.js <results/<file>.json | runDir> [...more]");
    process.exit(2);
  }
  for (const arg of args) console.log(`transcript → ${renderPath(arg)}`);
}
