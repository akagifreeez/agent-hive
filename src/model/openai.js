// OpenAI互換(chat/completions)アダプタ。GLM(Z.AI/OpenRouter)等を想定。
// 依存ゼロ(node内蔵fetch)。
// usage(prompt/completion/reasoning/cost)を返し、コスト計測とコンテキスト管理の
// 判定ソース(provider usage優先: ZCode compact/policy.tsと同方針)に使う。
// リトライはZCode adapters/model/retry-policy.ts+runner-retry.ts+failure-classifier.tsの移植:
// 指数バックオフ+ジッタで最大10回、Retry-Afterは5分まで優先、429/5xx/529は可・401/403/400/422は不可。
export class OpenAIModel {
  constructor({ baseUrl, apiKey, model, temperature = 0.7, maxTokens = 2000, timeoutMs = 120000, reasoningEffort = null }) {
    if (!apiKey) throw new Error("APIキーが未設定です(環境変数か apiKeyFile を設定してください)");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.reasoningEffort = reasoningEffort;
  }

  async chat({ messages, tools }) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (this.reasoningEffort) {
      body.reasoning = { effort: this.reasoningEffort };
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = "auto";
    }
    let emptyRetries = 0;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // ネットワーク系(タイムアウト含む)はリトライ可(ZCode: NetworkError)
        if (attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt));
          continue;
        }
        throw new Error(`モデルAPIに接続できません: ${err.message}`);
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (process.env.HIVE_DEBUG_FILE) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname: d } = await import("node:path");
          try {
            mkdirSync(d(process.env.HIVE_DEBUG_FILE), { recursive: true });
            writeFileSync(process.env.HIVE_DEBUG_FILE, JSON.stringify({ status: res.status, messages, tools }, null, 1));
          } catch {}
        }
        if (isRetryableStatus(res.status) && attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt, parseRetryAfterMs(res)));
          continue;
        }
        throw new Error(translateHttpError(res.status, bodyText));
      }
      const data = await res.json().catch(() => null);
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error(`応答の形式が不正です: ${JSON.stringify(data).slice(0, 300)}`);
      // 空応答(テキストもツールもusageも無い)はZCodeと同様1回だけリトライ
      const empty = !msg.content && !(msg.tool_calls?.length) && !data.usage;
      if (empty && emptyRetries < EMPTY_COMPLETION_MAX_RETRIES) {
        emptyRetries++;
        await modelSleep(computeRetryDelay(attempt));
        continue;
      }
      return {
        content: msg.content ?? null,
        reasoning: msg.reasoning ?? null, // 思考テキスト(OpenRouterのreasoningモデル。UIの活動ログ用)
        toolCalls: (msg.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        })),
        raw: msg,
        usage: extractUsage(data.usage),
      };
    }
  }
}

// ===== リトライ(ZCode adapters/model の移植) =====
export const RETRY_MAX_RETRIES = 10; // 初回を含めると最大11試行
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_REASONABLE_RETRY_AFTER_MS = 5 * 60_000;
export const EMPTY_COMPLETION_MAX_RETRIES = 1;

export function isRetryableStatus(status) {
  if (status === 429 || status === 529) return true; // レート制限・過負荷
  if (status === 401 || status === 403 || status === 400 || status === 422) return false; // 認証/リクエスト不良は何度やっても同じ
  return status >= 500; // サーバ系エラーは可
}

// attempt=1回目の失敗に対する次の待ち。Retry-Afterが「妥当」(5分以内 or 指数遅延より短い)なら優先
export function computeRetryDelay(attempt, retryAfterMs = undefined, jitter = true) {
  const uncapped = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  const capped = Math.min(uncapped, RETRY_MAX_DELAY_MS);
  const reasonable = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 &&
    (retryAfterMs <= MAX_REASONABLE_RETRY_AFTER_MS || retryAfterMs < uncapped);
  if (reasonable) return retryAfterMs;
  if (!jitter) return capped;
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

function parseRetryAfterMs(res) {
  const v = res.headers?.get?.("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return undefined;
}

// テストで待ち時間を差し替えられるようにする
let sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
export function setModelSleep(fn) {
  sleepImpl = fn;
}
function modelSleep(ms) {
  return sleepImpl(ms);
}

export function extractUsage(u) {
  if (!u) return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    costUsd: u.cost ?? 0,
  };
}

function safeParseArgs(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _unparsed: String(s) };
  }
}

function translateHttpError(status, text = "") {
  const short = String(text).slice(0, 300);
  if (status === 401) return `APIキーが拒否されました(401)。${short}`;
  if (status === 404) return `モデルまたはURLが見つかりません(404)。model/baseUrlを確認。${short}`;
  if (status === 429) return `レート制限(429)。時間を置くかモデルを見直し。${short}`;
  return `モデルAPIエラー(${status}): ${short}`;
}
