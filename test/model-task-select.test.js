// イシュー#12: リーダーによるタスク別モデル選択。
// - create_task の model はリーダー(threadOpener持ち)だけ指定可。非リーダーは拒否
// - 指定ありタスクのメタ(model: <ref>)が readMeta/list で読める
// - spawn(runAgent)は請求中タスクのmodelをmodelFactoryへ渡す(未指定は既定のまま)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard, readMeta } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ensureGitRepo } from "../src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }
function mktmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

function boardAndTasks(ws) {
  const bus = new Bus();
  return { bus, board: new Board(bus), tasks: new TaskBlackboard(ws, bus) };
}

test("#12: 非リーダー(threadOpener無し)のcreate_task model指定は拒否される", async () => {
  const ws = mktmp("hive-mselect-");
  const { bus, board, tasks } = boardAndTasks(ws);
  const worker = createTools({ agent: { id: "w1", role: "impl", depth: 1 }, workspace: ws, board, tasks, bus });
  const r = await worker.execute("create_task", { task_id: "t-worker-model", body: "x", model: "provider/cheap-model" });
  assert.equal(r.ok, false);
  assert.match(r.text, /model指定はリーダー専用/);
  // タスクは作られていない
  assert.ok(!existsSync(join(ws, "tasks", "open", "t-worker-model.md")));
  rmTree(ws);
});

test("#12: リーダーはmodel指定でタスクを作れ、メタに保存・readMeta/listで読める", async () => {
  const ws = mktmp("hive-mselect-");
  const { bus, board, tasks } = boardAndTasks(ws);
  const lead = createTools({
    agent: { id: "lead", role: "lead", depth: 0 },
    workspace: ws, board, tasks, bus,
    threadOpener: () => ({ ok: true }), // スレッド開設権=リーダー判定
  });
  const r = await lead.execute("create_task", { task_id: "t-lead-model", body: "重い画像処理", model: "provider/vision-model" });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /model: provider\/vision-model/);
  const f = join(ws, "tasks", "open", "t-lead-model.md");
  assert.ok(existsSync(f));
  const meta = readMeta(f);
  assert.equal(meta.model, "provider/vision-model");
  // list()のUI向けサマリにも載る
  const listed = tasks.list().open.find((t) => t.id === "t-lead-model");
  assert.equal(listed.model, "provider/vision-model");
  // model無しはnull(既定運用)
  await lead.execute("create_task", { task_id: "t-lead-plain", body: "普通の作業" });
  assert.equal(readMeta(join(ws, "tasks", "open", "t-lead-plain.md")).model, null);
  rmTree(ws);
});

test("#12: spawn経由でタスクmodelがmodelFactoryへ渡る(未指定タスクは既定のまま)", async () => {
  const ws = mktmp("hive-mselect-");
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const { bus, board, tasks } = boardAndTasks(ws);
  const received = [];
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    modelFactory: (agent) => {
      received.push(agent.model ?? null);
      return {
        maxTokens: 100,
        async chat() {
          return { content: "ok", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, costUsd: 0 } };
        },
      };
    },
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  // (a) リーダーがmodel指定でスポーン → 指定refがfactoryへ渡る
  const ra = await manager.spawn({ parent: main, brief: "指定モデルでの作業", role: "impl", model: "provider/fast-model" });
  assert.ok(ra.id, ra.error ?? "spawn ok");
  assert.ok(await waitUntil(() => received.length >= 1));
  assert.equal(received[0], "provider/fast-model", "指定refがfactoryへ渡る");
  // ブリーフタスクのメタにもmodelが載る
  const metaA = readMeta(join(tasks.claimed, `${ra.id}--spawn-${ra.id}.md`));
  assert.equal(metaA.model, "provider/fast-model");

  // (b) model未指定のスポーン → null(既定)がfactoryへ渡る
  const rb = await manager.spawn({ parent: main, brief: "通常の作業", role: "impl" });
  assert.ok(rb.id, rb.error ?? "spawn ok");
  assert.ok(await waitUntil(() => received.length >= 2));
  assert.equal(received[1] ?? null, null, "未指定は既定(null)のまま");

  // (c) 子(depth>0)からのmodel指定スポーンは拒否
  const sub = { id: ra.id, displayName: ra.displayName, depth: 1 };
  const rc = await manager.spawn({ parent: sub, brief: "子からの指定", role: "impl", model: "provider/x" });
  assert.ok(rc.error);
  assert.match(rc.error, /model指定はリーダーのみ/);

  rmTree(ws);
  rmTree(root);
});

function waitUntil(fn, ms = 8000) {
  return (async () => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return fn();
  })();
}
