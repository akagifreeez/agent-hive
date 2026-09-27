// to_thread: post_to_board の別スレッド宛投稿(design-to-thread.md)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { Board } from "../src/engine/board.js";
import { createTools } from "../src/engine/tools.js";

function mkTools(board, resolveBoard) {
  const agent = { id: "a1", displayName: "エー", thread: "t1" };
  return createTools({
    agent,
    workspace: process.cwd(),
    mainWorkspace: process.cwd(),
    board,
    tasks: { snapshot: () => ({ open: [], claimed: [], done: [] }), list: () => [] },
    bus: new Bus(),
    resolveBoard,
  });
}

test("to_thread指定で別スレッドのボードに投稿が現れる(post.thread===宛先名)", async () => {
  const bus = new Bus();
  const myBoard = new Board(bus, "t1");
  const otherBoard = new Board(bus, "t2");
  const tools = mkTools(myBoard, (name) => (name === "t2" ? otherBoard : name === "t1" ? myBoard : null));
  const r = await tools.execute("post_to_board", { text: "こんにちは", to_thread: "t2" });
  assert.equal(r.ok, true);
  assert.match(r.text, /ボード#\d+\(t2\)/);
  const posts = otherBoard.posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread, "t2");
  assert.equal(posts[0].text, "こんにちは");
  // 自分のボードには載らない
  assert.equal(myBoard.posts.length, 0);
});

test("存在しない宛先でok:false・投稿が増えない", async () => {
  const bus = new Bus();
  const myBoard = new Board(bus, "t1");
  const tools = mkTools(myBoard, () => null);
  const r = await tools.execute("post_to_board", { text: "x", to_thread: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.text, /宛先スレッドが存在しません: nope/);
  assert.equal(myBoard.posts.length, 0);
});

test("省略時は自分のボードへ投稿できる", async () => {
  const bus = new Bus();
  const myBoard = new Board(bus, "t1");
  const tools = mkTools(myBoard, () => null);
  const r = await tools.execute("post_to_board", { text: "いつもどおり" });
  assert.equal(r.ok, true);
  const posts = myBoard.posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread, "t1");
});
