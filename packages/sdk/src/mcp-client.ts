// @mosaic/sdk/mcp-client — typed client to the Mosaic MCP server over Streamable HTTP, implementing
// the {@link McpClient} port. Used by the browser/CLI for the features that require a server (the
// Base→Stellar shield) and for authentication. Lazily connects on first use.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Amount, Field } from "./types.js";
import type { McpClient, StellarSigner } from "./ports.js";

export interface McpClientOptions {
  /** Base URL of the MCP server's Streamable-HTTP endpoint. */
  url: string;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

class HttpMcpClient implements McpClient {
  private readonly url: string;
  private client?: Client;
  private session?: string;

  constructor(url: string) {
    this.url = url;
  }

  private async connect(): Promise<Client> {
    if (!this.client) {
      const client = new Client({ name: "@mosaic/sdk", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      this.client = client;
    }
    return this.client;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = res.content.find((c) => c.type === "text")?.text;
    if (res.isError || !text) throw new Error(`MCP tool ${name} failed: ${text ?? "no result"}`);
    return JSON.parse(text) as T;
  }

  async authenticate(signer: StellarSigner): Promise<{ session: string }> {
    const address = await signer.address();
    const ch = await this.call<{ challengeId: string; message: string }>("auth_challenge", { address });
    const signature = base64(await signer.signMessage(new TextEncoder().encode(ch.message)));
    const res = await this.call<{ token: string }>("auth_verify", {
      address,
      challengeId: ch.challengeId,
      signature,
    });
    this.session = res.token;
    return { session: res.token };
  }

  async baseShield(params: {
    contractId: string;
    asset_id: number;
    amount: Amount;
    owner_tag: Field;
    baseTxHash: string;
  }): Promise<{ owner_tag: Field; txHash: string }> {
    if (!this.session) throw new Error("Call authenticate() before baseShield().");
    return this.call("base_shield", { session: this.session, ...params });
  }
}

/** Build an {@link McpClient} bound to a remote MCP server. */
export function createMcpClient(opts: McpClientOptions): McpClient {
  return new HttpMcpClient(opts.url);
}
