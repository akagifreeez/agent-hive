// イシュー#12: リーダーによるタスク別モデル選択の検証。
// (a) 非リーダー(depth>0)のmodel指定は拒否される
// (b) リーダー(depth===0)のmodel指定はタスクメタに保存され readMeta/list で読める
// (c) spawn経由でmodelFactoryに指定refが渡る(未指定なら既定のまま)
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
    modelFactory: (agent) => {
      received.push(agent.model ?? null);
      return {
        maxTokens: 100,
        async chat() {
          return { content: "完了しました", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: {} };
        },
      };
    },
  });
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
  rmTree(ws);
  rmTree(root);
});

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
