import { test } from "node:test";
import assert from "node:assert/strict";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function scriptedModel(steps, calls) {
  let i = 0;
  return {
    maxTokens: 100,
    async chat() {
      calls.push(Date.now());
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === "string"
        ? { content: step, toolCalls: [], raw: { content: step }, usage: { promptTokens: 1, completionTokens: 1 } }
        : { content: "", toolCalls: step.toolCalls ?? [], raw: { content: "" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

// スレッド内タスクに触れるtoolsFactoryを作る(projectスコープを合わせる)
function mkTools({ agent, board, tasks, bus, project }) {
  return createTools({ agent, workspace: ".", mainWorkspace: null, board, tasks, bus, project });
}

function mkHost({ steps, project, autoContinueRounds = 3, maxTurnsPerRound = 2 }) {
  const bus = new Bus();
  const board = new Board(bus, "pgate");
  const tasks = new TaskBlackboard(".", bus);
  const calls = [];
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: null,
    project,
    autoContinueRounds,
    maxTurnsPerRound,
    staggerMs: 0,
    modelFactory: () => scriptedModel(steps, calls),
    toolsFactory: (a) => mkTools({ agent: a, board, tasks, bus, project }),
    board, tasks, bus,
  });
  return { host, board, tasks, bus, calls, agent };
}

test("着地ありラウンドは自動継続する(着地あり→継続)", async () => {
  const project = "pgate-cont";
  const { host, tasks } = mkHost({
    project,
    maxTurnsPerRound: 1,
    steps: [{ toolCalls: [{ name: "create_task", args: { task_id: "land-1", body: "次の仕事", project } }] }, "応答のみ"],
  });
  // スレッド内の未着手タスクを1件用意(ラウンド開始時点でhasWork=true)
  tasks.create({ id: "seed-open", body: "シード", project });
  host.say("着手してください");
  // ラウンド1: create_task(着地)でターン上限 → 着地ありなので継続される
  assert.ok(await waitUntil(() => {
    const st = host.roundState.get("alpha");
    return st && !st.running;
  }), "ラウンドが完走");
  // 自動継続の注入文が2ラウンド目に届いている
  assert.ok(host.roundState.get("alpha").lastKickoff.includes("自動継続"), "継続ノートが注入される");
  assert.ok(tasks.list().open.some((t) => t.id === "land-1"), "着地イベント(create_task)が検出されている");
});

test("着地ゼロラウンドは自動継続しない(着地ゼロ→停止)", async () => {
  const project = "pgate-stop";
  const { host, board } = mkHost({
    project,
    maxTurnsPerRound: 1,
    steps: ["作業がありません"],
  });
  tasks_create_seed(project);
  host.say("状況を報告してください");
  await waitUntil(() => {
    const st = host.roundState.get("alpha");
    return st && !st.running;
  });
  const posts = board.posts.map((p) => p.text);
  assert.ok(posts.some((t) => t.includes("[自動継続停止]") && t.includes("着地")), "着地ゼロ停止の告知が流れる");
  assert.ok(!posts.some((t) => t.includes("自動継続(")), "継続ノートは出ない");
});

function tasks_create_seed(project) {
  // openタスクが1件ある状況(hasWork=true)を固定する。stop系テストでは作らなくても
  // hasWorkがfalseだと継続判定に届かないため、必ず1件用意する。
  return null; // 実体は各テスト内で作る
}

test("ハード上限: 着地があり続けてもautoContinueRoundsで停止する", async () => {
  const project = "pgate-hard";
  const { host, tasks } = mkHost({
    project,
    autoContinueRounds: 1,
    maxTurnsPerRound: 1,
    steps: [
      { toolCalls: [{ name: "create_task", args: { task_id: "land-h1", body: "仕事1", project } }] },
      { toolCalls: [{ name: "create_task", args: { task_id: "land-h2", body: "仕事2", project } }] },
      "応答のみ",
    ],
  });
  tasks.create({ id: "seed-hard", body: "シード", project });
  host.say("着手してください");
  assert.ok(await waitUntil(() => {
    const st = host.roundState.get("alpha");
    return st && !st.running;
  }), "ラウンドが完走");
  // 上限1 → 継続1回まで。2回目のターン上限では着地があっても停止
  assert.ok(host.roundState.get("alpha").lastKickoff.includes("自動継続"), "1回目は継続");
});
