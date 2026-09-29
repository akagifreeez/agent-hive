// createModelFactory: エージェント指定(agents[].model / 実行時の/model切替)から
// モデル実体を構築する。api(ワイヤ形式)フィールドでアダプタを選択する。
// openai-completions = src/model/openai.js(GLM/OpenRouter等のOpenAI互換)。
// anthropic-messages(M2・Claude)やopenai-chatgpt-responses(M4・Codex OAuth)はここに足す。
import { ROOT, dataDir } from "../config.js";
import { OpenAIModel, FallbackModel } from "./openai.js";
import { buildCatalog, resolveModel, resolveAuthValue, specRef } from "./catalog.js";

/** api(ワイヤ形式)→アダプタクラス。 */
const ADAPTERS = {
  "openai-completions": OpenAIModel,
};

/** モデルファクトリを返す。旧runner.js内実装の一般化:
 * - ref解決が入る(agent.modelは"provider/model"でもベアIDでもよい)
 * - fallbacksは設定models.fallbacks(ModelRef列)から構築する
 * @param {import("../config.js").HiveConfig} config
 * @returns {(agent?: {model?: string|null, reasoningEffort?: string|null, webSearch?: boolean|object|null}) => OpenAIModel|FallbackModel} */
export function createModelFactory(config) {
  const catalog = buildCatalog(config.models);
  const baseDirs = [ROOT, dataDir()];
  return (agent = {}) => {
    const mk = (spec, effort) => {
      const apiKey = resolveAuthValue(spec.provider, baseDirs);
      if (!apiKey) {
        const pid = spec.provider.id;
        throw new Error(`プロバイダ "${pid}" のAPIキーが未設定です(auth.env/auth.file/auth.value で設定してください)`);
      }
      const cls = ADAPTERS[spec.provider.api];
      if (!cls) throw new Error(`未対応のワイヤ形式 "${spec.provider.api}"(provider "${spec.provider.id}")`);
      return new cls({
        baseUrl: spec.provider.baseUrl,
        apiKey,
        model: spec.model.id,
        temperature: spec.provider.params?.temperature ?? 0.7,
        maxTokens: spec.model.maxTokens,
        timeoutMs: spec.provider.params?.timeoutMs ?? 120000,
        reasoningEffort: effort ?? spec.model.reasoningEffort ?? spec.provider.params?.reasoningEffort ?? null,
        webSearch: agent.webSearch ?? spec.provider.params?.webSearch ?? null,
        costRates: spec.model.cost
          ? { input: spec.model.cost.input ?? 0, output: spec.model.cost.output ?? 0 }
          : null,
      });
    };
    const spec = resolveModel(catalog, agent.model ?? catalog.defaultRef);
    const primary = mk(spec, agent.reasoningEffort ?? null);
    // フォールバック列(config.models.fallbacks)があれば、終端エラー時に順に試す。
    // effortはフォールバック側にagent値を引き継がない(旧実装と同じ=設定既定で動く)
    const fallbacks = (catalog.fallbackRefs ?? []).map((r) => mk(resolveModel(catalog, r)));
    return fallbacks.length ? new FallbackModel({ primary, fallbacks }) : primary;
  };
}

/** /api/state等に載せるモデル状態の概要(生の鍵は含めない)。index.html互換のため
 * name/fallbacksキーを維持し、新形としてref/providersを足す。
 * @param {import("../config.js").HiveConfig} config */
export function modelStateInfo(config) {
  try {
    const catalog = buildCatalog(config.models);
    const spec = resolveModel(catalog, null);
    return {
      name: spec.model.name,
      ref: specRef(spec),
      fallbacks: catalog.fallbackRefs,
      providers: Object.values(catalog.providers).map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        api: p.api,
        baseUrl: p.baseUrl,
        auth: p.auth?.env ? "env" : p.auth?.file ? "file" : p.auth?.value ? "value" : "none",
        models: (p.models ?? []).map((m) => m.id),
      })),
    };
  } catch (err) {
    return { name: config.model?.model ?? "(未設定)", ref: null, fallbacks: [], providers: [], error: err.message };
  }
}

/** 既定モデルのModelSpec(鍵保存先の自動割り当て等に使う)。解決できない場合はnull。 */
export function resolveDefaultSpec(config) {
  try { return resolveModel(buildCatalog(config.models), null); } catch { return null; }
}
