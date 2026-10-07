// 進捗ゲート(自動継続の着地検出)のユニットテスト。
// 着地ありラウンド→自動継続、着地ゼロ→停止、autoContinueRoundsはハード上限として維持。
// 着地の3経路(タスクdone=task.finished / ラウンド末mainマージ=agent.merged / landingSignal)を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-pgate-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

// ステップ配列に従う固定応答モデル。文字列=テキスト応答(ツールなし)、
// {toolCalls:[...]}=ツール呼び出しのみのターン(maxTurnsPerRound=1想定でターン上限を作る)
function scriptedModel(steps, calls) {
  let i = 0;
  return {
    maxTokens: 100,
    async chat() {
      calls.push(i);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === "string"
        ? { content: step, toolCalls: [], raw: { content: step }, usage: { promptTokens: 1, completionTokens: 1 } }
        : { content: "", toolCalls: step.toolCalls ?? [], raw: { content: "" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

function mkHost({ steps, project, autoContinueRounds = 3, maxTurnsPerRound = 1, landingSignal = null, onToolResult = null }) {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "pgate");
  const tasks = new TaskBlackboard(ws, bus);
  const calls = [];
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: null, // gitマージ経路は外す(finish_taskはタスクdoneのみ=着地イベント)
    project,
    autoContinueRounds,
    maxTurnsPerRound,
    staggerMs: 0,
    landingSignal,
    // modelFactoryはラウンドごとに呼ばれるため、単一インスタンスを返す(都度生成すると
    // ステップ位置が毎ラウンド巻き戻り、2ラウンド目がsteps[0]を再実行して着地が消える)
    modelFactory: (() => { const m = scriptedModel(steps, calls); return () => m; })(),
    toolsFactory: (a) => {
      const t = createTools({ agent: a, workspace: ws, mainWorkspace: null, board, tasks, bus });
      if (!onToolResult) return t;
      return { specs: t.specs, execute: async (name, args) => { const out = await t.execute(name, args); onToolResult(name, args, out); return out; } };
    },
    board, tasks, bus,
  });
  return { host, board, tasks, bus, calls, agent, ws, cleanup: () => rmTree(ws) };
}

test("進捗ゲート: 着地あり(タスクdone)ラウンドは自動継続する", async () => {
  const { host, tasks, calls, cleanup } = mkHost({
    project: "pgate-cont",
    steps: [
      { toolCalls: [{ name: "finish_task", arguments: { task_id: "t1" } }] },
      "2ラウンド目の応答",
    ],
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t1", body: "担当仕事", project: "pgate-cont" });
    tasks.create({ id: "seed-open", body: "シード", project: "pgate-cont" }); // hasWork=trueを保つ
    host.say("着手してください");
    assert.ok(await waitUntil(() => calls.length >= 2), "着地ありなので自動継続で2ラウンド走る");
    assert.ok(host.roundState.get("alpha").lastKickoff.includes("自動継続"), "継続ノートが注入される");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: 着地ゼロラウンドは停止し[自動継続停止(着地ゼロ)]が通知される", async () => {
  const { host, board, tasks, calls, cleanup } = mkHost({
    project: "pgate-stop",
    steps: ["着地のない応答"],
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t2", body: "担当仕事", project: "pgate-stop" }); // hasWork=true
    host.say("状況を報告してください");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "ラウンドが完走");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls.length, 1, "着地ゼロなので継続しない");
    const stop = board.posts.find((p) => p.from === "alpha" && p.text.includes("[自動継続停止(着地ゼロ(進捗なし))]"));
    assert.ok(stop, "着地ゼロ停止の告知がボードへ流れる");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: 着地があり続けてもautoContinueRounds(ハード上限)で停止する", async () => {
  const toolResults = [];
  const { host, board, tasks, calls, cleanup } = mkHost({
    project: "pgate-hard",
    onToolResult: (name, args, out) => toolResults.push([name, out.ok, String(out.text ?? "").slice(0, 120)]),
    autoContinueRounds: 1,
    landingSignal: () => true, // 着地があり続ける状況を模擬
    steps: [
      { toolCalls: [{ name: "finish_task", arguments: { task_id: "t3" } }] },
      { toolCalls: [{ name: "post_to_board", arguments: { text: "進行中" } }] }, // 着地無しでターンのみ消費
      { toolCalls: [{ name: "post_to_board", arguments: { text: "停止前" } }] }, // 同上(応答のみだとidle終了で停止通知が出ない)
    ],
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t3", body: "仕事3", project: "pgate-hard" });
    tasks.create({ id: "seed-hard", body: "シード", project: "pgate-hard" }); // 全タスクdone後もhasWork=trueを保つ
    host.say("着手してください");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "ラウンドが完走");
    assert.equal(calls.length, 2, "継続は上限1回まで(着地があっても2回目は継続しない)");
    assert.ok(host.roundState.get("alpha").lastKickoff.includes("自動継続(1ラウンド目)"), "1回だけ継続される");
    assert.ok(board.posts.some((p) => p.text.includes("[自動継続停止(ハード上限)]")), "ハード上限停止が通知される");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: landingSignalが真ならイベント無しでも着地ありとして継続する", async () => {
  const { host, tasks, calls, cleanup } = mkHost({
    project: "pgate-signal",
    landingSignal: () => true, // コミット検出など外部観測の入口
        steps: [
      { toolCalls: [{ name: "list_files", arguments: {} }] }, // ターン上限で終わるラウンド(着地イベント無し)
      "2ラウンド目の応答",
    ],
  });
  try {
    tasks.create({ id: "seed-signal", body: "シード", project: "pgate-signal" }); // hasWork=true
    host.say("着手してください");
    assert.ok(await waitUntil(() => calls.length >= 2), "信号着地で継続する");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: agent.merged/task.finishedで着地フラグが立ち、判定で1度消費される", async () => {
  const { host, bus, tasks, cleanup } = mkHost({ project: "pgate-events", steps: ["応答"] });
  try {
    assert.equal(host.landedThisRound.get("alpha"), false, "初期値は着地なし");
    bus.emit("task.finished", { agent: "alpha", taskId: "x" });
    assert.equal(host.landedThisRound.get("alpha"), true, "task.finishedで着地フラグが立つ");
    bus.emit("agent.merged", { agent: "alpha", thread: "pgate" });
    assert.equal(host.landedThisRound.get("alpha"), true, "agent.mergedでも着地フラグが立つ");
    // 他エージェント由来のイベントは自分には着地として効かない
    const other = mkHost({ project: "pgate-events", steps: ["応答"] });
    other.bus.emit("task.finished", { agent: "beta", taskId: "y" });
    assert.equal(other.host.landedThisRound.get("alpha"), false, "他者由来の着地は拾わない");
    other.cleanup();
    // noteLanding()で手動消費の確認(判定経路と同じAPI)
    host.noteLanding(null);
    assert.equal(host.landedThisRound.get("alpha"), true, "noteLanding(全体)でフラグが立つ");
  } finally {
    cleanup();
  }
});

test("tasks.create(): id無し/不正idは拒否され、残骸ファイルもtask.createdも出さない", async () => {
  const { tasks, bus, ws, cleanup } = mkHost({ project: "pgate-id", steps: ["応答"] });
  try {
    const events = [];
    bus.on("task.created", (p) => events.push(p));
    assert.equal(tasks.create({ body: "id無し" }), false, "id欠落は拒否");
    assert.equal(tasks.create({ id: "", body: "空id" }), false, "空idは拒否");
    assert.equal(tasks.create({ id: "悪い_id", body: "文字種外" }), false, "文字種外は拒否");
    assert.equal(tasks.create({ id: "ok-task-1", body: "正常" }), true, "正常idは作れる");
    assert.deepEqual(events, [{ taskId: "ok-task-1", project: "" }], "task.createdは正idで1件だけ");
    const openFiles = readdirSync(join(ws, "tasks", "open"));
    assert.ok(!openFiles.some((f) => !/^[a-z0-9][a-z0-9-]*\.md$/.test(f)), "open配下に不正名ファイル(undefined.md等)を作らない");
    assert.ok(openFiles.includes("ok-task-1.md"), "正常タスクのファイルは生成される");
  } finally {
    cleanup();
  }
});

test("tasks.seed(): 正常idのseedはtask.createdを発火させる(先行者報告の非再現を固定)", async () => {
  const { tasks, bus, cleanup } = mkHost({ project: "pgate-seed", steps: ["応答"] });
  try {
    const events = [];
    bus.on("task.created", (p) => events.push(p));
    tasks.seed([{ id: "seed-a", body: "A" }]); // project省略("")で起床副作用を避け、発火のみ観測
    assert.equal(events.length, 1, "seed経路でもtask.createdは1件発火する");
    assert.equal(events[0].taskId, "seed-a");
  } finally {
    cleanup();
  }
});
