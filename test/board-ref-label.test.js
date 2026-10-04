// イシュー#20: ボード新着の注入参照がラベル/日時付きで保存されることの検証
// 番号単独の参照(#12等)はボードクリア後のid再採番で衝突するため、
// メモリに残る注入文は「from #id (日時/スレッド): 本文」形式を持つ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { createTools } from "../src/engine/tools.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONA = join(ROOT, "agents", "alpha.md");

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-boardref-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsロックは無視 */ } }

function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: step.usage ?? { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

test("ボード新着の注入は「from #id (日時/スレッド)」ラベル付き(番号単独参照の衝突防止)", async () => {
  const ws = mktmp();
  try {
    const bus = new Bus();
    const board = new Board(bus, "demo-thread");
    const tasks = new TaskBlackboard(ws, bus);
    const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
    const tools = createTools({ agent, workspace: ws, board, tasks, bus });
    // 先にボードへ投稿しておき、ループ内の既読以降注入で形式を検証
    board.post("beta", "進捗(1)です");
    board.post("gamma", "進捗(2)です");
    const captured = [];
    const model = {
      maxTokens: 4000,
      async chat({ messages }) {
        const b = messages.find((m) => typeof m.content === "string" && m.content.startsWith("[ボード新着]"));
        if (b) captured.push(b.content);
        // 終了: idle応答
        return { content: "ok", toolCalls: [], raw: { role: "assistant", content: "ok", tool_calls: [] }, usage: { promptTokens: 10, completionTokens: 5 } };
      },
    };
    const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 3, seenBoard: 0 });
    assert.ok(captured.length >= 1, "ボード新着が注入されている");
    const text = captured[0];
    // ラベル・番号・日時・スレッド付きの形式
    assert.match(text, /beta #1 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\/demo-thread\): 進捗\(1\)です/);
    assert.match(text, /gamma #2 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\/demo-thread\): 進捗\(2\)です/);
    assert.equal(r.seenBoard, 2);
  } finally {
    rmTree(ws);
  }
});

test("pruneMemoriesのヘッダは日時を含む(いつ刈り取りられたか記録が残る)", async () => {
  const { pruneMemories } = await import("../src/engine/compact.js");
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: `m${i}` });
  const r = pruneMemories(msgs, { keepRecent: 2, maxMessages: 10, maxBytes: 1024 * 1024 });
  assert.match(r.messages[1].content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});
