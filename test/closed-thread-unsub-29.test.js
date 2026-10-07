// イシュー#29: closeThread後にboard/taskイベントが飛んでも閉じたChatHostが動かないこと。
// runner.jsのcloseThreadがhost.unsubscribe()を呼び、ChatHostのboard/task.created/
// task.released購読が解除される(閉じたスレッドのメンバーが再起床しない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

function mkAgent() {
  return { id: "delta", displayName: "デルタ", role: "impl", personaText: "# D" };
}

// 購読解除の契約そのもの(ChatHost.unsubscribe)を検証する。
function mkHost(project = "closed-thread-29") {
  const ws = mkdtempSync(join(tmpdir(), "hive-unsub-"));
  const bus = new Bus();
  const board = new Board(bus, project);
  const tasks = new TaskBlackboard(ws, bus);
  const host = new ChatHost({
    mains: [mkAgent()],
    mainWorkspace: null,
    project,
    staggerMs: 0,
    modelFactory: () => { throw new Error("閉じたHostのモデルは呼ばれないはず"); },
    toolsFactory: () => { throw new Error("閉じたHostのツールは作られないはず"); },
    board, tasks, bus,
  });
  return { host, bus, board, tasks, ws, cleanup: () => rmTree(ws) };
}

test("イシュー#29: unsubscribe後のtask.created/task.released/boardで閉じたHostのメンバーが起床しない", async () => {
  const { host, bus, board, tasks, cleanup } = mkHost();
  try {
    // 解除前: 同projectのtask.createdで起床ラウンドが始まる(モデルはthrowするので
    // roundStateのrunningとエラー記録で観測できる)
    const st0 = () => host.roundState.get("delta");
    bus.emit("task.created", { taskId: "t-1", project: "closed-thread-29" });
    assert.ok(st0()?.running === true, "解除前はtask.createdで起床する");
    await new Promise((r) => setTimeout(r, 20)); // ラウンド(モデルthrow)の完了を待つ
    assert.notEqual(st0()?.running, true);

    // closeThread相当: 購読解除
    host.unsubscribe();

    // 解除後: どの経路でも再起床しない
    bus.emit("task.created", { taskId: "t-2", project: "closed-thread-29" });
    bus.emit("task.created", { taskId: "fix-29", project: "別スレッド" }); // fix-*は共通仕事扱いの経路
    bus.emit("task.released", { taskId: "t-1" });
    board.post("gamma", "@デルタ 閉じたスレッドから呼びかけ"); // @表示名のboard経路
    bus.emit("agent.merged", { agent: "delta" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(st0()?.running ?? false, false, "解除後はtask.created/release/boardで起床しない");
    assert.deepEqual(st0()?.pending ?? [], [], "pendingにも積まれない(握り潰しではなく購読が外れている)");
  } finally {
    cleanup();
  }
});

test("イシュー#29: unsubscribeは二重呼び出しでも安全(閉じたHostで再度解除されても壊れない)", () => {
  const { host, cleanup } = mkHost();
  try {
    host.unsubscribe();
    host.unsubscribe(); // 二重解除で例外を出さない
    assert.ok(true);
  } finally {
    cleanup();
  }
});
