// v6.9: Skills(ノウハウ文書)とセッション管理(保存/復元)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { listSkills, readSkill, buildSkillsIndex } from "../src/engine/skills.js";
import { listSessions, saveSession, loadSession } from "../src/engine/sessions.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-ss-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

test("Skills: 索引・読み出し・use_skillツールが通る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
  // スキル無し
  assert.equal(listSkills(ws).length, 0);
  const none = await tools.execute("use_skill", { name: "todo" });
  assert.equal(none.ok, false);
  // 作成
  mkdirSync(join(ws, "skills"), { recursive: true });
  writeFileSync(join(ws, "skills", "todo-recipe.md"), "# todo-recipe\ntodoアプリの実装手順をまとめたもの。まずテストから書く。");
  const l = listSkills(ws);
  assert.equal(l.length, 1);
  assert.equal(l[0].name, "todo-recipe");
  assert.match(l[0].summary, /実装手順/);
  const idx = buildSkillsIndex(ws);
  assert.match(idx, /available-skills/);
  assert.match(idx, /todo-recipe/);
  const r = await tools.execute("use_skill", { name: "todo-recipe" });
  assert.equal(r.ok, true);
  assert.match(r.text, /テストから書く/);
  // 不正な名前は拒否(パス脱出防止)
  assert.equal(await tools.execute("use_skill", { name: "../secrets" }).then((x) => x.ok), false);
  rmTree(ws);
});

test("Sessions: 保存→一覧→復元が通る。不正な名前は拒否", async () => {
  const ws = mktmp();
  mkdirSync(join(ws, "state"), { recursive: true });
  writeFileSync(join(ws, "state", "board__main__.jsonl"), '{"id":1}\n');
  writeFileSync(join(ws, "state", "mem-lead.json"), '{"messages":[1]}');
  assert.deepEqual(listSessions(ws), []);
  const r = await saveSession(ws, "point-A");
  assert.equal(r.ok, true);
  assert.deepEqual(listSessions(ws), ["point-A"]);
  assert.equal(existsSync(join(ws, "state", "sessions", "point-A", "board__main__.jsonl")), true);
  // 現stateを壊してから復元
  writeFileSync(join(ws, "state", "board__main__.jsonl"), "壊れた");
  assert.equal(loadSession(ws, "point-A").ok, true);
  assert.match(readFileSync(join(ws, "state", "board__main__.jsonl"), "utf8"), /"id":1/);
  // 不正名
  assert.equal(saveSession(ws, "../evil").ok, false);
  assert.equal(loadSession(ws, "../evil").ok, false);
  rmTree(ws);
});
