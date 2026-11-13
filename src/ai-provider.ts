import type { RequestUrlParam } from "obsidian";

export type AiProvider = "openai" | "openrouter";
export const OPENAI_MODEL = "gpt-6-luna";
export const OPENROUTER_MODEL = "~deepseek/deepseek-v4-flash-latest";
export const OPENAI_SECRET_ID = "hudson-openai";

export function providerName(provider: AiProvider): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}

export function aiRequest(provider: AiProvider, apiKey: string, endpoint: "chat/completions" | "embeddings", body: Record<string, unknown>): RequestUrlParam {
  const payload = { ...body };
  if (endpoint === "chat/completions" && provider === "openai") {
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
    delete payload.temperature;
    if (payload.model === OPENAI_MODEL) payload.reasoning_effort = "none";
    payload.store = false;
  }
  return {
    url: `${provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"}/${endpoint}`,
    method: "POST", throw: false,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
      ...(provider === "openrouter" ? { "X-Title": "Hudson Auto Organizer AI" } : {}) },
    body: JSON.stringify(payload)
  };
}
