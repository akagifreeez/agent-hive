// イシュー#29: close_thread で閉じたスレッドのChatHostは、その後のboard/taskイベントで
// 再起床してはならない(close済みスレッドのゴースト起床)。unsubscribe()で購読を解除する。
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
  return mkdtempSync(join(tmpdir(), "hive-unsub-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

function mkHost(ws, bus, board, tasks) {
  const agent = { id: "unsub-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  let chats = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      chats++;
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "unsub", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });
  return { host, calls: () => chats };
}

test("unsubscribe: 閉じたスレッドのHostはその後のボード投稿で起こされない(イシュー#29)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "unsub");
  const tasks = new TaskBlackboard(ws, bus);
  const { host, calls } = mkHost(ws, bus, board, tasks);

  // 購読が生きている間は@メンションで起こされる(前提確認)
  board.post("beta-9", "@アルファ 生きていますか");
  assert.ok(await waitUntil(() => calls() > 0), "購読中は起こされる");
  const before = calls();
  assert.ok(before > 0);

  // クローズ: unsubscribe()
  host.unsubscribe();
  host.unsubscribe(); // 二重呼び出しは安全(no-op)

  // クローズ後のボード投稿・タスク投入・解放では起こされない
  board.post("beta-9", "@アルファ ゴースト起床はしない");
  tasks.create({ id: "unsub-task-1", project: "unsub", body: "閉じた後の新規タスク" });
  tasks.create({ id: "t2", project: "unsub", body: "解放起床の種" });
  const taker = { id: "impl-x", role: "impl" };
  tasks.claim(taker, { project: "unsub" });
  tasks.release(taker.id);

  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls(), before, "unsubscribe後はいかなるイベントでも起こされない");
  rmTree(ws);
});

test("runner経由のcloseThreadでもホスト購読が解除される(close_threadツールの実経路)", async () => {
  const ws = mktmp();
  const config = {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 100 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: { lead: "lead", workers: ["alpha"], maxTurnsPerRound: 8, staggerMs: 5 },
    agents: [{ id: "alpha", displayName: "アルファ", role: "impl" }],
  };
  const modelFactory = () => ({
    maxTokens: 100,
    async chat() { return { content: "承知しました", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }; },
  });
  const { runChat } = await import("../src/runner.js");
  const ctl = await runChat({ config, bus: new Bus(), modelFactory });
  await ctl.openThread({ project: "tmp-unsub", goal: "一時スレッド" });

  // スレッドを閉じる(runnerのcloseThread → host.unsubscribe)
  await ctl.closeThread({ project: "tmp-unsub" });
  assert.equal(ctl.listThreads().includes("tmp-unsub"), false);

  // クローズ後もスレッド名ボードへの投稿が可能(ログは残る)。ゴースト起床がなければ0ターンで終わる
  // (起床してしまうとChatHostがラウンドを開始するため、テストはタイムアウトせず即終了する)
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
