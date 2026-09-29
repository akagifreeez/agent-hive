// anthropic-messagesアダプタ: ヘッダ分岐・リクエスト/レスポンス変換・SSE・usageコスト・factory経由dispatch
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicModel, authHeaders, messagesUrl, toAnthropicRequest, fromContentBlocks, anthropicUsage } from "../src/model/anthropic-messages.js";
import { createModelFactory } from "../src/model/factory.js";

function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => {
        const items = lines.map((l) => encoder.encode(l));
        let i = 0;
        return { read: async () => (i < items.length ? { done: false, value: items[i++] } : { done: true }) };
      },
    },
  };
}

test("authHeaders: API keyはx-api-key、setup-token(sk-ant-oat)はBearer+betaヘッダ", () => {
  const api = authHeaders("sk-ant-api03-xxx");
  assert.equal(api["x-api-key"], "sk-ant-api03-xxx");
  assert.equal(api.authorization, undefined);
  assert.equal(api["anthropic-version"], "2023-06-01");
  const oat = authHeaders("sk-ant-oat01-yyy");
  assert.equal(oat.authorization, "Bearer sk-ant-oat01-yyy");
  assert.ok(oat["anthropic-beta"].includes("oauth-2025-04-20"), "OAuth betaヘッダを付ける");
  assert.ok(!("x-api-key" in oat));
});

test("messagesUrl: baseUrlの/v1有無で補完される", () => {
  assert.equal(messagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesUrl("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesUrl("https://proxy.example/anthropic/"), "https://proxy.example/anthropic/v1/messages");
});

test("toAnthropicRequest: systemはトップレベルへ分離、tool_result/tool_use/toolsを変換", () => {
  const cfg = { model: "claude-sonnet-5-5", maxTokens: 3000, temperature: 0.5, reasoningEffort: null };
  const body = toAnthropicRequest({
    cfg,
    messages: [
      { role: "system", content: "あなたは吟味役" },
      { role: "user", content: "見て" },
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "中身" },
      { role: "assistant", content: "確認した" },
    ],
    tools: [{ name: "read_file", description: "読む", parameters: { type: "object" } }],
  });
  assert.equal(body.system, "あなたは吟味役");
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.max_tokens, 3000, "Anthropicはmax_tokens必須");
  assert.equal(body.temperature, 0.5);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[1].role, "assistant");
  assert.deepEqual(body.messages[1].content, [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }]);
  assert.equal(body.messages[2].role, "user");
  assert.deepEqual(body.messages[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "中身" }]);
  assert.deepEqual(body.tools, [{ name: "read_file", description: "読む", input_schema: { type: "object" } }]);
});

test("toAnthropicRequest: thinking未対応の間はreasoningEffort指定時にtemperatureを送らない", () => {
  const body = toAnthropicRequest({ cfg: { model: "m", maxTokens: 100, temperature: 0.7, reasoningEffort: "high" }, messages: [{ role: "user", content: "x" }] });
  assert.equal(body.temperature, undefined);
});

test("fromContentBlocks: text/thinking/tool_useを正規形へ", () => {
  const r = fromContentBlocks([
    { type: "thinking", thinking: "考え" },
    { type: "text", text: "答え" },
    { type: "tool_use", id: "t1", name: "edit_file", input: { path: "b.txt" } },
  ], "tool_use");
  assert.equal(r.content, "答え");
  assert.equal(r.reasoning, "考え");
  assert.deepEqual(r.toolCalls, [{ id: "t1", name: "edit_file", arguments: { path: "b.txt" } }]);
});

test("anthropicUsage: cache込みでカタログ単価からコストを概算", () => {
  const u = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 };
  const r = anthropicUsage(u, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  const expected = (1000 * 4 + 500 * 20 + 2000 * 0.2 + 100 * 5) / 1e6;
  assert.ok(Math.abs(r.costUsd - expected) < 1e-12);
  assert.equal(anthropicUsage(null).costUsd, 0);
  assert.equal(anthropicUsage(u, null).costUsd, 0, "単価不明なら0");
});

test("chat(非ストリーム): 応答を正規形へ・usageにコスト概算が入る", async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  let seenHeaders = null;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    seenHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        type: "message",
        content: [{ type: "text", text: "こんにちは" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    };
  };
  try {
    const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api03-k", model: "claude-sonnet-5-5", maxTokens: 100, costRates: { input: 3, output: 15 } });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "こんにちは");
    assert.equal(r.usage.promptTokens, 10);
    assert.equal(r.usage.completionTokens, 20);
    assert.equal(r.usage.costUsd, (10 * 3 + 20 * 15) / 1e6);
    assert.equal(bodies[0].model, "claude-sonnet-5-5");
    assert.equal(bodies[0].max_tokens, 100);
    assert.equal(seenHeaders["x-api-key"], "sk-ant-api03-k");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("chat(ストリーム): SSEを累積しtool_useのJSONを組み立て、断片をonDeltaへ流す", async () => {
  const deltas = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"こん"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"にちは"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t9","name":"read_file"}}\n\n',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}\n\n',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"a.txt\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":2}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":11}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  try {
    const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-oat01-tok", model: "claude-sonnet-5-5", maxTokens: 100 });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(r.content, "こんにちは");
    assert.equal(r.reasoning, "思考");
    assert.deepEqual(r.toolCalls[0].arguments, { path: "a.txt" });
    assert.equal(r.toolCalls[0].name, "read_file");
    assert.equal(r.usage.promptTokens, 7);
    assert.equal(r.usage.completionTokens, 11);
    assert.deepEqual(deltas.map((d) => d.kind), ["think", "say", "say"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("chat: エラー応答は理由つきの例外(401はリトライしない)", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}' };
  };
  try {
    const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", apiKey: "bad", model: "m", timeoutMs: 1000 });
    await assert.rejects(() => model.chat({ messages: [{ role: "user", content: "hi" }] }), /401.*invalid x-api-key/);
    assert.equal(calls, 1, "認証エラーはリトライしない");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("factory: api=anthropic-messages がAnthropicModelへdispatchされる", () => {
  const cfg = {
    models: {
      default: "anthropic/claude-sonnet-5-5",
      fallbacks: [],
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          auth: { value: "sk-ant-oat01-token-123456" },
          models: [{ id: "claude-sonnet-5-5", contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }],
        },
      },
    },
    model: { model: "claude-sonnet-5-5" },
  };
  const m = createModelFactory(cfg)();
  assert.ok(m instanceof AnthropicModel);
  assert.equal(m.model, "claude-sonnet-5-5");
  assert.equal(m.maxTokens, 128000);
  assert.deepEqual(m.costRates, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  // 内蔵カタログのanthropic行(単価付き)でも解決できる
  const cfg2 = {
    models: { default: "anthropic/claude-haiku-4-5", fallbacks: [], providers: { anthropic: { auth: { value: "sk-ant-api03-key-123456" } } } },
    model: {},
  };
  const m2 = createModelFactory(cfg2)();
  assert.ok(m2 instanceof AnthropicModel);
  assert.equal(m2.baseUrl, "https://api.anthropic.com", "設定省略時は内蔵カタログのbaseUrl");
  assert.deepEqual(m2.costRates, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
});
