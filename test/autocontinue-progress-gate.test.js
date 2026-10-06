// 進捗ゲート(自動継続の着地検出)のユニットテスト。
// 着地ありラウンド→自動継続、着地ゼロ→停止、autoContinueRoundsはハード上限として維持。
// 着地の3経路(タスクdone=task.finished / mainマージ=agent.merged / landingSignal)を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { createWorktree } from "../src/engine/worktree.js";
import { runCommand } from "../src/engine/exec.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-pgate-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

async function waitUntil(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

async function commitIn(dir, msg) {
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
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

function mkHost({ steps, project, autoContinueRounds = 3, maxTurnsPerRound = 2, landingSignal = null }) {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "pgate");
  const tasks = new TaskBlackboard(ws, bus);
  const calls = [];
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: ws,
    project,
    autoContinueRounds,
    maxTurnsPerRound,
    staggerMs: 0,
    landingSignal,
    modelFactory: () => scriptedModel(steps, calls),
    toolsFactory: (a) => createTools({ agent: a, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });
  return { host, board, tasks, bus, calls, agent, cleanup: () => rmTree(ws) };
}

test("進捗ゲート: 着地あり(タスク起票)ラウンドは自動継続する", async () => {
  const project = "pgate-cont";
  const { host, tasks, calls, cleanup } = mkHost({
    project,
    maxTurnsPerRound: 1,
    steps: [
      { toolCalls: [{ name: "create_task", arguments: { task_id: "land-1", body: "次の仕事", project } }] },
      "2ラウンド目の応答",
    ],
  });
  try {
    tasks.create({ id: "seed-open", body: "シード", project }); // hasWork=true の状態を作る
    host.say("着手してください");
    assert.ok(await waitUntil(() => calls.length >= 2), "自動継続で2ラウンド走る");
    assert.ok(host.roundState.get("alpha").lastKickoff.includes("自動継続"), "継続ノートが注入される");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: 着地ゼロラウンドは停止し[自動継続停止(着地ゼロ)]が通知される", async () => {
  const project = "pgate-stop";
  const { host, board, tasks, calls, cleanup } = mkHost({
    project,
    maxTurnsPerRound: 1,
    steps: ["着地のない応答"],
  });
  try {
    tasks.create({ id: "seed-stop", body: "シード", project }); // hasWork=true だが着地なし
    host.say("状況を報告してください");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "ラウンドが完走");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 1, "着地ゼロなので継続しない");
    const stop = board.posts.find((p) => p.from === "alpha" && p.text.includes("[自動継続停止(着地ゼロ(進捗なし))]"));
    assert.ok(stop, "着地ゼロ停止の告知がボードへ流れる");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: 着地があり続けてもautoContinueRounds(ハード上限)で停止する", async () => {
  const project = "pgate-hard";
  const { host, board, tasks, calls, cleanup } = mkHost({
    project,
    autoContinueRounds: 1,
    maxTurnsPerRound: 1,
    steps: [
      { toolCalls: [{ name: "create_task", arguments: { task_id: "land-h1", body: "仕事1", project } }] },
      { toolCalls: [{ name: "create_task", arguments: { task_id: "land-h2", body: "仕事2", project } }] },
      "応答のみ",
    ],
  });
  try {
    tasks.create({ id: "seed-hard", body: "シード", project });
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

test("進捗ゲート: landingSignalが真ならイベント無しでも着landedとして継続する", async () => {
  const project = "pgate-signal";
  const { host, tasks, calls, cleanup } = mkHost({
    project,
    maxTurnsPerRound: 1,
    landingSignal: () => true, // コミット検出など外部観測の代わり
    steps: ["応答のみ", "2ラウンド目の応答"],
  });
  try {
    tasks.create({ id: "seed-signal", body: "シード", project });
    host.say("着手してください");
    assert.ok(await waitUntil(() => calls.length >= 2), "信号着地で継続する");
  } finally {
    cleanup();
  }
});

test("進捗ゲート: ラウンド末mainマージ(agent.merged)は着地として継続を許す", async () => {
  const project = "pgate-merge";
  const ws = mktmp();
  const wtRoot = `${ws}-wt`;
  const bus = new Bus();
  const board = new Board(bus, "pgate-m");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  let calls = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      calls++;
      return { content: "応答", toolCalls: [], raw: { content: "応答" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await commitIn(ws, "base");
    const wtA = await createWorktree({ mainWorkspace: ws, worktreeRoot: wtRoot, agentId: "alpha" });
    // ラウンド中の変更(コミット済み)をworktreeへ作る → ラウンド末にmainへマージされる
    writeFileSync(join(wtA, "wip.txt"), "ラウンド中の変更\n");
    await commitIn(wtA, "wip");

    const host = new ChatHost({
      mains: [agent],
      mainWorkspace: ws,
      project,
      autoContinueRounds: 3,
      maxTurnsPerRound: 1,
      staggerMs: 0,
      modelFactory: () => model,
      toolsFactory: (a) => createTools({ agent: a, workspace: wtA, mainWorkspace: ws, board, tasks, bus }),
      board, tasks, bus,
    });
    host.worktreePaths = { alpha: wtA };
    tasks.create({ id: "seed-merge", body: "シード", project });
    host.say("作業してください");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "ラウンドが完走");
    assert.ok(board.posts.some((p) => p.text.includes("[マージ]") && p.text.includes("アルファ")), "ラウンド末マージが行われる");
    assert.equal(calls, 2, "マージ着地で自動継続する");
  } finally {
    rmTree(ws);
    rmTree(wtRoot);
  }
});
