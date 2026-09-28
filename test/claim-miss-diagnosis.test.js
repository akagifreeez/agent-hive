// v6.x: claim_next_task のclaimMiss診断(project無しでもopen一覧を返す)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-claimmiss-"));
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

test("claimMiss: project無しでもopenタスクの一覧(id/role/project)を診断として返す", async () => {
  const ws = mktmp();
  const { tools, tasks } = makeTools(ws);
  // 両方review固定のためimplの自分は請求できずclaimMissになる
  tasks.create({ id: "job-review", body: "レビューして", role: "review", project: "p1" });
  tasks.create({ id: "job-review2", body: "レビューする", role: "review", project: "p2" });
  const r = await tools.execute("claim_next_task", {});
  assert.equal(r.ok, true);
  assert.equal(r.claimMiss, true);
  assert.match(r.text, /未着手タスクが2件あります/);
  assert.match(r.text, /job-review\(role:review\)\/project:p1/);
  assert.match(r.text, /job-review2\(role:review\)\/project:p2/);
  assert.match(r.text, /あなたのロールはimpl/);
  rmTree(ws);
});

test("claimMiss: openが0件なら診断は付かず短文のまま", async () => {
  const ws = mktmp();
  const { tools } = makeTools(ws);
  const r = await tools.execute("claim_next_task", {});
  assert.equal(r.ok, true);
  assert.equal(r.claimMiss, true);
  assert.match(r.text, /請求できるタスクはありません/);
  assert.doesNotMatch(r.text, /診断/);
  rmTree(ws);
});

test("claimMiss: project指定時の従来ヒントは壊れていない", async () => {
  const ws = mktmp();
  const { tools, tasks } = makeTools(ws);
  tasks.create({ id: "job-review", body: "レビューして", role: "review", project: "p1" });
  const r = await tools.execute("claim_next_task", { project: "p1" });
  assert.equal(r.claimMiss, true);
  assert.match(r.text, /project「p1」の未着手タスクが1件あります/);
  assert.match(r.text, /job-review\(role:review\)/);
  rmTree(ws);
});