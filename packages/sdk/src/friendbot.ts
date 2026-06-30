// Testnet account funding via Friendbot — a plain HTTP GET, so it works from Node (CLI/MCP) with
// no server. This is one of the pieces that makes a backend optional for local mode.

import type { Funder } from "./ports.js";

export class FriendbotFunder implements Funder {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async fund(address: string): Promise<void> {
    const res = await fetch(`${this.url}?addr=${encodeURIComponent(address)}`);
    // 400 typically means the account already exists / is already funded — tolerate it.
    if (!res.ok && res.status !== 400) {
      throw new Error(`Friendbot funding failed for ${address}: ${res.status}`);
    }
  }
}
