// v6.x: create_task時のタスク重複検知(detectTaskOverlap)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard, detectTaskOverlap } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-overlap-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

function makeTools(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { tools: createTools({ agent: AGENT, workspace: ws, board, tasks, bus }), tasks };
}

test("detectTaskOverlap: 同一パスを含む2タスクで警告対象を返す", () => {
  const a = "src/ui/server.js を修正してください";
  const b = "src/ui/server.js のテストを書く";
  const hits = detectTaskOverlap(b, [{ id: "t1", body: a }]);
  assert.ok(hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, "t1");
  assert.ok(hits[0].files.includes("src/ui/server.js"));
});

test("detectTaskOverlap: 共有ファイルがなければnull", () => {
  const a = "src/ui/server.js を修正してください";
  const b = "docs/guide.md を書き直す";
  assert.equal(detectTaskOverlap(b, [{ id: "t1", body: a }]), null);
});

test("detectTaskOverlap: メタ行やバージョン表記は誤検知しない", () => {
  const a = "acceptance: npm testが通ること\n\nv6.6 の挙動を確認する";
  const b = "v6.6 のリリースノートを書く";
  assert.equal(detectTaskOverlap(b, [{ id: "t1", body: a }]), null);
});

test("create_task: 既存タスクと共有ファイルがあると返値に警告が添う", async () => {
  const ws = mktmp();
  const { tools, tasks } = makeTools(ws);
  tasks.create({ id: "base", body: "src/ui/server.js のリファクタ", project: "p1" });
  const r = await tools.execute("create_task", { task_id: "newone", body: "src/ui/server.js にテストを追加" });
  assert.equal(r.ok, true);
  assert.match(r.text, /警告: 既存タスク base が同じファイル\(src\/ui\/server\.js\)を扱っています/);
  assert.match(r.text, /重複の可能性/);
  assert.match(r.text, /tasks cancel base/);
  rmTree(ws);
});

test("create_task: 共有ファイルがなければ警告は出ない", async () => {
  const ws = mktmp();
  const { tools, tasks } = makeTools(ws);
  tasks.create({ id: "base", body: "src/ui/server.js のリファクタ", project: "p1" });
  const r = await tools.execute("create_task", { task_id: "newone", body: "docs/guide.md を更新する" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /警告/);
  rmTree(ws);
});

test("create_task: 自分自身との重複で警告を出さない", async () => {
  const ws = mktmp();
  const { tools } = makeTools(ws);
  const r = await tools.execute("create_task", { task_id: "solo", body: "src/ui/server.js を直す" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /警告/);
  rmTree(ws);
});