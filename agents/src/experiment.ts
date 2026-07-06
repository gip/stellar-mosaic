// Experiment configuration: one YAML/JSON file per experiment describes the cast of agents
// (provider, model, prompt, identities) and the pass/fail verdict rules. `${VAR}` references in
// any string value are interpolated from the environment so API keys never live in the file.
// `loadExperiment` parses + validates; the resolved per-agent handoff written by the orchestrator
// for each child process is `ResolvedAgentFile`.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@mosaic/sdk";

export type Provider = "anthropic" | "openai";

const DEFAULT_MAX_TURNS = 80;
/** Wall-clock cap for the agent phase. Proofs take 1-5 min each; a 2-agent run is ~10-20 min. */
const DEFAULT_TIMEOUT_MINUTES = 45;

export const DEFAULT_NETWORK = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET as string,
  friendbotUrl: "https://friendbot.stellar.org",
};

const hexKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex key");

const decimalAmount = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/, "expected a decimal amount string, e.g. \"100\" or \"1.5\"");

const agentSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/i, "agent name must be alphanumeric/-/_ and start with a letter"),
  provider: z.enum(["anthropic", "openai"]),
  /** Omit to fall back to ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment. */
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
  /** The agent's trading mandate — becomes its task prompt. */
  prompt: z.string().min(1),
  /** Enable the provider's native web-search tool (Anthropic web_search / OpenAI Responses web search). */
  webSearch: z.boolean().optional(),
  /** Funded Stellar secret (S...). Omit to generate a fresh keypair funded via friendbot. */
  stellarSecret: z.string().regex(/^S[A-Z2-7]{55}$/, "expected a Stellar secret seed (S...)").optional(),
  /** Ethereum private key (XMTP identity). Omit to generate one. */
  ethKey: hexKey.optional(),
  /** Starting inventory the provisioner must arrange (demo USDC issued at provision time). */
  funding: z.object({ usdc: decimalAmount.optional() }).optional(),
});

const verdictRuleSchema = z
  .object({
    agent: z.string(),
    asset: z.enum(["XLM", "USDC"]),
    /** Minimum acceptable balance delta (decimal string, may be negative). */
    min: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/).optional(),
    /** Maximum acceptable balance delta. */
    max: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/).optional(),
  })
  .refine((r) => r.min !== undefined || r.max !== undefined, {
    message: "a verdict rule needs at least one of min/max",
  });

const experimentSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, "experiment name must be filesystem-friendly")
    .optional(),
  network: z
    .object({
      horizonUrl: z.string().url().optional(),
      rpcUrl: z.string().url().optional(),
      networkPassphrase: z.string().optional(),
      friendbotUrl: z.string().url().optional(),
    })
    .optional(),
  maxTurns: z.number().int().min(4).max(400).optional(),
  /** Wall-clock cap in minutes for the agent phase; stragglers are killed and the run FAILs. */
  timeoutMinutes: z.number().min(0.1).max(720).optional(),
  agents: z.array(agentSchema).min(2, "an experiment needs at least 2 agents"),
  verdict: z.array(verdictRuleSchema).optional(),
});

export type AgentSpec = z.infer<typeof agentSchema>;
export type VerdictRule = z.infer<typeof verdictRuleSchema>;

export interface ExperimentConfig {
  name: string;
  network: typeof DEFAULT_NETWORK;
  maxTurns: number;
  timeoutMinutes: number;
  agents: AgentSpec[];
  verdict: VerdictRule[];
}

/** Replace ${VAR} in every string value; unset variables are an error (fail before spending). */
function interpolateEnv(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`${path}: environment variable ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, `${path}.${k}`)]),
    );
  }
  return value;
}

export function loadExperiment(filePath: string): ExperimentConfig {
  const raw = parseYaml(readFileSync(filePath, "utf8")) as unknown; // YAML is a superset of JSON
  const interpolated = interpolateEnv(raw, basename(filePath));
  const parsed = experimentSchema.safeParse(interpolated);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid experiment config ${filePath}:\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;

  const names = cfg.agents.map((a) => a.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new Error(`agent names must be unique (got ${names.join(", ")})`);
  }

  for (const rule of cfg.verdict ?? []) {
    if (!names.includes(rule.agent.toLowerCase())) {
      throw new Error(`verdict rule references unknown agent "${rule.agent}"`);
    }
  }

  return {
    name: cfg.name ?? basename(filePath).replace(/\.(ya?ml|json)$/i, ""),
    network: { ...DEFAULT_NETWORK, ...(cfg.network ?? {}) },
    maxTurns: cfg.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutMinutes: cfg.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    agents: cfg.agents,
    verdict: cfg.verdict ?? [],
  };
}

/** Everything one agent child process needs, written to `<runDir>/<name>.agent.json`. */
export interface ResolvedAgentFile {
  experiment: string;
  name: string;
  provider: Provider;
  apiKey: string;
  model: string;
  prompt: string;
  webSearch: boolean;
  maxTurns: number;
  stellarSecret: string;
  stellarAddress: string;
  ethKey: `0x${string}`;
  ethAddress: `0x${string}`;
  xmtpDbKey: `0x${string}`;
  peers: { name: string; ethAddress: `0x${string}` }[];
  usdcIssuer: string;
  network: NetworkConfig;
  horizonUrl: string;
  /** Per-run scratch dir: note DBs, XMTP DBs, transcripts. */
  runDir: string;
}
