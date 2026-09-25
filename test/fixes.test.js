// v5.4: 課題対応(claimed解放/予算ラン単位/worktree保持)+gather_context(読み取り時ブリーフ合成)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Board, Bus } from "../src/engine/board.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-fix-"));
}

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };

test("release: 予算停止等で消えた担当者の請求中タスクがnote付きでopenへ戻る", () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const events = [];
  bus.on("task.released", (p) => events.push(p));

  tasks.seed([{ id: "t1", role: null, body: "途中の仕事" }, { id: "t2", role: "impl", body: "もう一つ" }]);
  tasks.claim({ id: "alpha", role: "impl" });
  tasks.claim({ id: "alpha", role: "impl" });
  assert.equal(tasks.snapshot().claimed.length, 2);

  const released = tasks.release("alpha", "担当者終了のため解放");
  assert.deepEqual(released.sort(), ["t1", "t2"]);
  assert.equal(tasks.snapshot().claimed.length, 0);
  assert.equal(tasks.snapshot().open.length, 2);
  const body = readFileSync(join(ws, "tasks/open/t1.md"), "utf8");
  assert.match(body, /担当者終了のため解放/);
  assert.deepEqual(events.map((e) => e.taskId).sort(), ["t1", "t2"]);
  rmSync(ws, { recursive: true, force: true });
});

test("gather_context: board/done/openの生素材を読める", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });

  board.post("beta", "設計レビューは指摘ゼロで完着");
  tasks.seed([{ id: "t1", role: null, body: "upperの実装" }]);
  tasks.claim({ id: "alpha", role: "x" });
  tasks.finish({ id: "alpha" }, "t1");

  const rb = await tools.execute("gather_context", { source: "board" });
  assert.match(rb.text, /設計レビューは指摘ゼロで完着/);
  assert.match(rb.text, /\[beta\]/);

  const rd = await tools.execute("gather_context", { source: "done" });
  assert.match(rd.text, /alpha--t1/);
  assert.match(rd.text, /upperの実装/);

  const ro = await tools.execute("gather_context", { source: "open" });
  assert.match(ro.text, /ありません/);

  tasks.create({ id: "t2", body: "次の仕事" });
  const ro2 = await tools.execute("gather_context", { source: "open" });
  assert.match(ro2.text, /次の仕事/);
  rmSync(ws, { recursive: true, force: true });
});

test("gather_context: limitで取得件数を絞れる(新しい方を優先)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
  board.post("a", "古い投稿1");
  board.post("a", "古い投稿2");
  board.post("a", "新しい投稿3");
  const r = await tools.execute("gather_context", { source: "board", limit: 2 });
  assert.doesNotMatch(r.text, /古い投稿1/);
  assert.match(r.text, /新しい投稿3/);
  rmSync(ws, { recursive: true, force: true });
});

// UI直操作(チャット不要のタスク管理)の土台
test("list: 状態ごとにid/担当/要約/パス付きで一覧を返す", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: "impl", body: "role行の次がサマリーになる\n詳細は2行目" }, { id: "t2", role: null, body: "roleなしの仕事" }]);
  tasks.claim({ id: "alpha", role: "impl" });
  const l = tasks.list();
  assert.equal(l.open.length, 1);
  assert.equal(l.open[0].id, "t2");
  assert.equal(l.open[0].state, "open");
  assert.match(l.open[0].summary, /roleなしの仕事/);
  assert.match(l.open[0].path, /^tasks\/open\/t2\.md$/);
  assert.equal(l.claimed.length, 1);
  assert.equal(l.claimed[0].id, "t1");
  assert.equal(l.claimed[0].agent, "alpha");
  assert.equal(l.claimed[0].role, "impl");
  assert.match(l.claimed[0].summary, /サマリーになる/);
  tasks.finish({ id: "alpha" }, "t1");
  const l2 = tasks.list();
  assert.equal(l2.done[0].id, "t1");
  assert.equal(l2.done[0].agent, "alpha");
  rmSync(ws, { recursive: true, force: true });
});

test("releaseOne: 指定1件だけopenへ戻す。openに同名があれば壊さない", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: null, body: "仕事1" }, { id: "t2", role: null, body: "仕事2" }]);
  tasks.claim({ id: "alpha", role: "x" });
  tasks.claim({ id: "alpha", role: "x" });
  assert.equal(tasks.releaseOne("alpha", "t1", "UIから解放"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), true);
  assert.match(readFileSync(join(ws, "tasks/open/t1.md"), "utf8"), /UIから解放/);
  assert.equal(tasks.snapshot().claimed.length, 1); // t2はstill claimed
  // openに同名が既にある場合は失敗(上書きしない)
  tasks.create({ id: "t2", body: "手動で投入済み" });
  assert.equal(tasks.releaseOne("alpha", "t2", "note"), false);
  assert.equal(readFileSync(join(ws, "tasks/open/t2.md"), "utf8").includes("手動で投入済み"), true);
  rmSync(ws, { recursive: true, force: true });
});

test("cancel/reopen: open→中止→done、再開でopenへ。二重再開は拒否", () => {
  const ws = mktmp();
  const bus = new Bus();
  const events = [];
  bus.on("task.cancelled", (p) => events.push(p));
  const tasks = new TaskBlackboard(ws, bus);
  tasks.seed([{ id: "t1", role: null, body: "やめる仕事" }]);
  assert.equal(tasks.cancel("t1"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), false);
  assert.match(readFileSync(join(ws, "tasks/done/you--t1.md"), "utf8"), /中止/);
  assert.deepEqual(events, [{ taskId: "t1" }]);

  assert.equal(tasks.reopen("t1"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), true);
  assert.match(readFileSync(join(ws, "tasks/open/t1.md"), "utf8"), /再開/);
  // doneからは消えているので再openはもうできない(openに同名もあるし)
  assert.equal(tasks.reopen("t1"), false);
  rmSync(ws, { recursive: true, force: true });
});
