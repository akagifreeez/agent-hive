// spawn-*管理タスクの掃除: expendableワーカー退場後、自分が起票した未完了タスクが
// open/claimedに残らないことの検証(TDD)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ensureGitRepo } from "../src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
      };
    },
  };
}

async function waitUntil(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test("expendableワーカー退場後、自己起票タスクはopen/claimedに残らない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-cleanup-"));
  const root = `${ws}-wt`;
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: () => scriptedModel([
      // 自分が起票した管理タスク(誰も請求しない)
      { toolCalls: [{ name: "create_task", args: { task_id: "worker-self-task", project: "engine", body: "ワーカーが起票した仕事" } }] },
      // 請求ミス→expendableなのでidle退場
      { toolCalls: [{ name: "claim_next_task", args: { project: "engine", wait_sec: 0 } }] },
      { text: "終了します" },
    ]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "掃除テスト", role: "impl", expendable: true });
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status && manager.snapshot()[r.id].status !== "working"));
  const snap = tasks.snapshot();
  // 自己起票タスクは掃除されている(doneへ)。open/claimedに残らない
  assert.ok(!snap.open.includes("worker-self-task.md"), `openに残存: ${snap.open}`);
  assert.ok(!snap.claimed.some((f) => f.endsWith("--worker-self-task.md")), `claimedに残存: ${snap.claimed}`);
  assert.ok(snap.done.some((f) => f.includes("worker-self-task")), "doneへ移動している");
  // 他人が起票したタスクは掃除されない
  tasks.create({ id: "lead-task", body: "リーダーの仕事", project: "engine" });
  assert.ok(tasks.snapshot().open.includes("lead-task.md"));
  // ボードに掃除の告知が出る
  assert.ok(board.posts.some((p) => p.from === "system" && p.text.includes("worker-self-task") && p.text.includes(r.id)));
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

test("tasks.autoResolveCreatedBy: createdByメタで起票者を特定して掃除する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-cleanup2-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  tasks.create({ id: "t1", body: "a", createdBy: "impl-9" });
  tasks.create({ id: "t2", body: "b", createdBy: "other" });
  tasks.assign({ agentId: "impl-9", taskId: "spawn-impl-9", body: "ブリーフ" });
  // impl-9が請求ミス退場: 請求中のspawnブリーフはopenへ戻る(従来どおり)
  tasks.release("impl-9", "[解放] テスト");
  assert.ok(tasks.snapshot().open.includes("spawn-impl-9.md"));
  // 自己起票の掃除: createdBy=impl-9 のもの(t1 と spawn-impl-9 は createdBy ではない→残る…が
  // spawn-*管理タスクは自分が請求していたものなので、退場掃除の対象に含めてよい(タスク指示より)
  const cleaned = tasks.autoResolveCreatedBy("impl-9", "[掃除] 起票者退場");
  assert.deepEqual(cleaned.sort(), ["spawn-impl-9", "t1"]);
  const snap = tasks.snapshot();
  assert.ok(!snap.open.includes("t1.md"));
  assert.ok(!snap.open.includes("spawn-impl-9.md"));
  assert.ok(snap.open.includes("t2.md")); // 他人起票は残る
  assert.ok(snap.done.some((f) => f.includes("t1")));
  rmTree(ws, { recursive: true, force: true });
});