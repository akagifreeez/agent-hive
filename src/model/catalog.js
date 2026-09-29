/**
 * モデルカタログ: 内蔵(builtin.js)+設定(models.providers)をマージし、
 * ModelRefを実行時のModelSpecへ解決する。OpenClaw ModelRegistryの最小版。
 * プロバイダ(認証・baseUrlの名前空間)とapi(ワイヤ形式)は直交する。
 * @typedef {{id: string, baseUrl: string, api: string, name?: string, auth?: {env?: string, file?: string, value?: string}, params?: {temperature?: number, maxTokens?: number, timeoutMs?: number, contextWindow?: number, reasoningEffort?: string, webSearch?: boolean|object|null}, models?: Array<{id: string, name?: string, contextWindow?: number, maxTokens?: number, reasoning?: boolean, reasoningEffort?: string, cost?: {input?: number, output?: number}|null}>}} ProviderCfg
 * @typedef {{id: string, name?: string, contextWindow?: number, maxTokens?: number, reasoning?: boolean, reasoningEffort?: string, cost?: {input?: number, output?: number, cacheRead?: number, cacheWrite?: number}|null}} ModelRow
 * @typedef {{provider: ProviderCfg, model: {id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, reasoningEffort: string|null, cost: {input?: number, output?: number, cacheRead?: number, cacheWrite?: number}|null}}} ModelSpec
 * @typedef {{default?: string|null, fallbacks?: string[]|null, providers?: Record<string, Object>}} ModelsCfg
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_PROVIDERS } from "./builtin.js";
import { parseModelRef, formatModelRef } from "./ref.js";

/** 内蔵カタログを土台に設定をマージする。
 * @param {ModelsCfg} [modelsCfg]
 * @returns {{providers: Record<string, ProviderCfg>, defaultRef: string|null, fallbackRefs: string[]}} */
export function buildCatalog(modelsCfg = {}) {
  const providers = {};
  for (const [id, p] of Object.entries(BUILTIN_PROVIDERS)) {
    providers[id] = { id, ...p, models: [...p.models] };
  }
  for (const [id, p] of Object.entries(modelsCfg.providers ?? {})) {
    providers[id] = { ...providers[id], id, ...p, models: (p.models ?? providers[id]?.models ?? []).map((m) => ({ ...m })) };
  }
  return { providers, defaultRef: modelsCfg.default ?? null, fallbackRefs: modelsCfg.fallbacks ?? [] };
}

/** ベアIDのときの既定プロバイダを推定する(内蔵+設定の一意一致 → 既定ref、の順)。
 * 例: builtinにclaude-*を持つ状態でdefaultがzaiでも、"claude-sonnet-5-5"はanthropicへ向く。
 * @param {ReturnType<typeof buildCatalog>} catalog @param {string} ref ModelRefまたはベアID */
function guessProvider(catalog, ref) {
  const bare = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  const hits = Object.values(catalog.providers).filter((p) => (p.models ?? []).some((m) => m.id === bare));
  if (hits.length === 1) return hits[0].id;
  if (catalog.defaultRef) {
    const i = catalog.defaultRef.indexOf("/");
    if (i > 0) return catalog.defaultRef.slice(0, i);
  }
  return null;
}

/** ModelRef(またはベアID)をModelSpecへ解決する。カタログ行が無いモデルは既定値で動く。
 * @param {ReturnType<typeof buildCatalog>} catalog
 * @param {string|null} [refStr] 未指定=既定モデル
 * @returns {ModelSpec} */
export function resolveModel(catalog, refStr = null) {
  const eff = refStr ?? catalog.defaultRef;
  if (!eff) throw new Error("既定モデルが未設定です(models.default または旧 model.model を設定してください)");
  const s = String(eff).trim();
  const { provider: pid, model } = parseModelRef(s, guessProvider(catalog, s));
  const p = catalog.providers[pid];
  if (!p) throw new Error(`未知のプロバイダ "${pid}"(利用可能: ${Object.keys(catalog.providers).join(", ")})`);
  /** @type {ModelRow} */
  const noRow = { id: model };
  const row = (p.models ?? []).find((m) => m.id === model) ?? noRow;
  return {
    provider: p,
    model: {
      id: model,
      name: row.name ?? model,
      contextWindow: row.contextWindow ?? p.params?.contextWindow ?? 200000,
      maxTokens: row.maxTokens ?? p.params?.maxTokens ?? 2000,
      reasoning: row.reasoning ?? false,
      reasoningEffort: row.reasoningEffort ?? null,
      cost: row.cost ?? null,
    },
  };
}

/** プロバイダの認証値を解決する(value > env > file)。旧resolveApiKeyの一般化。
 * fileはROOTとdataDir両方を試す(開発時はリポジトリ基準・梱包時はuserData基準)。
 * @param {ProviderCfg} provider @param {string[]} [baseDirs] @returns {string|null} */
export function resolveAuthValue(provider, baseDirs = []) {
  const a = provider.auth ?? {};
  if (a.value) return a.value;
  if (a.env && process.env[a.env]) return process.env[a.env];
  if (a.file) {
    for (const base of baseDirs) {
      const f = resolve(base, a.file);
      if (existsSync(f)) {
        try { return readFileSync(f, "utf8").trim() || null; } catch { return null; }
      }
    }
  }
  return null;
}

/** 新形models設定から旧形modelセクションの形を合成する。config.modelを参照する
 * 既存コード(ui/server.js・monitor・index.html)を無修正で動かすための橋。
 * @param {ModelsCfg} modelsCfg @param {string[]} [baseDirs] @returns {Object} */
export function legacyModelSection(modelsCfg, baseDirs = []) {
  const cat = buildCatalog(modelsCfg);
  if (!cat.defaultRef) return { baseUrl: "", model: "", apiKey: null, fallbackModels: [] };
  const spec = resolveModel(cat, cat.defaultRef);
  const p = spec.provider;
  return {
    baseUrl: p.baseUrl,
    apiKeyEnv: p.auth?.env ?? null,
    apiKeyFile: p.auth?.file,
    apiKey: resolveAuthValue(p, baseDirs),
    model: spec.model.id,
    fallbackModels: cat.fallbackRefs.map((r) => parseModelRef(r).model),
    temperature: p.params?.temperature ?? 0.7,
    maxTokens: spec.model.maxTokens,
    timeoutMs: p.params?.timeoutMs ?? 120000,
    contextWindow: spec.model.contextWindow,
    reasoningEffort: p.params?.reasoningEffort ?? spec.model.reasoningEffort ?? null,
    webSearch: p.params?.webSearch ?? null,
  };
}

/** ModelRefの表示整形(ベア補完済みの確定形)。
 * @param {ModelSpec} spec @returns {string} */
export function specRef(spec) {
  return formatModelRef({ provider: spec.provider.id, model: spec.model.id });
}
