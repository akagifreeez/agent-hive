// スレッドの一時停止/再開(Claude Squad手本): 停止中は起床が潰れてトークンを消さない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-pause-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("ChatHost一時停止: 停止中のsay/タスク投入はワーカーを起こさず、再開で拾い直す", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "pt");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "pt-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  let chats = 0;
  const model = { maxTokens: 100, async chat() { chats++; return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const host = new ChatHost({
    mains: [agent], project: "pt", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });

  // 通常時: sayでワーカーが動く
  host.say("作業を始めて");
  assert.ok(await waitUntil(() => chats >= 1), "最初のラウンドが走る");

  // 停止: sayしてもタスクを投入してもチャット呼び出しが増えない
  host.setPaused(true);
  const frozen = chats;
  host.say("止まっているはずへの指示");
  tasks.create({ id: "p-task-1", project: "pt", body: "停止中のタスク" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chats, frozen, "停止中はワーカーが起こされない");

  // 再開: 保留になっていた仕事を拾い直すラウンドが走る
  host.setPaused(false);
  assert.ok(await waitUntil(() => chats > frozen), "再開でラウンドが走る");
  assert.equal(host.paused, false);

  rmTree(ws);
});

test("API: /api/pauseはonThreadPauseへ{project, paused}を渡す。チャットモード以外は400", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const got = [];
  const ui = await startUi({
    config, modelFactory: () => ({}), bus, autoStart: false,
    onThreadPause: (req) => { got.push(req); return { ok: true, name: req.project, paused: req.paused }; },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const r = await fetch(`${base}/api/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "demo", paused: true }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(got, [{ project: "demo", paused: true }]);

  // コールバック無し(シナリオモード等)では使えない
  const config2 = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui2 = await startUi({ config: config2, modelFactory: () => ({}), bus, autoStart: false });
  const r2 = await fetch(`http://127.0.0.1:${config2.ui.port}/api/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "demo", paused: true }) });
  assert.equal(r2.status, 400);
  ui.close();
  ui2.close();
  rmTree(ws);
});
