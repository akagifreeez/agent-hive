// zai/DeepSeek流 reasoning_content の取得テスト(OpenAI互換アダプタ)。
// stream/non-stream両経路で、reasoning_contentのみのダミー応答から res.reasoning が
// 取れることを固定する。旧OpenRouter流 reasoning のみの応答の回帰もここで確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel, setModelSleep } from "../src/model/openai.js";

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
        return {
          read: async () => (i < items.length ? { done: false, value: items[i++] } : { done: true }),
        };
      },
    },
  };
}

test("chat(stream): zai流reasoning_contentのみのdeltaからreasoningが取れる", async () => {
  const deltas = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"zaiの思考1"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"+思考2"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答え"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
    "data: [DONE]\n\n",
  ]);
  setModelSleep(async () => {});
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(r.reasoning, "zaiの思考1+思考2");
    assert.equal(r.content, "答え");
    // UI思考表示用の断片もthinkとして流れる
    assert.deepEqual(deltas.filter((d) => d.kind === "think").map((d) => d.text), ["zaiの思考1", "+思考2"]);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat(stream): reasoningとreasoning_contentが同一deltaに混在したら連結される", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning":"A","reasoning_content":"B"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);
  setModelSleep(async () => {});
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
    assert.equal(r.reasoning, "AB");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat(非ストリーム): zai流reasoning_contentのみのmessageからreasoningが取れる(旧reasoningがあれば優先)", async () => {
  const origFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "答え", reasoning_content: "zaiの思考本文" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "答え2", reasoning: "旧流の思考", reasoning_content: "zaiの思考2" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };
  try {
    const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r1 = await m.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r1.reasoning, "zaiの思考本文");
    assert.equal(r1.content, "答え");
    const r2 = await m.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r2.reasoning, "旧流の思考"); // 両方ある場合は旧フィールドを優先(挙動不変)
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("回帰: 旧OpenRouter流reasoningのみの応答は従来どおり取れる(stream/non-stream)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (JSON.parse(opts.body).stream) {
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning":"旧流の思考"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "答え", reasoning: "旧流の思考" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  setModelSleep(async () => {});
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const streamed = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
    assert.equal(streamed.reasoning, "旧流の思考");
    assert.equal(streamed.content, "ok");
    const plain = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(plain.reasoning, "旧流の思考");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});
