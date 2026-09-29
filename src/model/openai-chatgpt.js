// openai-chatgpt-responses ワイヤ形式のアダプタ(models.providers.<id>.api="openai-chatgpt-responses")。
// ChatGPT Plus/Proサブスク(Codex OAuth)専用バックエンド(chatgpt.com/backend-api/codex/responses)。
// 依存ゼロ。Responses API形のSSEイベントをOpenAIModelと同じ正規形(chat()→content/toolCalls/usage)へ変換。
// トークンはtokenFn(非同期)で供給され、401時は強制リフレッシュで1回だけ再試行する。
// 未対応: WebSocket輸送・image入力・reasoning暗号文の保存(include reasoning.encrypted_content相当は使わない)。
import { randomUUID } from "node:crypto";
import {
  RETRY_MAX_RETRIES, EMPTY_COMPLETION_MAX_RETRIES,
  computeRetryDelay, isRetryableStatus, modelSleep, parseRetryAfterMs,
} from "./openai.js";

export class ChatGPTModel {
  /**
   * @param {{baseUrl?: string, model?: string, maxTokens?: number, timeoutMs?: number, temperature?: number|null, costRates?: {input?: number, output?: number}|null, tokenFn: (opts?: {forceRefresh?: boolean}) => Promise<{access: string, accountId: string|null}>, reasoningEffort?: string|null, webSearch?: boolean|object|null}} cfg
   *   tokenFn: 有効なaccess tokenとaccountIdを供給する(期限切れなら内部でリフレッシュ)。
   *   webSearch/reasoningEffortは契約を揃えるため受け取るだけ(いずれも非対応)。
   */
  constructor({ baseUrl = "https://chatgpt.com/backend-api", model, maxTokens = 2000, timeoutMs = 180000, temperature = null, costRates = null, tokenFn, reasoningEffort = null, webSearch = null }) {
    if (typeof tokenFn !== "function") throw new Error("ChatGPTModelにはtokenFnが必要です(auth type oauthで構成してください)");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.costRates = costRates;
    this.tokenFn = tokenFn;
  }

  async chat({ messages, tools, onDelta = null }) {
    let attempt = 1;
    let forceRefresh = false;
    let emptyRetries = 0;
    for (;;) {
      let token;
      try {
        token = await this.tokenFn({ forceRefresh });
      } catch (err) {
        // リフレッシュ失敗は理由つき例外(再ログイン誘導文言)。リトライでは回復しない
        throw new Error(`ChatGPTの認証を更新できません: ${err.message}`);
      }
      if (!token?.access) {
        throw new Error("ChatGPTは未認証です。設定の「モデルと接続」から認証してください");
      }
      let res;
      try {
        res = await this.request({ messages, tools, token });
      } catch (err) {
        // ネットワーク系(タイムアウト含む)は一過性が多いのでOpenAIModelと同じくリトライする
        if (attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt));
          attempt++;
          continue;
        }
        throw new Error(`モデルAPIに接続できません: ${err.message}`);
      }
      if (res.status === 401 && !forceRefresh && attempt <= 2) {
        forceRefresh = true; // トークン失効。強制リフレッシュして1回だけやり直す
        continue;
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (isRetryableStatus(res.status) && attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt, parseRetryAfterMs(res)));
          attempt++;
          continue;
        }
        throw new Error(translateHttpError(res.status, bodyText));
      }
      let parsed;
      try {
        parsed = await consumeStream(res, onDelta);
      } catch (err) {
        // SSE途中切断も最初からやり直す(OpenAIModelと同じ)
        if (attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt));
          attempt++;
          continue;
        }
        throw new Error(`ストリームが途切れました: ${err.message}`);
      }
      const empty = !parsed.content && !(parsed.toolCalls?.length) && !parsed.usage;
      if (empty && emptyRetries < EMPTY_COMPLETION_MAX_RETRIES) {
        emptyRetries++;
        await modelSleep(computeRetryDelay(attempt));
        attempt++;
        continue;
      }
      return {
        content: parsed.content ?? null,
        reasoning: parsed.reasoning ?? null,
        toolCalls: parsed.toolCalls ?? [],
        raw: parsed.raw ?? null,
        usage: codexUsage(parsed.usage, this.costRates),
        searches: null,
      };
    }
  }

  async request({ messages, tools, token }) {
    const body = toCodexRequest({ messages, tools, cfg: this });
    const headers = buildHeaders(token, this.baseUrl);
    return fetch(codexUrl(this.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

// ===== URL・ヘッダ =====

/** baseUrlをCodexのエンドポイントへ補完する(/codex/responses)。
 * /codex までの指定は /responses を足し、完全形はそのまま使う。 */
export function codexUrl(baseUrl) {
  const b = String(baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (b.endsWith("/codex/responses")) return b;
  if (b.endsWith("/codex")) return `${b}/responses`;
  return `${b}/codex/responses`;
}

/** CodexバックエンドのSSEヘッダ(auth/account-id/beta/セッションID)。 */
export function buildHeaders(token, _baseUrl = "") {
  const sessionId = randomUUID();
  return {
    authorization: `Bearer ${token.access}`,
    "chatgpt-account-id": token.accountId ?? "",
    originator: "codex_cli",
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    session_id: sessionId,
    "x-client-request-id": sessionId,
    "user-agent": "agent-hive",
  };
}

// ===== リクエスト変換(OpenAI形 → Responses input) =====

// contentが配列(画像添付のマルチモーダル形)でもテキスト部分だけ取り出す。
// String()直接は"[object Object]"になり文脈を汚染する。画像は本ワイヤ未対応(テキストのみ届ける)
function textOf(content) {
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
  }
  return content ?? "";
}

/** @param {{messages: Array, tools: Array|null, cfg: ChatGPTModel}} p */
export function toCodexRequest({ messages, tools, cfg }) {
  const system = [];
  const input = [];
  for (const m of messages ?? []) {
    if (m.role === "system") {
      if (m.content) system.push(String(m.content));
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null),
      });
      continue;
    }
    if (m.role === "assistant" && (m.tool_calls?.length)) {
      const t = textOf(m.content);
      if (t) input.push({ role: "assistant", content: [{ type: "output_text", text: String(t) }] });
      for (const tc of m.tool_calls) {
        const fn = tc.function ?? tc;
        input.push({ type: "function_call", call_id: tc.id, name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) });
      }
      continue;
    }
    if (Array.isArray(m.content)) {
      // マルチモーダル(画像添付): input_text+input_imageのcontent配列へ変換する
      // (attachImageはOpenAI形のimage_url/data URLで積む)
      const content = [];
      const t = m.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
      if (t) content.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: String(t) });
      for (const c of m.content) {
        if (c?.type === "image_url" && c.image_url?.url) content.push({ type: "input_image", image_url: c.image_url.url });
      }
      if (content.length) input.push({ role: m.role === "assistant" ? "assistant" : "user", content });
      continue;
    }
    const text = textOf(m.content);
    if (!text) continue;
    input.push({ role: m.role === "assistant" ? "assistant" : "user", content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: String(text) }] });
  }
  const body = {
    model: cfg.model,
    store: false,
    stream: true,
    instructions: system.join("\n\n") || "You are a helpful assistant.",
    input,
  };
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    body.tool_choice = "auto";
  }
  return body;
}

