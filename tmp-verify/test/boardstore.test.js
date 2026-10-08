// ボード履歴ストア(肥大化対策): 全文を読まずに総数・頁送り・追記反映が正しいこと
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { BoardStore } from "../src/engine/boardstore.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-bstore-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("BoardStore: 全文を読まずに総数と頁送りが合う", () => {
  const ws = mktmp();
  mkdirSync(join(ws, "state"), { recursive: true });
  const path = join(ws, "state", "board__main__.jsonl");
  const board = new Board(null, "__main__", path);
  for (let i = 1; i <= 500; i++) board.post("alpha", `投稿${i} ${"あ".repeat(50)}`);

  const store = new BoardStore(ws);
  assert.equal(store.total(), 500);

  const last = store.pageThread("__main__", null, 200);
  assert.equal(last.posts.length, 200);
  assert.equal(last.posts[0].id, 301);
  assert.equal(last.posts.at(-1).id, 500);
  assert.equal(last.total, 500);

  const mid = store.pageThread("__main__", 101, 100);
  assert.equal(mid.posts.length, 100);
  assert.equal(mid.posts[0].id, 1);
  assert.equal(mid.posts.at(-1).id, 100);

  rmTree(ws);
});

test("BoardStore: 追記は差分スキャンで反映され、壊れた行・未完成行は無視する", () => {
  const ws = mktmp();
  mkdirSync(join(ws, "state"), { recursive: true });
  const path = join(ws, "state", "board-engine.jsonl");
  const board = new Board(null, "engine", path);
  for (let i = 1; i <= 50; i++) board.post("worker", `e${i}`);

  const store = new BoardStore(ws);
  assert.equal(store.total(), 50);

  // 再起動を模して新しいBoardで追記(replayは末尾だけ読むのでseqは続きから)
  const board2 = new Board(null, "engine", path);
  board2.post("worker", "e51");
  board2.post("worker", "e52");
  assert.equal(store.total(), 52, "追記が索引に反映される");

  // 中途半端な行(改行なし)は投稿として数えず、頁送りも壊さない
  appendFileSync(path, '{"id":53,"from":"worker","tex');
  const r = store.pageThread("engine", null, 10);
  assert.equal(r.posts.at(-1).id, 52);
  assert.equal(r.total, 52);

  appendFileSync(path, "\nnot-json-garbage\n");
  const r2 = store.pageThread("engine", 51, 5);
  assert.equal(r2.posts.length, 5, "51より前のうち末尾5件(46〜50)");
  assert.equal(r2.posts.at(-1).id, 50);
  assert.equal(store.total(), 52);

  rmTree(ws);
});

test("Board.replay: 末尾だけ復元しても続き番号は正しく、RAMは上限で刈られる", () => {
  const ws = mktmp();
  mkdirSync(join(ws, "state"), { recursive: true });
  const path = join(ws, "state", "board-ui.jsonl");
  const board = new Board(null, "ui", path);
  for (let i = 1; i <= 1200; i++) board.post("ui-alpha", `u${i}`);
  assert.equal(board.posts.length, 1000, "RAMは上限1000に刈られる");
  assert.equal(board.lastId(), 1200);

  const board2 = new Board(null, "ui", path); // 再起動
  assert.equal(board2.lastId(), 1200, "末尾だけの復元でも続き番号が正しい");
  board2.post("ui-alpha", "新着");
  assert.equal(board2.lastId(), 1201);
  assert.ok(board2.posts.every((p, i) => i === 0 || p.id > board2.posts[i - 1].id), "投稿は昇順を保つ");

  rmTree(ws);
});

test("API: /api/boardのthread指定はディスクから頁送り、stateのboardTotalは真の総数", async () => {
  const ws = mktmp();
  mkdirSync(join(ws, "state"), { recursive: true });
  const main = new Board(null, "__main__", join(ws, "state", "board__main__.jsonl"));
  for (let i = 1; i <= 450; i++) main.post("lead", `m${i}`);

  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const st = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st.live.boardTotal, 450);
  assert.ok(st.live.board.length <= 200);

  const r = await (await fetch(`${base}/api/board?before=101&thread=__main__`)).json();
  assert.equal(r.posts.length, 100);
  assert.equal(r.posts[0].id, 1);
  assert.equal(r.posts.at(-1).id, 100);
  assert.equal(r.total, 450);

  ui.close();
  rmTree(ws);
});
