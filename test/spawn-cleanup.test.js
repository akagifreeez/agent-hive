// r3: expendableワーカー退場時に自分が起票した未完了のspawn-*管理タスクを掃除する
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ensureGitRepo } from "../src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeEnv() {
  const ws = mkdtempSync(join(tmpdir(), "hive-cleanup-"));
  const root = `${ws}-wt`;
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { ws, root, bus, board, tasks };
}

async function waitUntil(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test("cleanup: idle退場したexpendableワーカーの未完了spawn-*管理タスクはautoResolveで掃除される", async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  // ワーカーはclaimミス1回でidle退場する(expendable)。その間にspawn-*タスクを起票する
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: (agent) => ({
      maxTokens: 4000,
      async chat({ messages }) {
        const last = messages[messages.length - 1].content ?? "";
        if (String(last).includes("create_task") || String(last).includes("ボードへ投入") || String(last).includes("既に存在")) {
        if (String(last).includes("ボードへ投入しました") || String(last).includes("create_task") || String(last).includes("既に存在")) {
          // create_taskのツール結果を受け取った後は何もせず終わる(→請求ミス→idle退場)
          return { content: "起票しました", toolCalls: [], raw: { role: "assistant", content: "起票しました", tool_calls: [] }, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 } };
        }
        const id = `spawn-${agent.id}-followup`;
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "create_task", arguments: { task_id: id, body: "後続の仕事", project: "t" } }],
          raw: { role: "assistant", content: null, tool_calls: [] },
          usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
        };
      },
    }),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "追加仕事の起票だけして終わる", role: "impl", expendable: true });
  // idle退場(請求ミス1回)を待つ
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status === "done"));
  // 起票したspawn-*タスクが掃除されている(open/claimedに残らない)
  assert.ok(tasks.snapshot().done.some((f) => f.includes(`spawn-${r.id}-followup`)), "doneへ自動解決されている");
  assert.ok(!tasks.snapshot().open.some((f) => f.includes(`spawn-${r.id}`)), "openにspawn-*が残らない");
  assert.ok(!tasks.snapshot().claimed.some((f) => f.includes(`spawn-${r.id}`)), "claimedにspawn-*が残らない");
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

test("cleanup: idle退場してもspawn-*以外のタスクや他者のspawn-*は掃除しない", async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  // 退場前に他者のタスクを用意
  tasks.create({ id: "spawn-other-1", body: "他者の仕事" });
  tasks.create({ id: "user-task-1", body: "ユーザー起票の仕事" });
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: () => ({
      maxTokens: 4000,
      async chat() {
        return { content: "何もしない", toolCalls: [], raw: { role: "assistant", content: "何もしない", tool_calls: [] }, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 } };
      },
    }),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "何もしないで終わる", role: "impl", expendable: true });
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status === "done"));
  const snap = tasks.snapshot();
  assert.ok(snap.open.some((f) => f === "spawn-other-1.md"), "他者のspawn-*は残る");
  assert.ok(snap.open.some((f) => f === "user-task-1.md"), "ユーザー起票タスクは残る");
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }
