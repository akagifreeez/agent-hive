// イシュー#25の回帰: 通常の最終テキスト応答(ツール呼出なし)もassistantとしてmessagesに残る。
// 旧実装はtoolCallsがある分岐だけpushしていたため、通常返答が履歴から消え、
// 直後の質問で自身の直前の返答を参照できなかった。
// 検証は実行を伴わないモデル呼出の記録(messages)で行う(既存方針踏襲)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");

function mkAgent() {
  return { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
}

test("#25: 通常テキスト応答がmessagesに残り、直後の質問で参照できる", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-assistant-hist-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = { specs: [], execute: async () => ({ ok: true, text: "" }) };
  // 1ターン目: 通常テキスト応答(ツール呼出なし)。2ターン目も通常テキスト応答で終了
  const turns = ["今日の定数は CACHE_HIT_WARN です", "理解しました"];
  const seen = [];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      return { content: turns[Math.min(seen.length - 1, turns.length - 1)], reasoning: null, toolCalls: [], raw: null, usage: { promptTokens: 1, completionTokens: 1 }, searches: null };
    },
  };
  try {
    const r = await runAgentLoop({ agent: mkAgent(), model, tools, board, tasks, bus, maxTurns: 5 });
    assert.equal(r.ok, true);
    assert.ok(seen.length >= 2, "2回の呼出が起きる(1回目の応答後、終了促し[nudge]で再呼出)");
    // 2回目のリクエストに、1回目の通常応答がassistantメッセージとして含まれる
    const second = seen[1];
    const assistants = second.filter((m) => m.role === "assistant");
    assert.ok(assistants.length >= 1, "assistantメッセージが履歴に残る");
    assert.ok(
      assistants.some((m) => (m.content ?? "").includes("CACHE_HIT_WARN")),
      "1回目の通常応答の内容が2回目のリクエストに含まれる",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("#25: 空応答はassistantとして積まない(続行促しと二重にならない)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-assistant-empty-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = { specs: [], execute: async () => ({ ok: true, text: "" }) };
  // 1ターン目: 空応答→[システム]促し注入。2ターン目: 通常応答で終了
  const contents = ["", "完了しました"];
  const seen = [];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      return { content: contents[Math.min(seen.length - 1, contents.length - 1)], reasoning: null, toolCalls: [], raw: null, usage: { promptTokens: 1, completionTokens: 1 }, searches: null };
    },
  };
  try {
    const r = await runAgentLoop({ agent: mkAgent(), model, tools, board, tasks, bus, maxTurns: 5 });
    assert.equal(r.ok, true);
    const second = seen[1];
    assert.ok(second.some((m) => m.role === "user" && String(m.content).includes("応答が空")), "空応答には促しが入る");
    assert.equal(
      second.filter((m) => m.role === "assistant").length, 0,
      "空応答のassistantメッセージは積まれない",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("#25: ツール呼出分岐の既存挙動は維持(tool_calls付きassistantが残る)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-assistant-tool-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = {
    specs: [{ name: "noop", description: "何もしない", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, text: "ok" }),
  };
  const turns = [
    { content: "読みます", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
    { content: "できました", toolCalls: [] },
  ];
  const seen = [];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const t = turns[Math.min(seen.length - 1, turns.length - 1)];
      return { content: t.content, reasoning: null, toolCalls: t.toolCalls ?? [], raw: null, usage: { promptTokens: 1, completionTokens: 1 }, searches: null };
    },
  };
  try {
    const r = await runAgentLoop({ agent: mkAgent(), model, tools, board, tasks, bus, maxTurns: 5 });
    assert.equal(r.ok, true);
    const second = seen[1];
    const a = second.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.ok(a, "ツール呼出分岐のassistantが残る(従来どおり)");
    assert.equal(a.tool_calls[0].id, "t1");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
