// The Mosaic MCP server. Minimal first release: wallet authentication (`auth_challenge` /
// `auth_verify`) and the Base->Stellar shield (`base_shield`). Everything else runs locally in the
// browser/CLI via @mosaic/sdk, so this server stays small. Add tools here (sponsorship, durable
// queues, hosted backups) later without changing the SDK's McpClient call sites.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthService } from "./auth.js";
import { runBaseShield, type BaseShieldConfig } from "./baseShield.js";

export interface MosaicMcpOptions {
  auth?: AuthService;
  /** Base-shield configuration; when omitted, the `base_shield` tool reports it is unavailable. */
  baseShield?: BaseShieldConfig;
}

type ToolResult = { content: { type: "text"; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function createMosaicMcpServer(opts: MosaicMcpOptions = {}): McpServer {
  const auth = opts.auth ?? new AuthService();
  const server = new McpServer({ name: "mosaic-mcp", version: "0.0.0" });

  // The SDK's registerTool generic inference over zod shapes is excessively deep for strict TS; wrap
  // it with a runtime-equivalent, inference-free signature (zod still validates inputs at runtime).
  const reg = (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    handler: ToolHandler,
  ): void => {
    (server.registerTool as unknown as (n: string, c: unknown, h: ToolHandler) => void)(name, config, handler);
  };

  reg(
    "auth_challenge",
    {
      description: "Begin wallet authentication: returns a message for the given Stellar address to sign.",
      inputSchema: { address: z.string().describe("Stellar public key (G...)") },
    },
    async ({ address }) => ok(auth.challenge(address as string)),
  );

  reg(
    "auth_verify",
    {
      description: "Complete authentication: verify the signed challenge and return a session token.",
      inputSchema: {
        address: z.string(),
        challengeId: z.string(),
        signature: z.string().describe("base64 ed25519 signature over the challenge message"),
      },
    },
    async ({ address, challengeId, signature }) =>
      ok(auth.verify(address as string, challengeId as string, signature as string)),
  );

  reg(
    "base_shield",
    {
      description:
        "Base -> Stellar shield: prove the Base deposit, await finality, attest, and mint the note. Requires an authenticated session.",
      inputSchema: {
        session: z.string(),
        contractId: z.string().describe("settlement contract id (C...)"),
        asset_id: z.number(),
        amount: z.string(),
        owner_tag: z.string(),
        baseTxHash: z.string(),
      },
    },
    async (args) => {
      auth.requireSession(args.session as string);
      if (!opts.baseShield) {
        throw new Error("Base shielding is not configured on this MCP server (set MOSAIC_PROVER_DIR etc.).");
      }
      return ok(
        await runBaseShield(opts.baseShield, {
          contractId: args.contractId as string,
          asset_id: args.asset_id as number,
          amount: args.amount as string,
          owner_tag: args.owner_tag as string,
          baseTxHash: args.baseTxHash as string,
        }),
      );
    },
  );

  return server;
}
