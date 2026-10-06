// v6.5: ストリーミング(SSE解析+onDelta)とsteering(ターン境界の入力割込み)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { ChatHost } from "../src/engine/chat.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { OpenAIModel, setModelSleep } from "../src/model/openai.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-stream-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
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

test("chat(stream): SSEを解析しテキスト/思考/ツール/usageを累積、断片をonDeltaへ流す", async () => {
  const deltas = [];
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"思考A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  setModelSleep(async () => {});
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(r.content, "こんにちは");
    assert.equal(r.reasoning, "思考A");
    assert.equal(r.toolCalls.length, 1);
    assert.deepEqual(r.toolCalls[0].arguments, { path: "a.txt" });
    assert.equal(r.usage.promptTokens, 5);
    assert.deepEqual(deltas.map((d) => d.kind), ["think", "say", "say"]);
    assert.equal(bodies[0].stream, true);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat(stream): zai/DeepSeek流reasoning_contentも思考テキストとして累積する", async () => {
  const deltas = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"深く"}}]}

',
      'data: {"choices":[{"delta":{"reasoning_content":"考えた"}}]}

',
      'data: {"choices":[{"delta":{"content":"答え"}}]}

',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}

',
      "data: [DONE]

",
    ]);
  };
  setModelSleep(async () => {});
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(r.reasoning, "深く考えた"); // reasoning_content断片が連結される
    assert.equal(r.content, "答え");
    assert.deepEqual(deltas.filter((d) => d.kind === "think").map((d) => d.text), ["深く", "考えた"]);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat(onDelta無し): 従来どおり非ストリーミングで動く", async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  try {
    const model = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "ok");
    assert.equal(bodies[0].stream, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("steering: ラウンド実行中の入力はターン境界で割込む(drainInput)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "s");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const queue = [];
  const inputsSeen = [];
  let n = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      n++;
      for (const m of messages) {
        if (m.role === "user" && String(m.content).startsWith("[入力]")) inputsSeen.push(m.content);
      }
      if (n === 1) {
        queue.push("途中からの追加指示"); // ユーザーがラウンド実行中に投げた想定
        return { content: null, toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "s.txt", content: "x" } }], raw: { content: null }, usage: { promptTokens: 10, completionTokens: 1 } };
      }
      return { content: "対応しました", toolCalls: [], raw: { content: "対応しました" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
  await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 5, drainInput: () => queue.splice(0) });
  assert.ok(inputsSeen.some((t) => t.includes("途中からの追加指示")), "ターン境界で割込入力がモデルへ届く");
  rmTree(ws);
});

test("ChatHost steering: 実行中のsayは待ち行列ではなくターン境界で渡る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "s");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const inputsSeen = [];
  let contentSeen = false;
  let calls = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      calls++;
      for (const m of messages) {
        if (m.role === "user" && String(m.content).startsWith("[入力]")) inputsSeen.push(m.content);
        if (String(m.content).includes("割込み指示")) contentSeen = true;
      }
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 400)); // この間にユーザーが投げる
        return { content: null, toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "s.txt", content: "x" } }], raw: { content: null }, usage: { promptTokens: 10, completionTokens: 1 } };
      }
      return { content: "done", toolCalls: [], raw: { content: "done" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "s", autoContinueRounds: 1, maxTurnsPerRound: 5, staggerMs: 0,
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.say("開始");
  await new Promise((r) => setTimeout(r, 150)); // ラウンド実行中を狙う
  host.say("割込み指示");
  assert.ok(await waitUntil(() => calls >= 2, 10000));
  // 設計: 実行中のsayは「汎用キックオフの割込み([入力])」+「本文はボード新着」の2経路で届く
  assert.ok(inputsSeen.length >= 1, "ターン境界で割込み([入力])がモデルへ届く");
  assert.ok(contentSeen, "本文(割込み指示)もボード経由で届く");
  rmTree(ws);
});
