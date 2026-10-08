// イシュー#29: 閉じたスレッドのChatHostがbus購読で起こされ続ける再循環の修正。
// dispose()で(1)bus購読が全解除される (2)disposed後はwake/sayが握り潰される
// ことをユニットテストで固定する。runner.jsのcloseThread経由の退行は
// test/brushup.test.js(closeThread呼び出し済み)が担保する。
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
  return mkdtempSync(join(tmpdir(), "hive-chat-dispose-"));
}

async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

function mkHost({ project = "dispose-t" } = {}) {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, project);
  const tasks = new TaskBlackboard(ws, bus);
  const calls = [];
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const model = {
    maxTokens: 100,
    async chat() {
      calls.push(1);
      return { content: "応答", toolCalls: [], raw: { content: "応答" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: null,
    project,
    autoContinueRounds: 3,
    maxTurnsPerRound: 8,
    staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: (a) => createTools({ agent: a, workspace: ws, mainWorkspace: null, board, tasks, bus }),
    board, tasks, bus,
  });
  return { host, board, tasks, bus, calls, agent, ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

test("dispose: bus購読が全解除され、task.created/releasedで起こされない", async () => {
  const { host, tasks, bus, calls, cleanup } = mkHost();
  try {
    tasks.create({ id: "seed", body: "シード", project: "dispose-t" });
    host.say("開始してください");
    assert.ok(await waitUntil(() => calls.length >= 1), "ラウンドが走る");
    const listenersBefore = (type) => (bus.listeners.get(type) ?? []).length;
    const before = { board: listenersBefore("board"), created: listenersBefore("task.created"), finished: listenersBefore("task.finished"), merged: listenersBefore("agent.merged"), released: listenersBefore("task.released") };
    assert.ok(before.created >= 1 && before.finished >= 1, "dispose前に購読がある");

    host.dispose();

    const after = { board: listenersBefore("board"), created: listenersBefore("task.created"), finished: listenersBefore("task.finished"), merged: listenersBefore("agent.merged"), released: listenersBefore("task.released") };
    assert.equal(after.board, before.board - 1, "board購読が解除される");
    assert.equal(after.created, before.created - 2, "task.created購読が解除される(起床+着地の2本)");
    assert.equal(after.finished, before.finished - 1, "task.finished購読が解除される");
    assert.equal(after.merged, before.merged - 1, "agent.merged購読が解除される");
    assert.equal(after.released, before.released - 1, "task.released購読が解除される");

    // 解除後でもイベントを流してみる(リスナが無いので何も起きない=例外も出ない)
    bus.emit("task.created", { taskId: "after-close", project: "dispose-t" });
    bus.emit("task.released", { taskId: "seed" });
    assert.equal(calls.length, 1, "閉鎖後にイベントが流れても新しいラウンドは走らない");
  } finally {
    cleanup();
  }
});

test("dispose: disposed後はwake/sayが握り潰される(二重防御)", async () => {
  const { host, agent, calls, cleanup } = mkHost();
  try {
    host.dispose();
    const r = host.say("閉じたあとの入力");
    assert.ok(r && r.error, "閉鎖済みスレッドへのsayはエラーを返す");
    host.wake(agent, "[システム] 新しいタスク x が投入されました。claim_next_task で確認してください。");
    await new Promise((r2) => setTimeout(r2, 120));
    assert.equal(calls.length, 0, "disposed後のwakeはラウンドを開始しない");
    const st = host.roundState.get(agent.id);
    assert.ok(!st || (!st.running && (st.pending ?? []).length === 0), "起床がpendingにも積まれない");
  } finally {
    cleanup();
  }
});

test("dispose: 二重呼び出しでも例外が出ない", () => {
  const { host, cleanup } = mkHost();
  try {
    host.dispose();
    assert.doesNotThrow(() => host.dispose());
  } finally {
    cleanup();
  }
});
