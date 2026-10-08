// 解放タスクでの起床: 退場した担当者のタスクがopenへ戻ったら、同じスレッドのメンバーが
// 起こされること(r7で「解放→誰にも起されず凍結」が実際に発生した)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-relwake-"));
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

function mkHost(ws, bus, board, tasks) {
  const agent = { id: "rw-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  let chats = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      chats++;
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "rw", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });
  return { host, calls: () => chats };
}

test("解放されたタスクで同じスレッドのメンバーが起こされる", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "rw");
  const tasks = new TaskBlackboard(ws, bus);
  const { host, calls } = mkHost(ws, bus, board, tasks);

  // 担当者がタスクを請求したまま退場する状況を作る
  tasks.create({ id: "rw-task-1", project: "rw", role: "impl", body: "残される仕事" });
  const taker = { id: "impl-9", role: "impl" };
  assert.ok(tasks.claim(taker, { project: "rw" }), "前準備: 請求に成功している");
  const before = calls();
  const released = tasks.release(taker.id);
  assert.deepEqual(released, ["rw-task-1"]);

  // 解放イベントでメンバーが起こされてラウンドが走る
  assert.ok(await waitUntil(() => calls() > before), "解放で起床する");
  rmTree(ws);
});

test("他スレッドの解放では起こされない", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "rw");
  const tasks = new TaskBlackboard(ws, bus);
  const { host, calls } = mkHost(ws, bus, board, tasks);

  tasks.create({ id: "other-task-1", project: "other", role: "impl", body: "別の取り組みの仕事" });
  const taker = { id: "impl-8", role: "impl" };
  tasks.claim(taker, { project: "other" });
  const before = calls();
  tasks.release(taker.id);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls(), before, "project不一致の解放では起こされない");
  rmTree(ws);
});
