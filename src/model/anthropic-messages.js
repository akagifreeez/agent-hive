// anthropic-messages ワイヤ形式のアダプタ(models.providers.<id>.api="anthropic-messages"で選択)。
// Anthropic Messages API(Claude)。API key(x-api-key)とsetup-token/OAuthトークン
// (sk-ant-oat01- → Bearer+claude-code/oauth betaヘッダ)の両契約形態を1本で扱う。
// 依存ゼロ(node内蔵fetch)。応答はOpenAIModelと同じ正規形(chat() → content/toolCalls/usage)。
// リトライはopenai.jsと同じZCode流(指数バックオフ+Retry-After優先)を共用。
// 未対応: extended thinking(reasoningEffortは無視=既定オフ。将来拡張)・画像入力。
import {
  RETRY_MAX_RETRIES, EMPTY_COMPLETION_MAX_RETRIES,
  computeRetryDelay, isRetryableStatus, modelSleep, parseRetryAfterMs,
} from "./openai.js";

export class AnthropicModel {
  /**
   * @param {{baseUrl: string, apiKey: string, model?: string, temperature?: number, maxTokens?: number, timeoutMs?: number, reasoningEffort?: string|null, webSearch?: boolean|object|null, costRates?: {input?: number, output?: number, cacheRead?: number, cacheWrite?: number}|null}} cfg
   *   webSearchはAnthropicに相当物が無いため無視(契約を揃えるため受け取るだけ)。
   *   costRates: カタログ単価($/1Mトークン)。Anthropicはusage.costを返さないのでこれが唯一のコスト源。
   */
  constructor({ baseUrl, apiKey, model, temperature = 0.7, maxTokens = 2000, timeoutMs = 120000, reasoningEffort = null, webSearch = null, costRates = null }) {
    if (!apiKey) throw new Error("APIキーが未設定です(環境変数か auth.file を設定してください)");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.reasoningEffort = reasoningEffort;
    this.costRates = costRates;
  }

  async chat({ messages, tools, onDelta = null }) {
    const body = toAnthropicRequest({ messages, tools, cfg: this });
    const useStream = typeof onDelta === "function";
    if (useStream) body.stream = true;
    let emptyRetries = 0;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(messagesUrl(this.baseUrl), {
          method: "POST",
          headers: authHeaders(this.apiKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // ネットワーク系(タイムアウト含む)はリトライ可
        if (attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt));
          continue;
        }
        throw new Error(`モデルAPIに接続できません: ${err.message}`);
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (isRetryableStatus(res.status) && attempt <= RETRY_MAX_RETRIES) {
          await modelSleep(computeRetryDelay(attempt, parseRetryAfterMs(res)));
          continue;
        }
        throw new Error(translateHttpError(res.status, bodyText));
      }
      let result, usage;
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
        usage = parsed.usage;
        result = parsed;
      } else {
        const data = await res.json().catch(() => null);
        if (!data || data.type === "error") throw new Error(translateApiError(data));
        usage = data.usage ?? null;
        result = fromContentBlocks(data.content ?? [], data.stop_reason);
      }
      // 空応答(テキストもツールもusageも無い)はOpenAIModelと同様1回だけリトライ
      const empty = !result.content && !(result.toolCalls?.length) && !usage;
      if (empty && emptyRetries < EMPTY_COMPLETION_MAX_RETRIES) {
        emptyRetries++;
        await modelSleep(computeRetryDelay(attempt));
        continue;
      }
      return {
        content: result.content ?? null,
        reasoning: result.reasoning ?? null,
        toolCalls: result.toolCalls ?? [],
        raw: result.raw ?? null,
        usage: anthropicUsage(usage, this.costRates),
        searches: null, // web_searchは非対応
      };
    }
  }
}

// ===== 認証とURL =====

// setup-token/OAuthトークン(sk-ant-oat01-)はBearer+Claude Codeアイデンティティ、
// API keyはx-api-key。OpenClaw(@openclaw/ai)と同じ分岐。
export function authHeaders(apiKey) {
  const h = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey.includes("sk-ant-oat")) {
    h.authorization = `Bearer ${apiKey}`;
    h["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
  } else {
    h["x-api-key"] = apiKey;
  }
  return h;
}

// baseUrlが/v1で終わるなら/messages、そうでなければ/v1/messages(OpenClawと同じ補完)
export function messagesUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, "");
  return b.endsWith("/v1") ? `${b}/messages` : `${b}/v1/messages`;
}

// contentが配列(画像添付のマルチモーダル形)でもテキスト部分だけ取り出す。
// String()直接は"[object Object]"になり文脈を汚染する。画像は本ワイヤ未対応(テキストのみ届ける)
function textOf(content) {
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
  }
  return content ?? "";
}

// ===== リクエスト変換(OpenAI形 → Anthropic形) =====

