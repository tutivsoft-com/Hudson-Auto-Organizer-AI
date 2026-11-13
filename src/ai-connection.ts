import type { App } from "obsidian";
import { diagnostics } from "./diagnostics";
import type { AutoOrganizerSettings } from "./types";
import { getOpenRouterApiKey } from "./openrouter";
import { AiProvider, OPENAI_MODEL, OPENAI_SECRET_ID, OPENROUTER_MODEL } from "./ai-provider";

export async function getAiConnection(app: App, settings: AutoOrganizerSettings, pluginDir?: string): Promise<{ apiKey: string; provider: AiProvider; model: string }> {
  const provider = settings.aiProvider === "openrouter" ? "openrouter" : "openai";
  diagnostics.event("ai.connection", { provider });
  if (provider === "openrouter") return { provider, apiKey: await getOpenRouterApiKey(), model: settings.model || OPENROUTER_MODEL };
  let apiKey = app.secretStorage?.getSecret(OPENAI_SECRET_ID)?.trim() || "";
  if (!apiKey && pluginDir) {
    // Optional owner-only provisioning file. Never bundle or publish this file.
    try {
      const path = `${pluginDir}/private/openai.json`;
      if (await app.vault.adapter.exists(path)) {
        const saved = JSON.parse(await app.vault.adapter.read(path));
        if (typeof saved.apiKey === "string") apiKey = saved.apiKey.trim();
        if (apiKey) app.secretStorage?.setSecret(OPENAI_SECRET_ID, apiKey);
      }
    } catch { throw new Error("OpenAI key setup could not be read. Use the OpenAI key control in Settings."); }
  }
  if (!/^sk-(?!or-)[A-Za-z0-9_-]{20,}$/.test(apiKey)) throw new Error("Add the OpenAI key in Hudson Settings before using AI.");
  return { provider, apiKey, model: settings.openaiModel || OPENAI_MODEL };
}
