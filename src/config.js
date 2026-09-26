import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(configPath) {
  const p = configPath ? resolve(ROOT, configPath) : resolve(ROOT, "hive.config.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const cfg = {
    model: { temperature: 0.7, maxTokens: 2000, timeoutMs: 120000, contextWindow: 200000, reasoningEffort: null, ...(raw.model ?? {}) },
    workspace: resolve(ROOT, raw.workspace ?? "workspace"),
    agents: (raw.agents ?? []).map((a) => ({ ...a, personaPath: resolve(ROOT, a.persona ?? `agents/${a.id}.md`) })),
    loop: { maxTurns: 30, ...(raw.loop ?? {}) },
    runner: { timeoutSec: 480, ...(raw.runner ?? {}) },
    ui: { port: 7789, ...(raw.ui ?? {}) },
    discovery: { intervalSec: 30, testCommand: null, ...(raw.discovery ?? {}) },
    permissions: {
      askTimeoutSec: 120,
      ...(raw.permissions ?? {}),
    },
    budget: { maxTokensPerRun: 2000000, ...(raw.budget ?? {}) },
    compact: { thresholdPercent: 90, keepRecentToolResults: 5, ...(raw.compact ?? {}) },
    hierarchy: { maxDepth: 2, maxConcurrent: 6, ...(raw.hierarchy ?? {}) },
    chat: { mains: ["alpha", "beta", "gamma"], maxTurnsPerRound: 12, ...(raw.chat ?? {}) },
    mcp: raw.mcp ?? { servers: {} },
    hooks: raw.hooks ?? {},
    scenario: { seedFiles: [], ...raw.scenario },
  };
  cfg.model.apiKey = resolveApiKey(cfg.model);
  return cfg;
}

function resolveApiKey(modelCfg) {
  if (process.env[modelCfg.apiKeyEnv ?? "OPENAI_API_KEY"]) return process.env[modelCfg.apiKeyEnv];
  if (modelCfg.apiKeyFile) {
    const f = resolve(ROOT, modelCfg.apiKeyFile);
    if (existsSync(f)) return readFileSync(f, "utf8").trim();
  }
  return null;
}
