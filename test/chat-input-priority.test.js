// fix-lead-input-priority(イシュー#20): リーダー起床注入文のユーザー入力優先
// 再現シナリオ: メインチャットで質問→直後にワーカー投稿が流れると、旧注入文
// 「直前のボード新着を確認して応答してください」が後発のワーカー投稿へ注視させ、
// ユーザー質問への応答が後回しになっていた。変更後の文面がユーザー入力を最優先
// としていること、および並発ケースでユーザー起点のwakeが先に走ることを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-chatprio-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("リーダー注入文: ユーザー入力を最優先の応答対象とし、直近のワーカー投稿は触れなくてよいことを明示", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/engine/chat.js", import.meta.url), "utf8"));
  const line = src.split("\n").find((l) => l.includes("[チャット]"));
  assert.ok(line, "say()の注入文が見つかる");
  assert.ok(!line.includes("直前のボード新着を確認して応答してください"), "旧文面(ボード新着への注視指示)が残っていない");
  assert.ok(line.includes("最優先") && line.includes("ユーザー入力"), "ユーザー入力が最優先であることを文面が明示している");
  assert.ok(line.includes("ワーカー投稿"), "直近のワーカー投稿の扱い(触れなくてよい)に言及している");
});

test("並発シナリオ: ユーザー入力sayの直後にワーカー投稿が流れても、ユーザー起点wakeが先に登録される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "cp");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "cp-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  let chats = 0;
  const model = { maxTokens: 100, async chat() { chats++; return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const host = new ChatHost({
    mains: [agent], project: "cp", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });

  // 実際の発生順: say(ユーザー質問)→ 直後にワーカー投稿(イシュー#20の指摘)
  host.say("この数字の意味を教えて"); // → sayのwakeが即座に(遅延0)ラウンドを開始する
  assert.ok(await waitUntil(() => chats >= 1), "say直後のラウンド(stagger 0)が最初に走る");
  const firstKickoff = host.roundState.get("cp-lead")?.kickoff ?? "";
  assert.ok(firstKickoff.includes("[チャット]"), "ユーザー起点の注入文でラウンドが開始している");
  assert.ok(firstKickoff.includes("最優先"), "注入文がユーザー入力最優先を指示している");
  // ユーザー起点ラウンド開始後にワーカー投稿→@呼び出しwakeはpendingへ積まれる(既存のroundState経路)
  bus.emit("board", { from: "cp-beta", thread: "cp", text: "先にうちのレビュー指摘を見てほしい @リーダー" });
  assert.ok(await waitUntil(() => chats >= 2), "ボード投稿起点の2ラウンド目が走る");
  const secondKickoff = host.roundState.get("cp-lead")?.kickoff ?? "";
  assert.ok(secondKickoff.includes("[ボード]"), "2ラウンド目はボード起点の注入文");
  rmTree(ws);
});
