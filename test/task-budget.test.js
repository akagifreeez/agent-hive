// 起票予算(正則化)の検証: 時間窓あたりの起票上限・着地での回復・停滞での逓減。
// tools.js経由ではcreate_taskが予算で拒否され、教師文面に回復手段が出ることまで確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskBudget } from "../src/engine/task-budget.js";
import { createTools } from "../src/engine/tools.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Board, Bus } from "../src/engine/board.js";

const T0 = 1_700_000_000_000;

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

test("起票予算: 時間窓内の上限を消費し、窓の外で回復する", () => {
  const b = createTaskBudget({ max: 3, windowSec: 600 });
  for (let i = 0; i < 3; i++) assert.equal(b.tryConsume(T0).ok, true);
  const r = b.tryConsume(T0 + 1000);
  assert.equal(r.ok, false);
  assert.ok(r.retryInSec > 0 && r.retryInSec <= 600, "窓の残り時間で回復予定が返る: " + r.retryInSec);
  // 窓が切れると再び使える
  assert.equal(b.tryConsume(T0 + 600_001).ok, true);
});

test("起票予算: 停滞で逓減し、着地で全回復する", () => {
  const b = createTaskBudget({ max: 4, windowSec: 600 });
  assert.equal(b.cap, 4);
  b.noteStall();
  assert.equal(b.cap, 2);
  b.noteStall();
  assert.equal(b.cap, 1);
  b.noteLanding();
  assert.equal(b.cap, 4);
});

test("起票予算: max=0で無効(常に許可)", () => {
  const b = createTaskBudget({ max: 0 });
  for (let i = 0; i < 50; i++) assert.equal(b.tryConsume(T0 + i).ok, true);
});

test("create_task: 予算枯渇で拒否され、教師文面に回復手段が出る", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-budget-"));
  try {
    const bus = new Bus();
    const board = new Board(bus);
    const tasks = new TaskBlackboard(ws, bus);
    const budget = createTaskBudget({ max: 1, windowSec: 600 });
    const tools = createTools({ agent: { id: "a", displayName: "A" }, workspace: ws, board, tasks, bus, taskBudget: budget });
    const ok1 = await tools.execute("create_task", { task_id: "t1", body: "1件目" });
    assert.equal(ok1.ok, true, "上限内の1件目は起票できる");
    const ng = await tools.execute("create_task", { task_id: "t2", body: "2件目" });
    assert.equal(ng.ok, false);
    assert.match(ng.text, /起票予算を使い切りました/);
    assert.match(ng.text, /taskCreationBudget/);
    // 予算を渡していないtoolsは影響を受けない(ハーネス内部経路と同じ)
    const tools2 = createTools({ agent: { id: "b", displayName: "B" }, workspace: ws, board, tasks, bus });
    const ok2 = await tools2.execute("create_task", { task_id: "t2", body: "予算外" });
    assert.equal(ok2.ok, true);
  } finally {
    rmTree(ws);
  }
});
