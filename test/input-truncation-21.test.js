// イシュー#21回帰テスト: 未読worker投稿が大量(6,100文字)でもユーザー質問が欠落しないこと。
// 実害の再現(2026-10-04 fix-lead-priority): リーダーがアイドル中にワーカーが6,100文字の報告を投稿し、
// 直後にユーザーが質問(host.say)→ モデル入力の[ボード新着]が text.slice(0,6000) で打ち切られ、
// **順序上あとに積まれるはずの質問は別メッセージなので無事**だが、[ボード新着]メッセージ自体が
// 6,000文字で切られ、その後のseen進行(seen=2)で「その投稿は既読」扱いになり、
// **打ち切られた残り5,100文字は二度とどのターンにも注入されない**(データ欠落)。
// このテストは (1)6,100文字投稿の全文がモデルへ届く (2)以降の投稿も欠落しない
// ことを実ChatHost+Board+モックモデルで検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { runAgentLoop } from "../src/engine/loop.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-trunc21-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("イシュー#21: 未読worker投稿6,100文字→say(質問)でも投稿全文がモデルへ届き、質問も欠落しない", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "t21");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "t21-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  const calls = []; // 各モデル呼び出しの全userメッセージ本文
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      calls.push(messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "t21", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });

  const marker = "TAILMARKER9Z"; // 打ち切り境界(6,000文字)より後ろに置くマーカー
  board.post("t21-beta", "x".repeat(6100 - marker.length) + marker);
  const question = "質問固有トークンQX7K: この報告と私の質問、両方扱ってください";
  host.say(question);

  assert.ok(await waitUntil(() => !host.roundState.get("t21-lead")?.running), "ラウンド完了");
  assert.ok(calls.length >= 1, "モデルが呼ばれる");
  const allInputs = calls.join("\n");
  assert.ok(allInputs.includes(marker), "6,100文字投稿の末尾(打ち切り境界の後ろ)もモデルへ届く");
  assert.ok(allInputs.includes(question), "ユーザー質問も欠落しない");
  rmTree(ws);
});

test("イシュー#21: 打ち切りが起きてもseenは未配信分を既読にしない(残りは後続ターンで再注入される)", async () => {
  const bus = new Bus();
  const board = new Board(bus, "t21b");
  const tasks = new TaskBlackboard(mktmp(), bus);
  const agent = { id: "w", displayName: "ダブ", role: "impl", personaText: "# W", scenarioName: "t" };
  const tail = "GAMMATAILZ7";
  board.post("beta", "x".repeat(6100 - tail.length) + tail);
  board.post("gamma", "ガンマの通常報告: 後続投稿は打ち切りで消えてはいけない");
  const got = { tail: false, gamma: false };
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      const last = messages[messages.length - 1];
      const c = typeof last?.content === "string" ? last.content : "";
      if (c.includes(tail)) got.tail = true;
      if (c.includes("ガンマの通常報告")) got.gamma = true;
      return { content: "done", toolCalls: [], raw: { content: "done" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  // 未読状態を強制(seenBoard: 0)してループを直接走らせる(チャット常駐と同じ経路)
  const r = await runAgentLoop({
    agent,
    model,
    tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks, bus,
    maxTurns: 3,
    shellKind: "bash",
    contextWindow: 200000,
    seenBoard: 0,
  });
  assert.ok(r.ok, "ループ成功");
  assert.ok(r.seenBoard === 2 || r.seenBoard === board.lastId(), "既読位置は投稿1の全文が届いたところまで進む");
  assert.ok(got.gamma, "後続の通常投稿も同じターンで届く(末尾だけ失われる分割はしない)");
  assert.ok(got.tail, "6,100文字投稿の末尾がモデルへ届く");
  rmTree(tasks.workspace);
});
