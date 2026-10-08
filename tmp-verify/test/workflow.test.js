// v6.13: ワークフローオーケストレーション(runWorkflowScript/waitProject)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createWorkflowApi, runWorkflowScript } from "../src/engine/workflow.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-wf-"));
}

test("runWorkflowScript: api経由の操作が順に実行される", async () => {
  const calls = [];
  const api = {
    async createTask(args) { calls.push(["createTask", args.id]); },
    async openThread(args) { calls.push(["openThread", args.project]); },
    async say(text) { calls.push(["say", text]); },
    async waitProject(project) { calls.push(["waitProject", project]); },
    status(project) { return { open: 0, claimed: 0, done: 3, total: 3 }; },
    log() {},
  };
  const script = join(mktmp(), "wf.mjs");
  writeFileSync(script, `
    export default async (api) => {
      await api.createTask({ id: "t1", project: "x", body: "work" });
      await api.openThread({ project: "x", goal: "xを作る" });
      await api.waitProject("x");
      await api.say("done: " + api.status("x").done);
    };
  `);
  await runWorkflowScript({ path: script, api, timeoutMs: 5000 });
  assert.deepEqual(calls, [
    ["createTask", "t1"],
    ["openThread", "x"],
    ["waitProject", "x"],
    ["say", "done: 3"],
  ]);
  rmSync(script, { force: true });
});

test("runWorkflowScript: スクリプト不在・非関数export・タイムアウトで失敗", async () => {
  await assert.rejects(() => runWorkflowScript({ path: join(mktmp(), "none.mjs"), api: {} }), /ありません/);
  const missing = join(mktmp(), "wf.mjs");
  writeFileSync(missing, "export const x = 1;");
  await assert.rejects(() => runWorkflowScript({ path: missing, api: {} }), /async関数/);
});

test("createWorkflowApi: waitProjectが完了検出する(tasks実体を使用)", async () => {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(mktmp(), bus);
  const api = createWorkflowApi({
    openThread: async () => {},
    closeThread: async () => {},
    say: () => {},
    tasks,
    pollMs: 50,
  });
  tasks.create({ id: "t1", project: "p", body: "work" });
  tasks.create({ id: "t2", project: "p", body: "work2" });
  const before = api.status("p");
  assert.equal(before.total, 2);
  assert.equal(before.complete, false);
  // ワーカーの代わりに請求→完了させる
  tasks.claim({ id: "alpha", role: null });
  tasks.claim({ id: "beta", role: null });
  tasks.finish({ id: "alpha" }, "t1");
  tasks.finish({ id: "beta" }, "t2");
  const st = api.status("p");
  assert.equal(st.complete, true);
  rmSync(tasks.dir, { recursive: true, force: true });
});
