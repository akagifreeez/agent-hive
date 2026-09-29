// createModelFactory: エージェント指定(agents[].model / 実行時の/model切替)から
// モデル実体を構築する。api(ワイヤ形式)フィールドでアダプタを選択する。
// openai-completions = src/model/openai.js(GLM/OpenRouter等のOpenAI互換)。
// anthropic-messages(M2・Claude)やopenai-chatgpt-responses(M4・Codex OAuth)はここに足す。
import { ROOT, dataDir } from "../config.js";
import { OpenAIModel, FallbackModel } from "./openai.js";
import { AnthropicModel } from "./anthropic-messages.js";
import { ChatGPTModel } from "./openai-chatgpt.js";
import { buildCatalog, resolveModel, resolveAuthValue, specRef } from "./catalog.js";
import {
  openCallbackServer, buildAuthorizeUrl, createPKCE,
  exchangeCode, extractAccountId, extractEmail,
  resolveOAuthToken, readTokenStore, writeTokenStore,
  oauthHint, hasOAuthEntry, CALLBACK_PORT_CANDIDATES,
} from "./openai-auth.js";
import { randomBytes } from "node:crypto";

/** api(ワイヤ形式)→アダプタクラス。 */
const ADAPTERS = {
  "openai-completions": OpenAIModel,
  "anthropic-messages": AnthropicModel,
  "openai-chatgpt-responses": ChatGPTModel,
};

