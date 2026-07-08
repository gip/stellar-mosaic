// Provider abstraction, adapted from agents/src/llm.ts: (provider, apiKey, model) → a Vercel AI
// SDK LanguageModel, identical loop for Anthropic and OpenAI.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, ToolSet } from "ai";

export type Provider = "anthropic" | "openai";

export const API_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function languageModel(provider: Provider, apiKey: string, model: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "openai":
      return createOpenAI({ apiKey })(model);
  }
}

/** The provider's server-side web-search tool under one `web_search` name (billed per search;
 *  capped so a runaway agent cannot rack up fees). */
export function webSearchTools(provider: Provider, apiKey: string): ToolSet {
  switch (provider) {
    case "anthropic":
      return { web_search: createAnthropic({ apiKey }).tools.webSearch_20250305({ maxUses: 5 }) };
    case "openai":
      return { web_search: createOpenAI({ apiKey }).tools.webSearch() };
  }
}
