// openai-completions ワイヤ形式のアダプタ(models.providers.<id>.api="openai-completions"で選択)。
// OpenAI互換(chat/completions)。GLM(Z.AI/OpenRouter)等を想定。
// 依存ゼロ(node内蔵fetch)。
// usage(prompt/completion/reasoning/cost)を返し、コスト計測とコンテキスト管理の
// 判定ソース(provider usage優先: ZCode compact/policy.tsと同方針)に使う。
// リトライはZCode adapters/model/retry-policy.ts+runner-retry.ts+failure-classifier.tsの移植:
// 指数バックオフ+ジッタで最大10回、Retry-Afterは5分まで優先、429/5xx/529は可・401/403/400/422は不可。
// プロバイダ横断スロットリング(throttle.js)にも参加: 429/529を受けたら同プロバイダ(baseUrl)を
// 叩く全エージェントへ共有クールダウンを記録し、リクエスト前にgateで待つ(イシュー#1)。
import { gateProvider, noteProviderRateLimited, clearProviderRateLimit } from "./throttle.js";
/**
 * OpenAI互換エンドポイント(GLM等)への最小クライアント。
 */
export class OpenAIModel {
  /**
   * @param {{baseUrl: string, apiKey: string, model?: string, temperature?: number, maxTokens?: number, timeoutMs?: number, reasoningEffort?: string|null, webSearch?: boolean|object|null, costRates?: {input?: number, output?: number}|null}} cfg
   *   webSearch: サーバー側web_searchツール(Z.AI固有。functionツールと併存可)。
   *   true=既定パラメータ(search-prime)、オブジェクト=web_search引数へそのまま展開、null/falsy=無効。
   *   costRates: カタログ単価($/1Mトークン)。usage.costをプロバイダが返さない場合のフォールバック計算に使う。
   */
  constructor({ baseUrl, apiKey, model, temperature = 0.7, maxTokens = 2000, timeoutMs = 120000, reasoningEffort = null, webSearch = null, costRates = null }) {
    if (!apiKey) throw new Error("APIキーが未設定です(環境変数か apiKeyFile を設定してください)");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.reasoningEffort = reasoningEffort;
    this.webSearch = webSearch;
    this.costRates = costRates;
  }

