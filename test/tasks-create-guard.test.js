// fix-task-created-event-not-fired の副要件防御のテスト:
// id無し/不正形式のtasks.create()が拒否され、undefined.md残骸とtaskId:undefinedイベントを生まないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function mkTasks() {
  const ws = mkdtempSync(join(tmpdir(), "hive-tguard-"));
  const bus = new Bus();
  const events = [];
  bus.on("task.created", (p) => events.push(p));
  const tasks = new TaskBlackboard(ws, bus);
  return { ws, tasks, events, cleanup: () => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* Windowsロックは無視 */ } } };
}

test("tasks.create: id無し・不正形式は拒否され、undefined.mdとtaskId:undefinedイベントを生まない", () => {
  const { ws, tasks, events, cleanup } = mkTasks();
  try {
    assert.equal(tasks.create({ body: "id無し" }), false, "id無しは拒否");
    assert.equal(tasks.create({ id: "Bad_ID", body: "x" }), false, "大文字/記号入りは拒否");
    assert.equal(tasks.create({ id: "-dash-start", body: "x" }), false, "ハイフン開始は拒否");
    assert.equal(tasks.create({ id: "ok-id-1", body: "x" }), true, "正常idは通る");
    const files = readdirSync(join(ws, "tasks", "open"));
    assert.ok(!files.includes("undefined.md"), "id無し起票の残骸ファイルが無い");
    assert.deepEqual(files, ["ok-id-1.md"], "open配下は正常idのみ");
    assert.ok(events.every((e) => e.taskId), "発火したtask.createdにtaskId:undefinedが無い");
  } finally {
    cleanup();
  }
});

test("tasks.create: 前後空白のidはtrimして登録される(create_taskツール経路と同じ正規化)", () => {
  const { tasks, cleanup } = mkTasks();
  try {
    assert.equal(tasks.create({ id: "  spaced-id  ", body: "x" }), true, "trimして通る");
    assert.equal(tasks.existsOpenOrClaimed("spaced-id"), true, "trim後のidで存在する");
    assert.equal(tasks.create({ id: "spaced-id", body: "x" }), false, "同一idの二重起票は拒否");
  } finally {
    cleanup();
  }
});

test("tasks.assign/finish: 引数欠けはfalseで防御(壊れたファイル名を作らない)", () => {
  const { ws, tasks, cleanup } = mkTasks();
  try {
    assert.equal(tasks.assign({ agentId: "", taskId: "t1", body: "x" }), false, "agentId空は拒否");
    assert.equal(tasks.assign({ agentId: "a1", taskId: "", body: "x" }), false, "taskId空は拒否");
    assert.equal(tasks.assign({ agentId: "a1", taskId: "t1", body: "x" }), true, "正常は通る");
    assert.equal(tasks.finish({ id: "" }, "t1"), false, "agent無しのfinishは拒否");
    assert.equal(tasks.finish({ id: "a1" }, ""), false, "taskId空のfinishは拒否");
    assert.equal(tasks.finish({ id: "a1" }, "t1"), true, "正常finishは通る");
    assert.ok(readdirSync(join(ws, "tasks", "done")).length === 1, "doneへ1件移っている");
  } finally {
    cleanup();
  }
});
