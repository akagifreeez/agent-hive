// createModelFactory: エージェント指定(agents[].model / 実行時の/model切替)から
// モデル実体を構築する。api(ワイヤ形式)フィールドでアダプタを選択する。
// openai-completions = src/model/openai.js(GLM/OpenRouter等のOpenAI互換)。
// anthropic-messages(M2・Claude)やopenai-chatgpt-responses(M4・Codex OAuth)はここに足す。
import { ROOT, dataDir } from "../config.js";
import { OpenAIModel, FallbackModel } from "./openai.js";
import { AnthropicModel } from "./anthropic-messages.js";
import { buildCatalog, resolveModel, resolveAuthValue, specRef } from "./catalog.js";

/** api(ワイヤ形式)→アダプタクラス。 */
const ADAPTERS = {
  "openai-completions": OpenAIModel,
  "anthropic-messages": AnthropicModel,
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
          ? {
              input: spec.model.cost.input ?? 0,
              output: spec.model.cost.output ?? 0,
              cacheRead: spec.model.cost.cacheRead ?? 0,
              cacheWrite: spec.model.cost.cacheWrite ?? 0,
            }
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
 * providers[].authHintは鍵の末尾4文字(接続状態の可視化用)。
 * @param {import("../config.js").HiveConfig} config */
export function modelStateInfo(config) {
  try {
    const catalog = buildCatalog(config.models);
    const spec = resolveModel(catalog, null);
    const baseDirs = [ROOT, dataDir()];
    return {
      name: spec.model.name,
      ref: specRef(spec),
      fallbacks: catalog.fallbackRefs,
      providers: Object.values(catalog.providers).map((p) => {
        const authValue = resolveAuthValue(p, baseDirs);
        return {
          id: p.id,
          name: p.name ?? p.id,
          api: p.api,
          baseUrl: p.baseUrl,
          auth: p.auth?.env ? "env" : p.auth?.file ? "file" : p.auth?.value ? "value" : "none",
          authHint: authValue ? "…" + String(authValue).slice(-4) : null,
          models: (p.models ?? []).map((m) => m.id),
        };
      }),
    };
  } catch (err) {
    return { name: config.model?.model ?? "(未設定)", ref: null, fallbacks: [], providers: [], error: err.message };
  }
}

/** 既定モデルのModelSpec(鍵保存先の自動割り当て等に使う)。解決できない場合はnull。 */
export function resolveDefaultSpec(config) {
  try { return resolveModel(buildCatalog(config.models), null); } catch { return null; }
}

// 疎通プローブのエラー分類(UIで行動につながる表示にする)。エラー文言からの判定
function classifyProbeError(err) {
  const s = String(err?.message ?? err);
  if (/401|403|拒否されました/.test(s)) return "auth";
  if (/404|見つかりません/.test(s)) return "not_found";
  if (/429|レート制限/.test(s)) return "rate_limit";
  if (/接続できません|タイムアウト|stall/.test(s)) return "network";
  return "other";
}

/** モデル疎通プローブ(設定ウィンドウの「テスト送信」)。軽量リクエスト1発で接続・
 * 認証・モデル名を検証する。エージェントは起こさない(OpenClawのmodels status --probe相当)。
 * @param {import("../config.js").HiveConfig} config
 * @param {{provider?: string|null, model?: string|null}} [target]
 * @returns {Promise<{ok: boolean, ref?: string, error?: string, code?: string}>} */
export async function probeModel(config, { provider = null, model = null } = {}) {
  const catalog = buildCatalog(config.models);
  const baseDirs = [ROOT, dataDir()];
  let spec;
  try {
    if (provider) {
      // provider指定・model未指定ならそのプロバイダの代表モデル(行の先頭)で検証する
      const mid = model ?? (catalog.providers[provider]?.models ?? [])[0]?.id;
      spec = resolveModel(catalog, mid ? `${provider}/${mid}` : `${provider}/${resolveModel(catalog, null).model.id}`);
    } else {
      spec = resolveModel(catalog, model ?? catalog.defaultRef);
    }
  } catch (err) {
    return { ok: false, code: "config", error: err.message };
  }
  const ref = `${spec.provider.id}/${spec.model.id}`;
  const apiKey = resolveAuthValue(spec.provider, baseDirs);
  if (!apiKey) return { ok: false, code: "auth_missing", ref, error: `プロバイダ "${spec.provider.id}" の鍵が未設定です(設定の「モデルと接続」から保存)` };
  const cls = ADAPTERS[spec.provider.api];
  if (!cls) return { ok: false, code: "config", ref, error: `未対応のワイヤ形式 "${spec.provider.api}"` };
  try {
    const m = new cls({ baseUrl: spec.provider.baseUrl, apiKey, model: spec.model.id, maxTokens: 16, timeoutMs: 30000, costRates: null });
    await m.chat({ messages: [{ role: "user", content: "ping" }] });
    return { ok: true, ref };
  } catch (err) {
    return { ok: false, ref, code: classifyProbeError(err), error: String(err?.message ?? err).slice(0, 400) };
  }
}