  async chat({ messages, tools, onDelta = null }) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (this.reasoningEffort) {
      body.reasoning = { effort: this.reasoningEffort };
    }
    // サーバー側web_search(Z.AI): モデルが検索を判断し、結果がコンテキストへ注入される。
    // 出典はレスポンス(非ストリーム=トップレベル、ストリーム=usageチャンク)の web_search に返る。
    const bodyTools = [];
    if (this.webSearch) {
      bodyTools.push({
        type: "web_search",
        web_search: this.webSearch === true
          ? { enable: true, search_engine: "search-prime", search_result: true }
          : { enable: true, ...this.webSearch },
      });
    }
    if (tools?.length) {
      bodyTools.push(...tools.map((t) => ({ type: "function", function: t })));
      body.tool_choice = "auto";
    }
    if (bodyTools.length) body.tools = bodyTools;
    // onDeltaが渡されたらストリーミングで受け、断片をその都度コールバックする(ライブ表示用)
    const useStream = typeof onDelta === "function";
    if (useStream) body.stream = true;
    let emptyRetries = 0;
    for (let attempt = 1; ; attempt++) {
      // プロバイダ横断の共有クールダウン(他エージェントが429/529を見たら全員が待つ: イシュー#1)
      await gateProvider(this.baseUrl);
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
        if (isRetryableStatus(res.status)) {
          const quotaResetMs = res.status === 429 ? parseQuotaResetMs(bodyText) : null;
          if (res.status === 429 || res.status === 529) {
            noteProviderRateLimited(this.baseUrl, parseRetryAfterMs(res), { quotaUntilMs: quotaResetMs ?? undefined });
          }
          // クォータ窓(GLM 5時間上限等・G3): リセット時刻が応答本文で分かる場合は短いリトライの
          // 繰り返しに意味が無いので即座に打ち切る。復帰までの待ちはthrottleの共有クールダウンが担い、
          // 同プロバイダを叩く全エージェントがリセット時刻までゲートで待つ
          if (quotaResetMs) {
            const min = Math.max(1, Math.round((quotaResetMs - Date.now()) / 60_000));
            throw new Error(`クォータ上限に到達しました(リセットまで約${min}分)。${String(bodyText).slice(0, 200)}`);
          }
          if (attempt <= RETRY_MAX_RETRIES) {
            await modelSleep(computeRetryDelay(attempt, parseRetryAfterMs(res)));
            continue;
          }
        }
        throw new Error(translateHttpError(res.status, bodyText));
      }
      let msg, usage, searches = null;
      if (useStream) {
        let parsed;
        try {
          parsed = await consumeStream(res, onDelta);
        } catch (err) {
          // ストリーム途中切断もリトライ対象(再試行は最初から)。
          // undiciの中断系(TypeError: terminated / Fetch.onAborted / ECONNRESET等)を
          // ネットワーク系として正規化(long-run-resilience: 2026-10-04のプロセス死対策)。
          // リトライし切ったら行動化エラー(ループが次の行動を決められる形)として投げる
          if (attempt <= RETRY_MAX_RETRIES) {
            await modelSleep(computeRetryDelay(attempt));
            continue;
          }
          throw new Error(translateStreamAbortError(err));
        }
        msg = { content: parsed.content || null, tool_calls: parsed.rawToolCalls, reasoning: parsed.reasoning ?? undefined };
        usage = parsed.usage;
        searches = parsed.webSearch;
      } else {
        const data = await res.json().catch(() => null);
        msg = data?.choices?.[0]?.message;
        usage = data?.usage;
        searches = data?.web_search ?? null;
        if (!msg) throw new Error(`応答の形式が不正です: ${JSON.stringify(data).slice(0, 300)}`);
      }
      clearProviderRateLimit(this.baseUrl);
      // 空応答(テキストもツールもusageも無い)はZCodeと同様1回だけリトライ
      const empty = !msg.content && !(msg.tool_calls?.length) && !usage;
      if (empty && emptyRetries < EMPTY_COMPLETION_MAX_RETRIES) {
        emptyRetries++;
        await modelSleep(computeRetryDelay(attempt));
        continue;
      }
      return {
        content: msg.content ?? null,
        // 思考テキスト: OpenRouter流reasoning、無ければzai/DeepSeek流reasoning_content(UIの活動ログ用)
        reasoning: msg.reasoning || msg.reasoning_content || null,
        toolCalls: (msg.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        })),
        raw: msg,
        usage: extractUsage(usage, this.costRates),
        searches, // web_search実行結果の出典一覧([{title,link,refer,...}]、未実行時はnull)
      };
    }
  }
}

// SSEストリームの解析。delta.content/reasoning/tool_callsを累積し、断片をonDeltaへ流す。
// readがidleタイムアウト(ZCodeと同様既定600秒)を過ぎたら例外→chat()のリトライで最初からやり直す。
function streamIdleTimeoutMs() {
  return Number(process.env.HIVE_STREAM_IDLE_TIMEOUT_MS ?? 600_000);
}
async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let webSearchResults = null;
  const toolAcc = new Map(); // index => {id, name, args}
  try {
    for (;;) {
      const { done, value } = await readChunkWithIdleTimeout(reader);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.web_search) webSearchResults = chunk.web_search; // 最終usageチャンクに付いてくる(Z.AI)
        const d = chunk.choices?.[0]?.delta ?? {};
        // 思考テキスト: OpenRouter流reasoningに加えDeepSeek/zai流reasoning_contentも拾う
        // (同一deltaに両方あればこの順で連結、別deltaなら出現順に累積)。断片はonDeltaへ流す。
        let think = "";
        if (d.reasoning) think += d.reasoning;
        if (d.reasoning_content) think += d.reasoning_content;
        if (think) {
          reasoning += think;
          onDelta?.({ kind: "think", text: think });
        }
        if (d.content) {
          content += d.content;
          onDelta?.({ kind: "say", text: d.content });
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const acc = toolAcc.get(i) ?? { id: tc.id ?? `call-${i}`, name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(i, acc);
        }
      }
    }
  } finally {
    // 中断(例外・リトライ)でも未読readerとサーバー接続を解放する
    try { await reader.cancel(); } catch { /* 既に閉じている */ }
  }
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: safeParseArgs(acc.args) }))
    .filter((t) => t.name);
  return {
    content,
    reasoning: reasoning || null,
    usage,
    webSearch: webSearchResults,
    rawToolCalls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
  };
}

