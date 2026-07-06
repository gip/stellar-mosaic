// Provider abstraction: one factory that turns (provider, apiKey, model) into a Vercel AI SDK
// LanguageModel, so the agent loop and the preflight ping are identical for Anthropic and OpenAI.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
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

/** Cheap end-to-end check that the key is valid and the model id exists (a few tokens). */
export async function pingModel(provider: Provider, apiKey: string, model: string): Promise<void> {
  await generateText({
    model: languageModel(provider, apiKey, model),
    prompt: "Reply with the single word: pong",
    maxOutputTokens: 64,
    maxRetries: 1,
  });
}
