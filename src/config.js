import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { legacyModelSection } from "./model/catalog.js";

/**
 * 動作設定の契約。hive.config.json(同梱物)に hive.local.json(書き込み可能側の上書き)を
 * 統合し、パスを絶対解決した実行時の形。loadConfig()が返す。
 * @typedef {Object} HiveConfig
 * @property {{baseUrl: string, apiKeyEnv?: string|null, apiKeyFile?: string, apiKey: string|null, model: string, fallbackModels?: string[], temperature?: number, maxTokens?: number, timeoutMs?: number, contextWindow?: number, reasoningEffort?: string|null, webSearch?: boolean|object|null}} model OpenAI互換エンドポイントへの接続設定(apiKeyはenv/鍵ファイルから解決した実値)。旧形設定では生の値、新形models設定からは既定プロバイダから合成される
 * @property {{default: string|null, fallbacks: string[]|null, providers: Object.<string, Object>}} models 新形のモデル設定。providers.<id>={baseUrl, api(ワイヤ形式), auth:{env|file|value}, params, models[]}。旧modelセクションがある場合は"default"プロバイダとして読み替えて統合される
 * @property {string} workspace ワークスペースの絶対パス(開発時はリポジトリ直下・梱包時はuserData配下)
 * @property {{dir: string}} worktrees エージェント作業用worktreeのルート
 * @property {Array<{id: string, displayName: string, role: string, persona?: string, personaPath?: string}>} agents 参加エージェントの定義
 * @property {{maxTurns?: number}} loop
 * @property {{timeoutSec?: number}} runner
 * @property {{port: number, monitorPort: number, monitorHost: string}} ui UI/モニタのポート(HIVE_UI_PORT/HIVE_MONITOR_PORTで上書き可)
 * @property {{intervalSec?: number, testCommand?: string|null, probes?: {tests?: "smoke"|"full"|"off"}}} discovery 発見器(テストプローブ等)の設定。testCommand省略時は軽量スモーク(単一テスト)を回す。probes.tests="full"でフルスイート(旧挙動=テストコマンド明示と同義)、"off"で停止
 * @property {{testMaxConcurrent?: number}} exec テスト実行系の設定。testMaxConcurrentはテスト系コマンドのプロセス横断同時実行上限(既定1=直列)。複数ワーカーの検証+発見器プローブの重なりでマシンが飽和するのを防ぐ
 * @property {{testMaxConcurrent?: number}} exec テスト系コマンド(npm test/node --test)のプロセス横断セマフォ上限(未設定で1。テスト以外のコマンドには影響しない)
 * @property {{askTimeoutSec?: number}} permissions
 * @property {{maxTokensPerRun?: number}} budget 1ランあたりのトークン上限
 * @property {{thresholdPercent?: number, keepRecentToolResults?: number}} compact 圧縮の設定
 * @property {{longTaskSec?: number, stop?: boolean, stallSec?: number}} notify CLI通知(#11)の設定。longTaskSecは長時間タスク完了通知の閾値秒(既定600)。stop=falseで停止系通知(自動継続停止/ツール失敗/予算/ラウンド静止)を止める(既定true)。stallSecはラウンド静止検出の無活動秒(既定600)
 * @property {{maxDepth?: number, maxConcurrent?: number}} hierarchy
 * @property {{lead?: string, workers?: string[], mains?: string[], idleClaimWaitSec?: number, autoscale?: boolean, autoscaleIntervalSec?: number, maxWorkersPerThread?: number, maxTurnsPerRound?: number, autoContinueRounds?: number, staggerMs?: number, memMaxMessages?: number, schedules?: Array<{everyMinutes: number, text: string, thread?: string}>, budgetAlertUsd?: number, requireSeparateApprove?: boolean}} chat チャット運用の設定(予算アラートは累積コストがこのしきい値を超えると1回告知。requireSeparateApprove=trueでfinish_task時に実装者以外の検証タスクを起票し、approve_taskでの承認済みタスクだけをマージする)
 * @property {{servers: Object.<string, Object>}} mcp
 * @property {Object} hooks
 * @property {Object} commands
 * @property {{name?: string, seedFiles?: Array<{path: string, content: string}>}} scenario
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 書き込み可能データの基準。梱包実行時(desktop/main.jsがHIVE_DATAを設定)はuserData配下、
// 開発時はリポジトリ直下。設定JSONと personas(agents/*.md)は読み取り専用なのでROOTのまま。
// import順に関わらず呼び出し時に解決したいので定数でなく関数で持つ
export function dataDir() {
  return process.env.HIVE_DATA ? resolve(process.env.HIVE_DATA) : ROOT;
}

/** @param {string} [configPath] ROOT起点の設定ファイルパス(省略でhive.config.json)
 * @returns {HiveConfig} */
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
    models: { default: null, fallbacks: null, providers: {} },
    workspace: resolve(DATA, local.workspace ?? raw.workspace ?? "workspace"),
    worktrees: { dir: resolve(DATA, local.worktreesDir ?? raw.worktrees?.dir ?? "worktrees") },
    agents: (raw.agents ?? []).map((a) => ({ ...a, personaPath: resolve(ROOT, a.persona ?? `agents/${a.id}.md`) })),
    loop: { maxTurns: 30, ...(raw.loop ?? {}) },
    runner: { timeoutSec: 480, ...(raw.runner ?? {}) },
    ui: { port: 7789, monitorPort: 7791, monitorHost: "0.0.0.0", ...(raw.ui ?? {}) },
    discovery: { intervalSec: 30, testCommand: null, probes: { tests: "smoke" }, ...(raw.discovery ?? {}) },
    exec: { testMaxConcurrent: 1, ...(raw.exec ?? {}) },
    permissions: {
      askTimeoutSec: 120,
      ...(raw.permissions ?? {}),
    },
    budget: { maxTokensPerRun: 2000000, ...(raw.budget ?? {}) },
    compact: { thresholdPercent: 90, keepRecentToolResults: 5, ...(raw.compact ?? {}) },
    // CLI通知(#11): 長時間タスク完了の閾値(claimedからの経過秒)。hive.local.jsonで上書き可
    notify: { longTaskSec: 600, stop: true, stallSec: 600, ...(raw.notify ?? {}) },
    hierarchy: { maxDepth: 2, maxConcurrent: 6, ...(raw.hierarchy ?? {}) },
    chat: { mains: ["alpha", "beta", "gamma"], maxTurnsPerRound: 12, ...(raw.chat ?? {}) },
    mcp: { servers: { ...(raw.mcp?.servers ?? {}), ...(local.mcp?.servers ?? {}) } }, // local.json側で追加/上書きできる
    hooks: raw.hooks ?? {},
    commands: raw.commands ?? {},
    scenario: { seedFiles: [], ...raw.scenario },
  };
  cfg.models = buildModelsCfg(raw);
  // cfg.modelは旧形設定があればそのまま、無ければ新形modelsから合成する。
  // ui/server.js・monitor・index.html がconfig.modelを参照し続けるための橋。
  if (!raw.model?.baseUrl) {
    cfg.model = { ...legacyModelSection(cfg.models, [ROOT, DATA]) };
  }
  cfg.model.apiKey = resolveApiKey(cfg.model);
  // ポートの環境変数上書き(開発サーバーと並行して梱包アプリ/SMOKEを動かすときの衝突避け)
  if (process.env.HIVE_UI_PORT) cfg.ui.port = Number(process.env.HIVE_UI_PORT) || cfg.ui.port;
  if (process.env.HIVE_MONITOR_PORT) cfg.ui.monitorPort = Number(process.env.HIVE_MONITOR_PORT) || cfg.ui.monitorPort;
  return cfg;
}

