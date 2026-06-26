// A simple in-memory {@link DeskProvider}. The CLI/agent registers the desks it knows (e.g. from a
// `deploy` result or a config file); a chain-events-backed provider can replace this later to read
// assets/pairs from `assetreg`/`pairreg` without prior configuration.

import type { DeskProvider } from "./ports.js";
import type { DeskConfig } from "./types.js";

export class StaticDeskProvider implements DeskProvider {
  private readonly desks = new Map<string, DeskConfig>();

  constructor(desks: DeskConfig[] = []) {
    for (const d of desks) this.desks.set(d.id, d);
  }

  register(desk: DeskConfig): void {
    this.desks.set(desk.id, desk);
  }

  async get(deskId: string): Promise<DeskConfig> {
    const d = this.desks.get(deskId);
    if (!d) throw new Error(`unknown desk: ${deskId}`);
    return d;
  }
}
