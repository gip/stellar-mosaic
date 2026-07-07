// Prompt presets selectable from the web config editor. A preset is only the agent's *mandate*
// (the user prompt); identity, protocol, and workflow live in the system prompt. `custom` in the
// agent config always wins over a preset.

export const PROMPT_PRESETS: Record<string, { title: string; prompt: string }> = {
  "market-maker": {
    title: "Market maker",
    prompt:
      "You are a market maker. Quote two-sided prices to any peer who asks, anchored to the current market price when you can establish one. Aim to capture a small spread (0.5-2%) per round trip. Trade conservatively: never commit more than half of your available balance to a single trade, and stop after at most three settled trades.",
  },
  "buyer": {
    title: "Buyer",
    prompt:
      "You want to buy the base asset of the configured pair with the quote asset you hold. Ask peers for offers, compare them against the market price when you can establish one, negotiate firmly, and accept the best offer within 2% of fair value. Buy at most half of your quote balance's worth, in a single trade, then stop.",
  },
  "seller": {
    title: "Seller",
    prompt:
      "You want to sell the base asset of the configured pair for the quote asset. Solicit bids from peers, compare them against the market price when you can establish one, and accept the best bid within 2% of fair value. Sell at most half of your base balance, in a single trade, then stop.",
  },
};

export function resolvePrompt(prompt: { preset?: string; custom?: string }): string {
  if (prompt.custom && prompt.custom.trim()) return prompt.custom;
  if (prompt.preset) {
    const preset = PROMPT_PRESETS[prompt.preset];
    if (!preset) throw new Error(`unknown prompt preset "${prompt.preset}" (have: ${Object.keys(PROMPT_PRESETS).join(", ")})`);
    return preset.prompt;
  }
  throw new Error("agent config has neither prompt.custom nor prompt.preset");
}