/** oauth型プロバイダのトークンストア参照を組み立てる。 */
function oauthStoreRef(provider) {
  return { provider: provider.id, file: provider.auth?.file ?? `state/models-${provider.id}.oauth.json` };
}

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
      const cls = ADAPTERS[spec.provider.api];
      if (!cls) throw new Error(`未対応のワイヤ形式 "${spec.provider.api}"(provider "${spec.provider.id}")`);
      const base = {
        baseUrl: spec.provider.baseUrl,
        model: spec.model.id,
        maxTokens: spec.model.maxTokens,
        timeoutMs: spec.provider.params?.timeoutMs ?? 120000,
      };
      if (spec.provider.api === "openai-chatgpt-responses") {
        // Codex OAuth(ChatGPT Plus/Pro): トークンはストアから非同期供給(期限切れは自動リフレッシュ)
        const storeRef = oauthStoreRef(spec.provider);
        return new cls({
          ...base,
          temperature: spec.provider.params?.temperature ?? null,
          costRates: spec.model.cost
            ? {
                input: spec.model.cost.input ?? 0,
                output: spec.model.cost.output ?? 0,
                cacheRead: spec.model.cost.cacheRead ?? 0,
                cacheWrite: spec.model.cost.cacheWrite ?? 0,
              }
            : null,
          tokenFn: (opts) => resolveOAuthToken(storeRef, baseDirs, opts),
        });
      }
      const apiKey = resolveAuthValue(spec.provider, baseDirs);
      if (!apiKey) {
        const pid = spec.provider.id;
        throw new Error(`プロバイダ "${pid}" のAPIキーが未設定です(auth.env/auth.file/auth.value で設定してください)`);
      }
      return new cls({
        ...base,
        apiKey,
        temperature: spec.provider.params?.temperature ?? 0.7,
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
    // 既定モデルが即座に使えるか(鍵解決/OAuth認証済み)。UIの未接続警告に使う
    let modelReady = true;
    try {
      modelReady = spec.provider.api === "openai-chatgpt-responses"
        ? hasOAuthEntry(oauthStoreRef(spec.provider), baseDirs)
        : Boolean(resolveAuthValue(spec.provider, baseDirs));
    } catch { modelReady = false; }
    return {
      name: spec.model.name,
      ref: specRef(spec),
      ready: modelReady,
      fallbacks: catalog.fallbackRefs,
      providers: Object.values(catalog.providers).map((p) => {
        if (p.auth?.type === "oauth") {
          return {
            id: p.id,
            name: p.name ?? p.id,
            api: p.api,
            baseUrl: p.baseUrl,
            auth: "oauth",
            authHint: oauthHint(oauthStoreRef(p), baseDirs),
            models: (p.models ?? []).map((m) => m.id),
          };
        }
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
  const apiKey = spec.provider.api === "openai-chatgpt-responses"
    ? ((await resolveOAuthToken(oauthStoreRef(spec.provider), baseDirs).catch(() => null))?.access ?? null)
    : resolveAuthValue(spec.provider, baseDirs);
  if (!apiKey) {
    const isOauth = spec.provider.api === "openai-chatgpt-responses";
    return {
      ok: false,
      code: "auth_missing",
      ref,
      error: isOauth
        ? `プロバイダ "${spec.provider.id}" は未認証です(設定の「モデルと接続」から認証してください)`
        : `プロバイダ "${spec.provider.id}" の鍵が未設定です(設定の「モデルと接続」から保存)`,
    };
  }
  const cls = ADAPTERS[spec.provider.api];
  if (!cls) return { ok: false, code: "config", ref, error: `未対応のワイヤ形式 "${spec.provider.api}"` };
  try {
    const m = spec.provider.api === "openai-chatgpt-responses"
      ? new cls({ baseUrl: spec.provider.baseUrl, model: spec.model.id, maxTokens: 16, timeoutMs: 30000, costRates: null, tokenFn: (opts) => resolveOAuthToken(oauthStoreRef(spec.provider), baseDirs, opts) })
      : new cls({ baseUrl: spec.provider.baseUrl, apiKey, model: spec.model.id, maxTokens: 16, timeoutMs: 30000, costRates: null });
    await m.chat({ messages: [{ role: "user", content: "ping" }] });
    return { ok: true, ref };
  } catch (err) {
    return { ok: false, ref, code: classifyProbeError(err), error: String(err?.message ?? err).slice(0, 400) };
  }
}

/** 進行中のOAuthフロー(手動コールバック貼り付けの検証に使う)。providerId => flow情報 */
const openAuthFlows = new Map();

/** Codex OAuth(ChatGPT Plus/Pro)の認証フローを開始する。
 * コールバックサーバを立ててauthUrlを返す(応答は即時)。ブラウザでのログイン完了後、
 * トークンをストアに保存する(完了は/api/modelsのauthHintで見える)。再認証も同じ操作。
 * pasteUrlを渡した場合は「先に発行した認証URL」からのリダイレクト先URLとして処理する
 * (コールバックの自動受信が使えない環境向けのフォールバック)。
 * @param {import("../config.js").HiveConfig} config
 * @param {{provider?: string|null, pasteUrl?: string|null}} [target] */
export async function startOpenAIAuth(config, { provider = null, pasteUrl = null } = {}) {
  const catalog = buildCatalog(config.models);
  const baseDirs = [ROOT, dataDir()];
  const pid = provider ?? resolveModel(catalog, null).provider.id;
  const p = catalog.providers[pid];
  if (!p) return { ok: false, error: `未知のプロバイダ "${pid}"` };
  if (p.api !== "openai-chatgpt-responses") return { ok: false, error: `プロバイダ "${pid}" はOAuth認証に対応していません(api="${p.api}")` };
  const storeRef = oauthStoreRef(p);
  if (pasteUrl) {
    // 手動フォールバック: 貼り付けられたリダイレクトURLからcodeを抽出して交換する
    const flow = openAuthFlows.get(pid);
    if (!flow) return { ok: false, error: "先に「認証」ボタンで認証URLを発行してください" };
    let code;
    try {
      const u = new URL(String(pasteUrl).trim());
      code = u.searchParams.get("code");
      if (u.searchParams.get("state") !== flow.state) return { ok: false, error: "state不一致のURLです(認証URLを発行し直してから再度貼り付けてください)" };
      if (!code) return { ok: false, error: "URLにcodeがありません。ブラウザのアドレス欄のURLをそのまま貼り付けてください" };
    } catch {
      return { ok: false, error: "URLの形式が不正です。リダイレクト先のURLをそのまま貼り付けてください" };
    }
    let tokens = null;
    let exchangeError = null;
    try {
      tokens = await exchangeCode(code, flow.verifier, flow.redirectUri);
    } catch (err) {
      exchangeError = err;
    }
    if (!tokens) return { ok: false, error: `トークン交換に失敗しました: ${exchangeError?.message ?? "不明なエラー"}` };
    saveOAuthTokens(storeRef, tokens, baseDirs);
    openAuthFlows.delete(pid);
    flow.close?.(); // 自動受信用に開いていたコールバックサーバを閉じる
    return { ok: true, provider: pid, pasted: true };
  }
  const verifier = createPKCE().verifier;
  const state = randomBytes(16).toString("hex");
  let opened = null;
  let redirectUri = null;
  let lastErr = null;
  for (const port of CALLBACK_PORT_CANDIDATES) {
    redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    try {
      opened = await openCallbackServer({ redirectUri, state });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!opened) {
    // ポートが全部塞がっている: 手動貼り付け用のフローだけ作ってauthUrlを返す
    redirectUri = `http://127.0.0.1:${CALLBACK_PORT_CANDIDATES[0]}/auth/callback`;
    openAuthFlows.set(pid, { verifier, state, redirectUri });
    return {
      ok: true, provider: pid, authUrl: buildAuthorizeUrl({ verifier, state, redirectUri }), redirectUri,
      manualOnly: true, note: "コールバックを自動受信できません。ログイン後、リダイレクト先URLを「URLを貼り付け」欄に入れてください",
    };
  }
  const authUrl = buildAuthorizeUrl({ verifier, state, redirectUri });
  openAuthFlows.set(pid, { verifier, state, redirectUri, close: opened.close });
  // 受信はバックグラウンドで続ける。完了時トークン保存(失敗時はストアに触らず、次の認証/テストで分かる)
  void opened.promise
    .then(async ({ code }) => {
      const tokens = await exchangeCode(code, verifier, redirectUri);
      saveOAuthTokens(storeRef, tokens, baseDirs);
      openAuthFlows.delete(pid);
    })
    .catch(() => { /* コールバックUIに完了メッセージを出しているため、ここでは握りつぶす */ });
  return { ok: true, provider: pid, authUrl, redirectUri };
}

/** トークンをストアへ保存する(表示用のaccountId/emailも添える)。 */
function saveOAuthTokens(storeRef, tokens, baseDirs) {
  const store = readTokenStore(storeRef.file, baseDirs);
  store[storeRef.provider] = {
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    accountId: extractAccountId(tokens.access),
    email: extractEmail(tokens.access),
    updatedAt: Date.now(),
  };
  writeTokenStore(storeRef.file, store, baseDirs);
}