// ===== SSE処理 =====

async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  let usage = null;
  let completed = null;
  const calls = new Map(); // output_index => {call_id, name, args}
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
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        const type = ev.type;
        if (type === "response.output_text.delta" && ev.delta) {
          text += ev.delta;
          onDelta?.({ kind: "say", text: ev.delta });
        } else if (type === "response.reasoning_summary_text.delta" && ev.delta) {
          reasoning += ev.delta;
          onDelta?.({ kind: "think", text: ev.delta });
        } else if (type === "response.output_item.added" && ev.item?.type === "function_call") {
          calls.set(ev.output_index ?? 0, { call_id: ev.item.call_id ?? "", name: ev.item.name ?? "", json: "" });
        } else if (type === "response.function_call_arguments.delta" && ev.delta) {
          const acc = calls.get(ev.output_index ?? 0);
          if (acc) acc.args += ev.delta;
        } else if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
          completed = ev.response ?? null;
          usage = completed?.usage ?? usage;
        } else if (type === "response.failed") {
          const detail = ev.response?.error?.message ?? JSON.stringify(ev.response?.error ?? ev).slice(0, 200);
          throw new Error(`ChatGPT応答が失敗しました: ${detail}`);
        } else if (type === "error") {
          const detail = ev.message ?? ev.error?.message ?? JSON.stringify(ev).slice(0, 200);
          throw new Error(`ChatGPTエラー: ${detail}`);
        }
      }
    }
  } finally {
    // 中断(例外・リトライ)でも未読readerとサーバー接続を解放する(ハンドル残存でプロセスが終わらなくなる)
    try { await reader.cancel(); } catch { /* 既に閉じている */ }
  }
  // 完了応答のoutputを最終値として使う(累積の取りこぼし保険)。無ければ累積から組み立てる
  let toolCalls = [];
  if (completed?.output?.length) {
    toolCalls = completed.output.filter((o) => o.type === "function_call").map((o) => ({
      id: o.call_id ?? o.id,
      name: o.name,
      arguments: safeParseArgs(o.arguments),
    }));
  } else {
    toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.call_id, name: c.name, arguments: safeParseArgs(c.args) }));
  }
  return {
    content: text || null,
    reasoning: reasoning || null,
    toolCalls,
    usage,
    raw: completed,
  };
}

function readChunkWithIdleTimeout(reader) {
  const idle = Number(process.env.HIVE_STREAM_IDLE_TIMEOUT_MS ?? 600_000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ストリームが${Math.round(idle / 1000)}秒間無出力です(stall)`)), idle);
  });
  const readP = reader.read();
  // read側がrejectしてもタイマーを解放する(放置するとプロセスが終了しない)
  readP.finally(() => clearTimeout(timer));
  return Promise.race([readP, timeout]);
}

// ===== usageとエラー =====

/** Responses usageを正規usageへ(単価は$/1Mトークン。サブスク契約では単価0=コスト計上なし)。 */
export function codexUsage(u, costRates = null) {
  if (!u) return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = u.output_tokens ?? 0;
  const costUsd = costRates
    ? (promptTokens * (costRates.input ?? 0) + completionTokens * (costRates.output ?? 0)) / 1_000_000
    : 0;
  return { promptTokens, completionTokens, reasoningTokens: 0, costUsd };
}

function translateHttpError(status, text = "") {
  const short = String(text).slice(0, 300);
  if (status === 401) return `ChatGPTの認証が切れています(401)。設定の「モデルと接続」から再認証してください`;
  if (status === 403) return `ChatGPTアカウントで拒否されました(403)。プランの状態を確認してください。${short}`;
  if (status === 404) return `モデルまたはURLが見つかりません(404)。models行のidを確認。${short}`;
  if (status === 429) return `レート制限(429)。プランの利用上限に達している可能性があります。${short}`;
  return `モデルAPIエラー(${status}): ${short}`;
}

function safeParseArgs(s) {
  if (s == null) return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return { _unparsed: String(s) }; }
}
