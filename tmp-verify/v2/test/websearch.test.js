// v7: サーバー側web_search(Z.AI固有ツール)の検証。
// trueで既定パラメータ、オブジェクトで引数展開、functionツールと併存、
// 出典(レスポンスのweb_searchフィールド)をsearchesとして返す。ストリームはusageチャンクから拾う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel } from "../src/model/openai.js";

const SEARCH_RESULT = [
  { title: "Node.js — Run JavaScript Everywhere", link: "https://nodejs.org", refer: "ref_1" },
];

function jsonMockResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => data,
  };
}

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

function withFetch(impl, fn) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = origFetch;
  });
}

test("webSearch:trueでweb_searchツールがbody.toolsに混ざり、出典がsearchesに返る(非ストリーム)", async () => {
  const bodies = [];
  await withFetch(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonMockResponse({
      choices: [{ message: { content: "Node.js 24がLTS" } }],
      usage: { prompt_tokens: 546, completion_tokens: 30 },
      web_search: SEARCH_RESULT,
    });
  }, async () => {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", webSearch: true });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    const ws = bodies[0].tools.find((t) => t.type === "web_search");
    assert.ok(ws, "web_searchがtoolsに含まれる");
    assert.deepEqual(ws.web_search, { enable: true, search_engine: "search-prime", search_result: true });
    assert.equal(bodyHasNoToolChoiceForSearchOnly(bodies[0]), true);
    assert.deepEqual(r.searches, SEARCH_RESULT);
    assert.equal(r.content, "Node.js 24がLTS");
  });
});

test("webSearch:オブジェクトはweb_search引数へそのまま展開される", async () => {
  const bodies = [];
  await withFetch(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonMockResponse({ choices: [{ message: { content: "ok" } }], usage: {} });
  }, async () => {
    const model = new OpenAIModel({
      baseUrl: "http://x/api/v1", apiKey: "k", model: "m",
      webSearch: { search_engine: "search_std", count: 5 },
    });
    await model.chat({ messages: [{ role: "user", content: "hi" }] });
    const ws = bodies[0].tools.find((t) => t.type === "web_search");
    assert.deepEqual(ws.web_search, { enable: true, search_engine: "search_std", count: 5 });
  });
});

test("webSearch未設定ではweb_searchを送らない(既存動作は不変)", async () => {
  const bodies = [];
  await withFetch(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonMockResponse({ choices: [{ message: { content: "ok" } }], usage: {} });
  }, async () => {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(!bodies[0].tools, "toolsそのものが無い");
    assert.equal(r.searches, null);
  });
});

test("functionツールと併存: 両方body.toolsに入りtool_choice:autoはfunction側の従来ルールのまま", async () => {
  const bodies = [];
  await withFetch(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonMockResponse({ choices: [{ message: { content: "ok" } }], usage: {} });
  }, async () => {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", webSearch: true });
    await model.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
    });
    assert.equal(bodies[0].tools.filter((t) => t.type === "web_search").length, 1);
    assert.equal(bodies[0].tools.filter((t) => t.type === "function").length, 1);
    assert.equal(bodies[0].tool_choice, "auto");
  });
});

test("ストリーム: usageチャンクのweb_searchを拾ってsearchesに返す", async () => {
  await withFetch(async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"調べたよ"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":546,"completion_tokens":9},"web_search":[{"title":"Node.js","link":"https://nodejs.org","refer":"ref_1"}]}\n\n',
    "data: [DONE]\n\n",
  ]), async () => {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", webSearch: true });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
    assert.equal(r.content, "調べたよ");
    assert.deepEqual(r.searches, [{ title: "Node.js", link: "https://nodejs.org", refer: "ref_1" }]);
  });
});

// web_search単独(function無し)のときはtool_choiceを付けない=リクエスト形式を実測で通した形に保つ
function bodyHasNoToolChoiceForSearchOnly(body) {
  return body.tool_choice === undefined;
}
