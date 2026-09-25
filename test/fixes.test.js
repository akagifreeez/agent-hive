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
