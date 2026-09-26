// ボード履歴の頁送りAPIの検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-boardtail-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

async function fetchJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

test("board API: /api/stateのboardは末尾200件に絞られ、/api/board?before=でそれ以前を返す", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  // 250件投稿
  for (let i = 1; i <= 250; i++) board.post("tester", `投稿${i}`);
  const tasks = new TaskBlackboard(ws, bus);
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const st = await fetchJson(`${base}/api/state`);
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.body.live.board));
  assert.equal(st.body.live.board.length, 200, "/api/stateのboardは末尾200件");
  assert.equal(st.body.live.board[0].text, "投稿51");
  assert.equal(st.body.live.board.at(-1).text, "投稿250");
  assert.equal(st.body.live.boardTotal, 250, "総件数も返す");

  // before=最古の表示中ID → それより前の200件
  const oldest = st.body.live.board[0].id;
  const pg = await fetchJson(`${base}/api/board?before=${oldest}`);
  assert.equal(pg.status, 200);
  assert.ok(Array.isArray(pg.body.posts));
  assert.equal(pg.body.posts.length, 50);
  assert.equal(pg.body.posts.at(-1).text, "投稿50");
  assert.equal(pg.body.posts[0].text, "投稿1");
  // 同型(既存board要素と同じキー)
  for (const k of ["id", "from", "text", "ts"]) assert.ok(k in pg.body.posts[0], `key ${k}`);

  // before未指定は末尾200件
  const pg2 = await fetchJson(`${base}/api/board`);
  assert.equal(pg2.body.posts.length, 200);

  ui.close();
  rmTree(ws);
});
