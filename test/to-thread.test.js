// to_thread: post_to_board で別スレッドのボードへ投稿できること(design-to-thread.md)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mkTools({ board, resolveBoard }) {
  const bus = new Bus();
  const tasks = new TaskBlackboard("/tmp/hive-to-thread", bus);
  const agent = { id: "a-1", displayName: "アルファ", role: "impl", personaText: "# A" };
  return createTools({ agent, workspace: "/tmp/hive-to-thread", board, tasks, bus, resolveBoard });
}

test("to_thread: 宛先スレッドのボードに投稿が現れる(post.thread===宛先名)", async () => {
  const bus = new Bus();
  const mine = new Board(bus, "alpha-thread");
  const other = new Board(bus, "beta-thread");
  const tools = mkTools({ board: mine, resolveBoard: (n) => (n === "beta-thread" ? other : null) });

  const r = await tools.execute("post_to_board", { text: "こんにちはベータ", to_thread: "beta-thread" });
  assert.equal(r.ok, true);
  assert.match(r.text, /beta-thread/);

  assert.equal(other.posts.length, 1);
  assert.equal(other.posts[0].from, "a-1");
  assert.equal(other.posts[0].text, "こんにちはベータ");
  assert.equal(other.posts[0].thread, "beta-thread");
  assert.equal(mine.posts.length, 0, "自分のボードには流れない");
});

test("to_thread: 存在しない宛先はok:falseで投稿が増えない", async () => {
  const bus = new Bus();
  const mine = new Board(bus, "alpha-thread");
  const tools = mkTools({ board: mine, resolveBoard: () => null });

  const r = await tools.execute("post_to_board", { text: "どこへ?", to_thread: "no-such-thread" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no-such-thread/);
  assert.equal(mine.posts.length, 0);
});

test("to_thread省略時は従来どおり自分のボードへ", async () => {
  const bus = new Bus();
  const mine = new Board(bus, "alpha-thread");
  const other = new Board(bus, "beta-thread");
  const tools = mkTools({ board: mine, resolveBoard: (n) => (n === "beta-thread" ? other : null) });

  const r = await tools.execute("post_to_board", { text: "いつもの投稿" });
  assert.equal(r.ok, true);
  assert.equal(mine.posts.length, 1);
  assert.equal(mine.posts[0].thread, "alpha-thread");
  assert.equal(other.posts.length, 0);
  assert.match(r.text, /^ボード#\d+へ投稿しました。$/, "自分のボード宛は従来の文言");
});

test("to_thread: __main__宛はresolveBoard経由でメインボードに届く", async () => {
  const bus = new Bus();
  const mine = new Board(bus, "alpha-thread");
  const main = new Board(bus, "__main__");
  const tools = mkTools({ board: mine, resolveBoard: (n) => (n === "__main__" ? main : null) });

  const r = await tools.execute("post_to_board", { text: "リーダーへ", to_thread: "__main__" });
  assert.equal(r.ok, true);
  assert.equal(main.posts.length, 1);
  assert.equal(main.posts[0].thread, "__main__");
});