// OpenAI互換(chat/completions)アダプタ。GLM(Z.AI/OpenRouter)等を想定。
// 依存ゼロ(node内蔵fetch)。
export class OpenAIModel {
  constructor({ baseUrl, apiKey, model, temperature = 0.7, maxTokens = 2000, timeoutMs = 120000 }) {
    if (!apiKey) throw new Error("APIキーが未設定です(環境変数か apiKeyFile を設定してください)");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
  }

  async chat({ messages, tools }) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = "auto";
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      if (process.env.HIVE_DEBUG_FILE) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname: d } = await import("node:path");
        try {
          mkdirSync(d(process.env.HIVE_DEBUG_FILE), { recursive: true });
          writeFileSync(process.env.HIVE_DEBUG_FILE, JSON.stringify({ status: res.status, messages, tools }, null, 1));
        } catch {}
      }
      throw new Error(await translateHttpError(res));
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`応答の形式が不正です: ${JSON.stringify(data).slice(0, 300)}`);
    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseArgs(tc.function.arguments),
      })),
      raw: msg,
    };
  }
}

function safeParseArgs(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _unparsed: String(s) };
  }
}

async function translateHttpError(res) {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 401) return `APIキーが拒否されました(401)。${text}`;
  if (res.status === 404) return `モデルまたはURLが見つかりません(404)。model/baseUrlを確認。${text}`;
  if (res.status === 429) return `レート制限(429)。時間を置くかモデルを見直し。${text}`;
  return `モデルAPIエラー(${res.status}): ${text}`;
}
