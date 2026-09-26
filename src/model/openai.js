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
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = "auto";
    }
    // onDeltaが渡されたらストリーミングで受け、断片をその都度コールバックする(ライブ表示用)
    const useStream = typeof onDelta === "function";
    if (useStream) body.stream = true;
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
      let msg, usage;
      if (useStream) {
        let parsed;
        try {
          parsed = await consumeStream(res, onDelta);
        } catch (err) {
          // ストリーム途中切断もリトライ対象(再試行は最初から)
          if (attempt <= RETRY_MAX_RETRIES) {
            await modelSleep(computeRetryDelay(attempt));
            continue;
          }
          throw new Error(`ストリームが途切れました: ${err.message}`);
        }
        msg = { content: parsed.content || null, tool_calls: parsed.rawToolCalls, reasoning: parsed.reasoning ?? undefined };
        usage = parsed.usage;
      } else {
        const data = await res.json().catch(() => null);
        msg = data?.choices?.[0]?.message;
        usage = data?.usage;
        if (!msg) throw new Error(`応答の形式が不正です: ${JSON.stringify(data).slice(0, 300)}`);
      }
      // 空応答(テキストもツールもusageも無い)はZCodeと同様1回だけリトライ
      const empty = !msg.content && !(msg.tool_calls?.length) && !usage;
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
        usage: extractUsage(usage),
      };
    }
  }
}

// SSEストリームの解析。delta.content/reasoning/tool_callsを累積し、断片をonDeltaへ流す
async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  const toolAcc = new Map(); // index => {id, name, args}
  for (;;) {
    const { done, value } = await reader.read();
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
      const d = chunk.choices?.[0]?.delta ?? {};
      if (d.reasoning) {
        reasoning += d.reasoning;
        onDelta?.({ kind: "think", text: d.reasoning });
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
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: safeParseArgs(acc.args) }))
    .filter((t) => t.name);
  return {
    content,
    reasoning: reasoning || null,
    usage,
    rawToolCalls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
  };
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
