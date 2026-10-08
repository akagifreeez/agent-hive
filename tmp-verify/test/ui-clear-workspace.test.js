// チャット履歴クリア(/api/clear-board)とワークスペース変更(/api/workspace)の設定API
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-clear-"));
}

test("設定API: /api/clear-board はチャット履歴だけ空にし、タスクは残す", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    // 過去のチャット履歴(2投稿)と完了タスク1件を用意(タスクはworkspace/tasks配下)
    const boardFile = join(ws, "state", "board__main__.jsonl");
    mkdirSync(join(ws, "state"), { recursive: true });
    mkdirSync(join(ws, "tasks", "done"), { recursive: true });
    writeFileSync(boardFile, [
      JSON.stringify({ id: 1, from: "you", text: "こんにちは", at: 1, thread: "__main__" }),
      JSON.stringify({ id: 2, from: "lead", text: "応答", at: 2, thread: "__main__" }),
    ].join("\n") + "\n");
    writeFileSync(join(ws, "tasks", "done", "impl-old-task.md"), "done: true\n本文\n");
    const config = { workspace: ws, ui: { port: 0 }, agents: [], budget: { maxTokensPerRun: 1 }, model: { model: "m" } };
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify(body) });

    const r = await (await post("/api/clear-board", { thread: "__main__" })).json();
    assert.equal(r.ok, true);
    assert.equal(r.thread, "__main__");
    assert.equal(readFileSync(boardFile, "utf8"), "", "履歴ファイルが空になる");

    // stateに載らなくなり、タスクは残る
    const st = await (await fetch(base + "/api/state")).json();
    assert.equal(st.live.board.filter((p) => (p.thread ?? "__main__") === "__main__").length, 0);
    assert.equal(st.taskList.done.length, 1, "完了タスクは残る");
    assert.ok(existsSync(join(ws, "tasks", "done", "impl-old-task.md")));

    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("設定API: /api/workspace は現在値を返し、POSTでhive.local.jsonに保存する", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = { workspace: ws, ui: { port: 0 }, agents: [], budget: { maxTokensPerRun: 1 }, model: { model: "m" } };
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify(body) });

    const g1 = await (await fetch(base + "/api/workspace")).json();
    assert.equal(g1.workspace, ws);
    assert.equal(g1.dataDir, dataDir);

    // 空・非文字列は400
    assert.equal((await post("/api/workspace", { path: "" })).status, 400);

    // 新規フォルダも許容(作ってから保存)
    const target = join(dataDir, "new-workspace");
    const r = await (await post("/api/workspace", { path: target })).json();
    assert.equal(r.ok, true);
    assert.match(r.note, /再起動/);
    assert.ok(existsSync(target), "フォルダを作る");
    const local = JSON.parse(readFileSync(join(dataDir, "hive.local.json"), "utf8"));
    assert.equal(local.workspace, target, "hive.local.jsonに保存");
    // 実行中のconfigは変わらない(再起動で反映)
    assert.equal(config.workspace, ws);
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
