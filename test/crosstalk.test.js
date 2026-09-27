// crosstalk: post_to_board の to_thread で別スレッドのボードへ直接投稿できる
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-xtalk-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function mkAgent(id, name) {
  return { id, displayName: name, role: "impl", personaText: "# A" };
}

test("to_thread=B: Bのボードに記録され、Aのボードには載らない", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const boardA = new Board(bus, "a", join(ws, "state", "board-a.jsonl"));
  const boardB = new Board(bus, "b", join(ws, "state", "board-b.jsonl"));
  const threads = { b: { name: "b", board: boardB } };
  const crossPoster = (threadName, from, text) => {
    const t = threads[String(threadName ?? "").trim()];
    if (!t) return { ok: false, error: `スレッド ${threadName} は開いていません` };
    const post = t.board.post(from, text);
    return { ok: true, id: post.id };
  };
  const tools = createTools({ agent: mkAgent("a", "エー"), workspace: ws, mainWorkspace: ws, board: boardA, tasks, bus, crossPoster });

  const r = await tools.execute("post_to_board", { text: "@ビー 進捗確認", to_thread: "b" });
  assert.equal(r.ok, true);
  assert.ok(boardB.posts.some((p) => p.from === "a" && p.text === "@ビー 進捗確認"));
  assert.ok(!boardA.posts.some((p) => p.text === "@ビー 進捗確認"), "自分のボードには載せない");

  const ng = await tools.execute("post_to_board", { text: "どこ?", to_thread: "nope" });
  assert.equal(ng.ok, false, "不在スレッドはok:false");
  assert.ok(!boardA.posts.some((p) => p.text === "どこ?"), "不在時もフォールバックしない");

  rmTree(ws);
});

test("to_thread省略は従来どおり自分のボードへ", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const boardA = new Board(bus, "a", join(ws, "state", "board-a.jsonl"));
  const tools = createTools({ agent: mkAgent("a", "エー"), workspace: ws, mainWorkspace: ws, board: boardA, tasks, bus, crossPoster: () => ({ ok: false, error: "呼ばれない" }) });
  const r = await tools.execute("post_to_board", { text: "普通の投稿" });
  assert.equal(r.ok, true);
  assert.ok(boardA.posts.some((p) => p.text === "普通の投稿"));
  rmTree(ws);
});