/** 旧形modelセクションを新形modelsへ読み替えて統合する。
 * 旧形は"default"プロバイダ(ベアIDの補完先)として合成し、既定ref・フォールバックも補う。 */
function buildModelsCfg(raw) {
  const out = {
    default: raw.models?.default ?? null,
    fallbacks: raw.models?.fallbacks ?? null,
    providers: { ...(raw.models?.providers ?? {}) },
  };
  const m = raw.model;
  if (m?.baseUrl) {
    out.providers.default = {
      id: "default",
      baseUrl: m.baseUrl,
      api: m.api ?? "openai-completions",
      auth: { env: m.apiKeyEnv ?? "OPENAI_API_KEY", ...(m.apiKeyFile ? { file: m.apiKeyFile } : {}) },
      params: {
        temperature: m.temperature, maxTokens: m.maxTokens, timeoutMs: m.timeoutMs,
        contextWindow: m.contextWindow, reasoningEffort: m.reasoningEffort, webSearch: m.webSearch,
      },
      models: [],
    };
    if (!out.default) out.default = `default/${m.model}`;
    if ((!out.fallbacks || !out.fallbacks.length) && m.fallbackModels?.length) {
      out.fallbacks = m.fallbackModels.map((x) => `default/${x}`);
    }
  }
  return out;
}

function resolveApiKey(modelCfg) {
  // apiKeyEnv === null は「envを見ない」の明示(新形auth.env未指定時にOPENAI_API_KEYを
  // 誤って拾わないため)。旧形の既定(OPENAI_API_KEY)は維持
  const envName = modelCfg.apiKeyEnv === null ? null : (modelCfg.apiKeyEnv ?? "OPENAI_API_KEY");
  if (envName && process.env[envName]) return process.env[envName];
  if (modelCfg.apiKeyFile) {
    // 開発時はリポジトリ基準。梱包時はuserDataに鍵ファイルを置けるように両方を見る
    for (const base of [ROOT, dataDir()]) {
      const f = resolve(base, modelCfg.apiKeyFile);
      if (existsSync(f)) return readFileSync(f, "utf8").trim();
    }
  }
  return null;
}