/** @param {{messages: Array, tools: Array|null, cfg: AnthropicModel}} p */
export function toAnthropicRequest({ messages, tools, cfg }) {
  const system = [];
  const out = [];
  for (const m of messages ?? []) {
    if (m.role === "system") {
      if (m.content) system.push(String(m.content));
      continue;
    }
    if (m.role === "tool") {
      // OpenAIのtool応答 → Anthropicはuserメッセージ内のtool_resultブロック(連続は集約)
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && (m.tool_calls?.length)) {
      const blocks = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: "text", text: String(t) });
      for (const tc of m.tool_calls) {
        const fn = tc.function ?? tc;
        blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input: safeParseArgs(fn.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (Array.isArray(m.content)) {
      // マルチモーダル(画像添付): Anthropic形のimage source(base64)へ変換する
      // (attachImageはOpenAI形のimage_url/data URLで積む)
      const blocks = [];
      for (const c of m.content) {
        if (c?.type === "text" && c.text) blocks.push({ type: "text", text: String(c.text) });
        else if (c?.type === "image_url" && c.image_url?.url) {
          const dm = /^data:([^;]+);base64,(.+)$/.exec(String(c.image_url.url));
          if (dm) blocks.push({ type: "image", source: { type: "base64", media_type: dm[1], data: dm[2] } });
        }
      }
      if (blocks.length) out.push({ role: m.role === "assistant" ? "assistant" : "user", content: blocks });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) });
  }
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens, // Anthropicは必須
    messages: out,
  };
  if (system.length) body.system = system.join("\n\n");
  // thinking有効時はtemperature固定の制約があるため、thinking未対応の今は常に送る
  if (cfg.temperature != null && !cfg.reasoningEffort) body.temperature = cfg.temperature;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return body;
}

// ===== レスポンス変換 =====

/** contentブロック配列(非ストリーム応答またはストリーム累積)を正規形へ。
 * @returns {{content: string|null, reasoning: string|null, toolCalls: Array, raw: Object|null}} */
export function fromContentBlocks(blocks, stopReason = null) {
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") text += b.text ?? "";
    else if (b.type === "thinking") reasoning += b.thinking ?? "";
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, name: b.name, arguments: b.input ?? {} });
    }
  }
  return {
    content: text || null,
    reasoning: reasoning || null,
    toolCalls,
    raw: { stop_reason: stopReason, blocks },
  };
}

/** Anthropicのusageを正規usageへ(+カタログ単価でのコスト概算)。
 * 単価は$/1Mトークン。cache_read/cache_creationは対応単価があれば加算。 */
export function anthropicUsage(u, costRates = null) {
  if (!u) return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const costUsd = costRates
    ? (promptTokens * (costRates.input ?? 0) + completionTokens * (costRates.output ?? 0)
      + cacheRead * (costRates.cacheRead ?? 0) + cacheWrite * (costRates.cacheWrite ?? 0)) / 1_000_000
    : 0;
  return { promptTokens, completionTokens, reasoningTokens: 0, costUsd };
}

// ===== SSEストリーム解析 =====

async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  let stopReason = null;
  /** @type {Map<number, {type: string, text: string, thinking: string, id: string, name: string, json: string}>} */
  const blockAcc = new Map();
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
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === "message_start") {
          usage = { ...(ev.message?.usage ?? {}) };
        } else if (ev.type === "content_block_start") {
          const cb = ev.content_block ?? {};
          blockAcc.set(ev.index, { type: cb.type, text: "", thinking: "", id: cb.id ?? "", name: cb.name ?? "", json: "" });
        } else if (ev.type === "content_block_delta") {
          const acc = blockAcc.get(ev.index);
          const d = ev.delta ?? {};
          if (!acc) continue;
          if (d.type === "text_delta" && d.text) {
            acc.text += d.text;
            onDelta?.({ kind: "say", text: d.text });
          } else if (d.type === "thinking_delta" && d.thinking) {
            acc.thinking += d.thinking;
            onDelta?.({ kind: "think", text: d.thinking });
          } else if (d.type === "input_json_delta" && d.partial_json) {
            acc.json += d.partial_json;
          }
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
        } else if (ev.type === "error") {
          throw new Error(translateApiError(ev));
        }
      }
    }
  } finally {
    // 中断(例外・リトライ)でも未読readerとサーバー接続を解放する
    try { await reader.cancel(); } catch { /* 既に閉じている */ }
  }
  const blocks = [...blockAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: safeParseArgs(b.json) };
    return b;
  });
  const result = fromContentBlocks(blocks, stopReason);
  return { ...result, usage };
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

// ===== エラーとユーティリティ =====

function translateApiError(data) {
  const msg = data?.error?.message ?? data?.error?.type ?? JSON.stringify(data).slice(0, 300);
  return `モデルAPIエラー: ${msg}`;
}

function translateHttpError(status, text = "") {
  const short = String(text).slice(0, 300);
  if (status === 401) return `APIキーが拒否されました(401)。鍵またはsetup-tokenを確認。${short}`;
  if (status === 404) return `モデルまたはURLが見つかりません(404)。model/baseUrlを確認。${short}`;
  if (status === 429) return `レート制限(429)。時間を置くかモデルを見直し。${short}`;
  if (status === 400 && short.includes("max_tokens")) return `max_tokensが不正です(400)。models行のmaxTokensを確認。${short}`;
  return `モデルAPIエラー(${status}): ${short}`;
}

function safeParseArgs(s) {
  if (s == null) return {};
  if (typeof s === "object") return s;
  try {
    return JSON.parse(s);
  } catch {
    return { _unparsed: String(s) };
  }
}
