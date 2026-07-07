// Provider abstraction: one factory that turns (provider, apiKey, model) into a Vercel AI SDK
// LanguageModel, so the agent loop and the preflight ping are identical for Anthropic and OpenAI.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import type { Provider } from "./experiment.js";

export const DEFAULT_API_KEY_ENV: Record<Provider, string> = {
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

/**
 * The provider's server-side web-search tool under the same `web_search` name for both providers,
 * so transcripts and prompts stay provider-agnostic. Executed by the provider (billed per search);
 * capped to keep a runaway agent from racking up search fees. OpenAI's variant needs the Responses
 * API, which is what `createOpenAI(...)(model)` returns.
 */
export function webSearchTools(provider: Provider, apiKey: string): ToolSet {
  switch (provider) {
    case "anthropic":
      return { web_search: createAnthropic({ apiKey }).tools.webSearch_20250305({ maxUses: 5 }) };
    case "openai":
      return { web_search: createOpenAI({ apiKey }).tools.webSearch() };
  }
}

/** Cheap end-to-end check that the key is valid and the model id exists (a few tokens). */
export async function pingModel(provider: Provider, apiKey: string, model: string): Promise<void> {
  await generateText({
    model: languageModel(provider, apiKey, model),
    prompt: "Reply with the single word: pong",
    maxOutputTokens: 64,
    maxRetries: 1,
  });
}