function readChunkWithIdleTimeout(reader) {
  const idle = streamIdleTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ストリームが${Math.round(idle / 1000)}秒間無出力です(stall)`)), idle);
  });
  const readP = reader.read();
  // read側がrejectしてもタイマーを解放する(放置するとプロセスが終了しない)
  readP.finally(() => clearTimeout(timer));
  return Promise.race([readP, timeout]);
}

// 成功したモデルを記憶して固定するフェイルオーバー(ZCode model-selection流)。
// primaryが終端エラー(retry使い切り等)のときだけfallbacksを順に試す。
export class FallbackModel {
  constructor({ primary, fallbacks = [] }) {
    if (!primary) throw new Error("primaryモデルがありません");
    this.primary = primary;
    this.fallbacks = fallbacks;
    this.current = primary;
  }

  get maxTokens() {
    return this.current.maxTokens;
  }

  async chat(opts) {
    const chain = [this.current, ...this.fallbacks.filter((f) => f !== this.current)];
    let lastErr;
    for (const m of chain) {
      try {
        const r = await m.chat(opts);
        this.current = m;
        return r;
      } catch (err) {
        lastErr = err;
      }
    }
    this.current = this.primary;
    throw lastErr;
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

// テストで待ち時間を差し替えられるようにする(sleepはアダプタ間で共有)
let sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
export function setModelSleep(fn) {
  sleepImpl = fn;
}
export function modelSleep(ms) {
  return sleepImpl(ms);
}

export function parseRetryAfterMs(res) {
  const v = res.headers?.get?.("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return undefined;
}

// クォータ窓のリセット時刻を応答本文から読む(G3)。
// GLMの5時間上限はレート制限ヘッダを出さず(2026-10-06実測)、本文に
// code 1308「Usage limit reached for 5 hour. reset at 19:11:09」の形で返ってくる。
// リセットはローカルの時計時刻で示されるため、過ぎていれば翌日として解釈する。
const QUOTA_RESET_RE = /reset at (\d{1,2}):(\d{2}):(\d{2})/;
export function parseQuotaResetMs(bodyText, now = Date.now()) {
  if (!bodyText) return null;
  const m = String(bodyText).match(QUOTA_RESET_RE);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  let target = d.getTime();
  if (target <= now + 30_000) target += 24 * 60 * 60_000;
  return target;
}

export function extractUsage(u, costRates = null) {
  if (!u) return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: null, costUsd: 0 };
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  let costUsd = u.cost ?? 0;
  // プロバイダが実費を返さない場合のみカタログ単価で概算($/1Mトークン)
  if (!costUsd && costRates?.input != null && costRates?.output != null) {
    costUsd = (promptTokens * costRates.input + completionTokens * costRates.output) / 1_000_000;
  }
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    // キャッシュ済み入力トークン(G9): プロバイダが報告しない場合は0でなくnull(「未報告」と「0」を区別する)
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
    costUsd,
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

// ストリーム中断系エラーの正規化(long-run-resilience)。
// undici(内蔵fetch)の切断は種々の形で出る: TypeError: terminated(Fetch.onAborted)、
// TypeError: fetch failed(causeにECONNRESET/EPIPE等)、AbortError(タイムアウト)。
// どれもネットワーク系として分類し、行動化できる1文にまとめる(プロセスは落とさない)。
const STREAM_ABORT_HINTS = ["terminated", "aborted", "aborterror", "econnreset", "epipe", "econnaborted", "fetch failed", "network", "socket", "premature close", "other side closed"];

/**
 * 中断系エラーかを判定する(メッセージ+cause連鎖をさかのぼって探査)。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStreamAbortError(err) {
  let cur = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = String(cur.message ?? cur).toLowerCase();
    if (STREAM_ABORT_HINTS.some((h) => msg.includes(h))) return true;
    if (cur.name && String(cur.name).toLowerCase() === "aborterror") return true;
    cur = /** @type {any} */ (cur).cause;
  }
  return false;
}

/**
 * ストリーム中断をリトライし切ったときの行動化エラー文面。
 * @param {unknown} err
 * @returns {string}
 */
export function translateStreamAbortError(err) {
  const detail = String(err?.message ?? err).slice(0, 200);
  if (isStreamAbortError(err)) {
    return `ストリームが切断されました(ネットワーク瞬断の可能性)。リトライ${RETRY_MAX_RETRIES}回で不調。モデル呼び出しを諦めて次の行動を決めてください(待機/他タスク/ボード報告): ${detail}`;
  }
  return `ストリームが途切れました: ${detail}`;
}
