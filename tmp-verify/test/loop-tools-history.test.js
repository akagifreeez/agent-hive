// レビュー修正の回帰: ループの履歴組み立ては共通形 res.toolCalls から行い raw に依存しない。
// anthropic-messages/chatgpt の raw はOpenAI形でないため、旧実装(raw.tool_calls参照)では
// 次リクエストからツール呼び出しが欠けて会話が壊れていた
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

test("ループ: ワイヤ形式に依らず共通形toolCallsから履歴を組み立てる(anthropic形rawでも欠けない)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-hist-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = {
    specs: [{ name: "noop", description: "何もしない", parameters: { type: "object" } }],
    execute: async () => ({ ok: true, text: "ok" }),
  };
  // 1ターン目: anthropic-messages と同形の raw(OpenAI形のtool_callsを持たない)+共通形toolCalls
  // 2ターン目: テキストのみ(ツール結果を受けて答える)
  const turns = [
    {
      content: "ファイルを読みます",
      toolCalls: [{ id: "toolu_1", name: "noop", arguments: { path: "a.txt" } }],
      raw: { stop_reason: "tool_use", blocks: [{ type: "tool_use", id: "toolu_1", name: "noop", input: { path: "a.txt" } }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
    {
      content: "できました",
      raw: { stop_reason: "end_turn", blocks: [{ type: "text", text: "できました" }] },
      usage: { promptTokens: 1, completionTokens: 1 },
    },
  ];
  const seen = [];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const t = turns[Math.min(seen.length - 1, turns.length - 1)];
      return { content: t.content, reasoning: null, toolCalls: t.toolCalls ?? [], raw: t.raw, usage: t.usage, searches: null };
    },
  };
  try {
    const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 3 });
    assert.equal(r.ok, true);
    assert.ok(seen.length >= 2, "2回リクエストする");
    const second = seen[1];
    const assistant = second.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.ok(assistant, "assistant tool_callsが履歴に残る(raw依存なし)");
    assert.equal(assistant.tool_calls[0].id, "toolu_1");
    assert.equal(assistant.tool_calls[0].function.name, "noop");
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: "a.txt" });
    const toolMsg = second.find((m) => m.role === "tool" && m.tool_call_id === "toolu_1");
    assert.ok(toolMsg, "対応するツール結果も残る");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
