<<<<<<< HEAD
// イシュー#12: リーダーによるタスク別モデル選択の検証。
// (a) 非リーダー(depth>0)のmodel指定は拒否される
// (b) リーダー(depth===0)のmodel指定はタスクメタに保存され readMeta/list で読める
// (c) spawn経由でmodelFactoryに指定refが渡る(未指定なら既定のまま)
=======
// イシュー#12: リーダーによるタスク別モデル選択。
// - create_task の model はリーダー(threadOpener持ち)だけ指定可。非リーダーは拒否
// - 指定ありタスクのメタ(model: <ref>)が readMeta/list で読める
// - spawn(runAgent)は請求中タスクのmodelをmodelFactoryへ渡す(未指定は既定のまま)
>>>>>>> main
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

<<<<<<< HEAD
function mktmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ }
}

function makeTools(ws, agent) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { tools: createTools({ agent, workspace: ws, board, tasks, bus }), tasks };
}

test("非リーダー(depth>0)のcreate_task model指定は拒否される", async () => {
  const ws = mktmp("hive-msel-");
  const worker = { id: "w1", displayName: "作業員", role: "impl", depth: 1, personaText: "# W" };
  const { tools } = makeTools(ws, worker);
  const r = await tools.execute("create_task", { task_id: "m1", body: "x", model: "prov/alt-model" });
  assert.equal(r.ok, false, "非リーダーのmodel指定は拒否");
  assert.match(r.text, /リーダーだけ/);
  assert.equal(existsSync(join(ws, "tasks", "open", "m1.md")), false, "タスクは起票されない");
  rmTree(ws);
});

test("リーダー(depth===0)のmodel指定はメタに保存され readMeta/list で読める", async () => {
  const ws = mktmp("hive-msel-");
  const lead = { id: "lead", displayName: "リーダー", role: "lead", depth: 0, personaText: "# L" };
  const { tools, tasks } = makeTools(ws, lead);
  const r = await tools.execute("create_task", { task_id: "m2", body: "x", model: "prov/alt-model" });
  assert.equal(r.ok, true);
  assert.match(r.text, /model: prov\/alt-model/);
  const meta = readMeta(join(ws, "tasks", "open", "m2.md"));
  assert.equal(meta.model, "prov/alt-model", "メタ行 model: が読める");
  const listed = tasks.list().open.find((t) => t.id === "m2");
  assert.equal(listed.model, "prov/alt-model", "TaskInfo(list)にも model が載る");
  rmTree(ws);
});

test("model未指定タスクのmeta.modelはnull(既定モデルのまま)", async () => {
  const ws = mktmp("hive-msel-");
  const lead = { id: "lead", displayName: "リーダー", role: "lead", depth: 0, personaText: "# L" };
  const { tools, tasks } = makeTools(ws, lead);
  await tools.execute("create_task", { task_id: "m3", body: "x" });
  const meta = readMeta(join(ws, "tasks", "open", "m3.md"));
  assert.equal(meta.model, null);
  assert.equal(tasks.list().open.find((t) => t.id === "m3").model, null);
  rmTree(ws);
});

test("spawn経由: 指定ありブリーフはmodelFactoryに指定refが渡り、未指定はagent.modelのまま", async () => {
  const ws = mktmp("hive-msel-");
  const root = `${ws}-wt`;
  await ensureGitRepo(ws);
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const received = [];
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
=======
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
>>>>>>> main
    modelFactory: (agent) => {
      received.push(agent.model ?? null);
      return {
        maxTokens: 100,
        async chat() {
<<<<<<< HEAD
          return { content: "完了しました", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: {} };
=======
          return { content: "ok", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, costUsd: 0 } };
>>>>>>> main
        },
      };
    },
  });
<<<<<<< HEAD
  const lead = { id: "main-lead", displayName: "リーダー", depth: 0 };
  // 指定あり: 親がmodel付きでスポーン(depth===0のリーダーだけが指定可能なのはtools層の責務)
  const r1 = await manager.spawn({ parent: lead, brief: "そのまま完了して", role: "impl", model: "prov/alt-model" });
  // 未指定: 従来どおり(既定)
  const r2 = await manager.spawn({ parent: lead, brief: "そのまま完了して", role: "impl" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const st = manager.snapshot();
    if (st[r1.id]?.status !== "working" && st[r2.id]?.status !== "working") break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.deepEqual(received, ["prov/alt-model", null], "指定refがFactoryへ渡り、未指定は既定(null)のまま");
  // ブリーフタスクのメタにもmodelが残る(検証者/引き継ぎが確認できる)
  const metaFile = join(ws, "tasks", "claimed", `${r1.id}--spawn-${r1.id}.md`);
  if (existsSync(metaFile)) {
    assert.equal(readMeta(metaFile).model, "prov/alt-model");
  }
=======
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

>>>>>>> main
  rmTree(ws);
  rmTree(root);
});

<<<<<<< HEAD
test("spawnされた作業員エージェントのブリーフタスクメタからmodelが読め、Factoryに渡る(実runAgent経路)", async () => {
  const ws = mktmp("hive-msel-");
  const root = `${ws}-wt2`;
  await ensureGitRepo(ws);
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const seenModels = new Map(); // agentId => model ref
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: (agent) => {
      seenModels.set(agent.id, agent.model ?? null);
      return {
        maxTokens: 100,
        async chat() {
          return { content: "完了しました", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: {} };
        },
      };
    },
  });
  const lead = { id: "main-lead", displayName: "リーダー", depth: 0 };
  const r = await manager.spawn({ parent: lead, brief: "そのまま完了して", role: "impl", model: "prov/alt-model" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (manager.snapshot()[r.id]?.status !== "working") break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(seenModels.get(r.id), "prov/alt-model", "runAgentがブリーフタスクのメタからmodelを読んでFactoryへ渡す");
  rmTree(ws);
  rmTree(root);
});
=======
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
>>>>>>> main
