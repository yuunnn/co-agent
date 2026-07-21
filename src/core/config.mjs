import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configPath, dataRoot, secretsPath } from "./paths.mjs";

const THEMES = new Set(["co-agent-dark", "gruvbox-dark", "classic-light"]);

const DEFAULT_CONFIG = {
  version: 3,
  appearance: { theme: "co-agent-dark" },
  apiProviders: [],
  agentProviders: [],
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, filePath);
}

function providerId(value) {
  const normalized = String(value || "provider").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${normalized || "provider"}-${randomUUID().slice(0, 8)}`;
}

function validateProvider(input, existing = null) {
  const name = String(input.name || existing?.name || "").trim();
  const model = String(input.model || existing?.model || "").trim();
  const rawBaseUrl = String(input.baseUrl || existing?.baseUrl || "").trim().replace(/\/$/, "");
  if (!name) throw new Error("Provider name is required");
  if (!model) throw new Error("Model is required");
  let parsed;
  try { parsed = new URL(rawBaseUrl); } catch { throw new Error("Base URL must be a valid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Base URL must use HTTP or HTTPS");
  return {
    id: existing?.id || providerId(name),
    name,
    model,
    baseUrl: rawBaseUrl,
    enabled: input.enabled === undefined ? (existing?.enabled ?? false) : Boolean(input.enabled),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function detectTerminalAgentAdapter(command) {
  const executableName = path.basename(String(command || "").trim()).toLowerCase();
  if (executableName === "claude") return "claude-code";
  if (executableName === "cursor-agent") return "cursor-agent";
  if (executableName === "opencode") return "opencode";
  throw new Error("Unsupported agent command. Use claude, cursor-agent, or opencode (an absolute path is also accepted).");
}

function validateAgentProvider(input, existing = null) {
  const name = String(input.name || existing?.name || "").trim();
  const command = String(input.command || existing?.command || "").trim();
  if (!name) throw new Error("Agent name is required");
  if (!command) throw new Error("Agent command is required");
  if (/[\0\r\n]/.test(command)) throw new Error("Agent command must be one executable name or absolute path");
  const adapter = detectTerminalAgentAdapter(command);
  return {
    id: existing?.id || providerId(name),
    name,
    command,
    adapter,
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function persistedConfig(config, changes = {}) {
  return {
    version: 3,
    appearance: config.appearance,
    apiProviders: config.apiProviders.map(({ hasToken, ...provider }) => provider),
    agentProviders: config.agentProviders,
    ...changes,
  };
}

export class ConfigStore {
  async init() {
    await fs.mkdir(dataRoot, { recursive: true });
    const config = await readJson(configPath, DEFAULT_CONFIG);
    if (!THEMES.has(config.appearance?.theme)) config.appearance = { theme: DEFAULT_CONFIG.appearance.theme };
    if (!Array.isArray(config.apiProviders)) config.apiProviders = [];
    if (!Array.isArray(config.agentProviders)) config.agentProviders = [];
    config.version = 3;
    await writePrivateJson(configPath, config);
    const secrets = await readJson(secretsPath, { version: 1, apiTokens: {} });
    if (!secrets.apiTokens || typeof secrets.apiTokens !== "object") secrets.apiTokens = {};
    await writePrivateJson(secretsPath, secrets);
  }

  async read({ includeSecrets = false } = {}) {
    await this.init();
    const config = await readJson(configPath, DEFAULT_CONFIG);
    const secrets = await readJson(secretsPath, { version: 1, apiTokens: {} });
    const apiProviders = config.apiProviders.map((provider) => ({
      ...provider,
      hasToken: Boolean(secrets.apiTokens[provider.id]),
      ...(includeSecrets ? { token: secrets.apiTokens[provider.id] || "" } : {}),
    }));
    return { ...config, apiProviders };
  }

  async setTheme(theme) {
    if (!THEMES.has(theme)) throw new Error("Unknown appearance theme");
    const config = await this.read();
    const next = persistedConfig(config, { appearance: { theme } });
    await writePrivateJson(configPath, next);
    return this.read();
  }

  async upsertApiProvider(input) {
    const config = await this.read();
    const existing = input.id ? config.apiProviders.find((provider) => provider.id === input.id) : null;
    if (input.id && !existing) throw new Error("API provider not found");
    const provider = validateProvider(input, existing);
    const apiProviders = existing
      ? config.apiProviders.map((item) => item.id === provider.id ? provider : item)
      : [...config.apiProviders, provider];
    await writePrivateJson(configPath, persistedConfig(config, { apiProviders: apiProviders.map(({ hasToken, ...item }) => item) }));
    if (typeof input.token === "string" && input.token.trim()) {
      const secrets = await readJson(secretsPath, { version: 1, apiTokens: {} });
      secrets.apiTokens[provider.id] = input.token.trim();
      await writePrivateJson(secretsPath, secrets);
    }
    return this.read();
  }

  async previewApiProvider(input) {
    const config = await this.read({ includeSecrets: true });
    const existing = input.id ? config.apiProviders.find((provider) => provider.id === input.id) : null;
    if (input.id && !existing) throw new Error("API provider not found");
    const provider = validateProvider(input, existing);
    const token = String(input.token || existing?.token || "").trim();
    if (!token) throw new Error("API token is required");
    return { ...provider, token };
  }

  async removeApiProvider(id) {
    const config = await this.read();
    if (!config.apiProviders.some((provider) => provider.id === id)) throw new Error("API provider not found");
    await writePrivateJson(configPath, persistedConfig(config, { apiProviders: config.apiProviders.filter((provider) => provider.id !== id).map(({ hasToken, ...provider }) => provider) }));
    const secrets = await readJson(secretsPath, { version: 1, apiTokens: {} });
    delete secrets.apiTokens[id];
    await writePrivateJson(secretsPath, secrets);
    return this.read();
  }

  async getApiProvider(id) {
    const config = await this.read({ includeSecrets: true });
    const provider = config.apiProviders.find((item) => item.id === id);
    if (!provider) throw new Error("API provider not found");
    if (!provider.token) throw new Error("API token is not configured");
    return provider;
  }

  async getEnabledApiProviders() {
    const config = await this.read({ includeSecrets: true });
    return config.apiProviders.filter((provider) => provider.enabled && provider.token);
  }

  async getEnabledApiProvider() {
    return (await this.getEnabledApiProviders())[0] || null;
  }

  async previewAgentProvider(input) {
    const config = await this.read();
    const existing = input.id ? config.agentProviders.find((provider) => provider.id === input.id) : null;
    if (input.id && !existing) throw new Error("Agent provider not found");
    return validateAgentProvider(input, existing);
  }

  async upsertAgentProvider(input) {
    const config = await this.read();
    const existing = input.id ? config.agentProviders.find((provider) => provider.id === input.id) : null;
    if (input.id && !existing) throw new Error("Agent provider not found");
    const provider = validateAgentProvider(input, existing);
    const agentProviders = existing
      ? config.agentProviders.map((item) => item.id === provider.id ? provider : item)
      : [...config.agentProviders, provider];
    await writePrivateJson(configPath, persistedConfig(config, { agentProviders }));
    return this.read();
  }

  async removeAgentProvider(id) {
    const config = await this.read();
    if (!config.agentProviders.some((provider) => provider.id === id)) throw new Error("Agent provider not found");
    await writePrivateJson(configPath, persistedConfig(config, { agentProviders: config.agentProviders.filter((provider) => provider.id !== id) }));
    return this.read();
  }

  async getAgentProvider(id) {
    const config = await this.read();
    const provider = config.agentProviders.find((item) => item.id === id);
    if (!provider) throw new Error("Agent provider not found");
    return provider;
  }

  async getEnabledAgentProviders() {
    const config = await this.read();
    return config.agentProviders.filter((provider) => provider.enabled);
  }
}

export async function openAiCompatibleChat(provider, { messages, maxTokens = 4096, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const bodies = [
    { model: provider.model, messages, max_tokens: maxTokens },
    { model: provider.model, messages, max_completion_tokens: Math.max(256, maxTokens), thinking: { type: "disabled" } },
  ];
  let lastError = new Error("Provider returned no message content");
  for (const body of bodies) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw lastError;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    timer.unref();
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${provider.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error(`Provider returned non-JSON HTTP ${response.status}`); }
      if (!response.ok) {
        lastError = new Error(payload.error?.message || payload.message || `Provider HTTP ${response.status}`);
        if (body === bodies[0] && response.status === 400) continue;
        throw lastError;
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return { content: content.trim(), payload, durationMs: Date.now() - startedAt };
      }
      lastError = new Error("Provider returned no message content");
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function testOpenAiCompatibleProvider(provider, { timeoutMs = 45_000 } = {}) {
  const result = await openAiCompatibleChat(provider, {
    messages: [{ role: "user", content: "Reply with exactly: CO_AGENT_API_OK" }],
    maxTokens: 32,
    timeoutMs,
  });
  return {
    ok: true,
    model: result.payload.model || provider.model,
    durationMs: result.durationMs,
    response: result.content.slice(0, 160),
  };
}
