import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 書き込み可能データの基準。梱包実行時(desktop/main.jsがHIVE_DATAを設定)はuserData配下、
// 開発時はリポジトリ直下。設定JSONと personas(agents/*.md)は読み取り専用なのでROOTのまま。
// import順に関わらず呼び出し時に解決したいので定数でなく関数で持つ
export function dataDir() {
  return process.env.HIVE_DATA ? resolve(process.env.HIVE_DATA) : ROOT;
}

export function loadConfig(configPath) {
  const DATA = dataDir();
  const p = configPath ? resolve(ROOT, configPath) : resolve(ROOT, "hive.config.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  // ローカル上書き(hive.local.json: フォルダ選択で生成)。無ければ何もしない
  let local = {};
  const localPath = resolve(DATA, "hive.local.json");
  if (existsSync(localPath)) {
    try { local = JSON.parse(readFileSync(localPath, "utf8")); } catch {}
  }
  const cfg = {
    model: { temperature: 0.7, maxTokens: 2000, timeoutMs: 120000, contextWindow: 200000, reasoningEffort: null, ...(raw.model ?? {}) },
    workspace: resolve(DATA, local.workspace ?? raw.workspace ?? "workspace"),
    worktrees: { dir: resolve(DATA, local.worktreesDir ?? raw.worktrees?.dir ?? "worktrees") },
    agents: (raw.agents ?? []).map((a) => ({ ...a, personaPath: resolve(ROOT, a.persona ?? `agents/${a.id}.md`) })),
    loop: { maxTurns: 30, ...(raw.loop ?? {}) },
    runner: { timeoutSec: 480, ...(raw.runner ?? {}) },
    ui: { port: 7789, monitorPort: 7791, monitorHost: "0.0.0.0", ...(raw.ui ?? {}) },
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
    commands: raw.commands ?? {},
    scenario: { seedFiles: [], ...raw.scenario },
  };
  cfg.model.apiKey = resolveApiKey(cfg.model);
  return cfg;
}

function resolveApiKey(modelCfg) {
  if (process.env[modelCfg.apiKeyEnv ?? "OPENAI_API_KEY"]) return process.env[modelCfg.apiKeyEnv];
  if (modelCfg.apiKeyFile) {
    // 開発時はリポジトリ基準。梱包時はuserDataに鍵ファイルを置けるように両方を見る
    for (const base of [ROOT, dataDir()]) {
      const f = resolve(base, modelCfg.apiKeyFile);
      if (existsSync(f)) return readFileSync(f, "utf8").trim();
    }
  }
  return null;
}
