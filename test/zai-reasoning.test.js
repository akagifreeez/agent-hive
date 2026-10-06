// zai coding plan(GLM)の思考テキスト(reasoning_content)をOpenAI互換アダプタが拾えることの検証。
// OpenRouter流のreasoningフィールドの回帰も併せて確認する。依存ゼロ(fetchモック)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel } from "../src/model/openai.js";

// SSE応答のモック(ReadableStreamをResponseへ包む)
function sseResponse(lines) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function withFetch(fn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = orig; });
}

const USER = [{ role: "user", content: "hi" }];
const USAGE = { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.001 };

test("OpenAIModel: 非ストリームでzai流reasoning_contentのみの応答からreasoningを拾う", async () => {
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "答え", reasoning_content: "まずXを確認しよう" } }],
        usage: USAGE,
      }),
    }),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER });
      assert.equal(r.reasoning, "まずXを確認しよう");
      assert.equal(r.content, "答え");
    },
  );
});

test("OpenAIModel: 非ストリームでreasoning優先(両方来たらreasoning)、旧reasoning単独も回帰なし", async () => {
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "a", reasoning: "旧形式", reasoning_content: "新形式" } }],
        usage: USAGE,
      }),
    }),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER });
      assert.equal(r.reasoning, "旧形式");
    },
  );
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "a", reasoning: "旧形式のみ" } }],
        usage: USAGE,
      }),
    }),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER });
      assert.equal(r.reasoning, "旧形式のみ");
    },
  );
});

test("OpenAIModel: ストリームでdelta.reasoning_contentを累積しonDelta(think)へも流す", async () => {
  const deltas = [];
  await withFetch(
    async () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"日"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"本語で"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答え"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":' + JSON.stringify(USAGE) + "}\n\n",
      "data: [DONE]\n\n",
    ]),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER, onDelta: (d) => deltas.push(d) });
      assert.equal(r.reasoning, "日本語で");
      assert.equal(r.content, "答え");
      assert.deepEqual(deltas.filter((d) => d.kind === "think").map((d) => d.text), ["日", "本語で"]);
    },
  );
});

test("OpenAIModel: ストリームで旧delta.reasoningは回帰なし、同一deltaに両形式が来たらreasoning優先", async () => {
  await withFetch(
    async () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"旧"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":' + JSON.stringify(USAGE) + "}\n\n",
    ]),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER, onDelta: () => {} });
      assert.equal(r.reasoning, "旧");
    },
  );
  await withFetch(
    async () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"旧","reasoning_content":"新"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":' + JSON.stringify(USAGE) + "}\n\n",
    ]),
    async () => {
      const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
      const r = await m.chat({ messages: USER, onDelta: () => {} });
      assert.equal(r.reasoning, "旧");
    },
  );
});
