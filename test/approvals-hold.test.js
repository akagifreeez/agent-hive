// イシュー#22: 承認フロー(approvals.require)有効時、実装者に保留中(検証待ち)タスクが
// 残る間はラウンド終了の自動マージを保留し([承認待ち]告知)、承認後(approve_task)にだけ
// mainへ取り込まれることを検証する。実ChatHost+実git(worktree)方式。
// 注: 旧版(48e7a8e)は未定義ヘルパー/未定義識別子で実行不可だったため、現行APIに合わせて再実装した。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "hive-approvals-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

async function waitUntil(fn, ms = 180000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

// 即答する固定応答モデル(ツール呼出なし=ラウンドは1ターンで終わる)
function scriptedModel(text) {
  return {
    maxTokens: 100,
    async chat() {
      return { content: text, toolCalls: [], raw: { content: text }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

async function commitIn(dir, msg) {
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}

// テスト環境: mainリポジトリ(ws)+alphaのworktree。ChatHostのラウンド末自動マージ経路を有効化。
async function mkEnv() {
  const ws = mktmp();
  const wtRoot = `${ws}-wt`;
  await ensureGitRepo(ws);
  writeFileSync(join(ws, "base.txt"), "base\n");
  await commitIn(ws, "base");
  const wtA = await createWorktree({ mainWorkspace: ws, worktreeRoot: wtRoot, agentId: "alpha" });

  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const board = new Board(bus, "approvals");
  const tasks = new TaskBlackboard(ws, bus);
  const approvals = {
    require: true,
    pending: new Map(),
    pickReviewer(excludeId) {
      return excludeId === "beta"
        ? { id: "gamma", displayName: "ガンマ", role: "impl" }
        : { id: "beta", displayName: "ベータ", role: "review" };
    },
  };
  const alpha = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const model = scriptedModel("待機中");
  const host = new ChatHost({
    mains: [alpha],
    mainWorkspace: ws, // ラウンド終了の自動マージ(#22の対象経路)
    project: "approvals",
    autoContinueRounds: 0,
    staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: (agent) => createTools({ agent, workspace: wtA, mainWorkspace: ws, board, tasks, bus, approvals }),
    board, tasks, bus,
    approvals,
  });
  host.worktreePaths = { alpha: wtA };
  const alphaTools = host.toolsFactory(alpha);

  // 検証者beta(approve_taskの実行主体)。マージ対象はpending.worktreePath(実装者側)
  const beta = { id: "beta", displayName: "ベータ", role: "review", personaText: "# B" };
  const betaTools = createTools({ agent: beta, workspace: wtA, mainWorkspace: ws, board, tasks, bus, approvals });

  const cleanup = () => { rmTree(ws); rmTree(wtRoot); };
  return { ws, wtA, posts, tasks, approvals, alphaTools, betaTools, host, cleanup };
}

test("approvals: 保留中タスクを持つ実装者のラウンド作業はmainへマージされず、承認後に入る", async () => {
  const env = await mkEnv();
  const { ws, wtA, posts, tasks, approvals, alphaTools, betaTools, host, cleanup } = env;
  try {
    // alphaが担当中のタスク
    tasks.assign({ agentId: "alpha", taskId: "t-hold", body: "テスト用タスク", project: "approvals" });
    assert.ok(tasks.claimedBy("alpha").some((t) => t.id === "t-hold"), "alphaが請求中");

    // worktreeにラウンド中の変更を作り、実フローどおりfinish_taskで保留(検証タスク起票)にする
    writeFileSync(join(wtA, "wip.txt"), "ラウンド中の変更\n");
    await commitIn(wtA, "wip");
    const fin = await alphaTools.execute("finish_task", { task_id: "t-hold" });
    assert.equal(fin.ok, true, `finish_taskが成功: ${fin.text ?? ""}`);
    assert.match(fin.text, /検証タスク verify-t-hold/, "検証タスクが起票される");
    assert.equal(approvals.pending.get("t-hold")?.agentId, "alpha", "保留情報が立つ");

    // ラウンド実行(モデルは即答)。ラウンド末マージは保留されるはず
    host.say("[テスト] ラウンド実行");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "alphaのラウンドが完了");

    // 承認待ちのためmainへマージされていないこと
    assert.equal(existsSync(join(ws, "wip.txt")), false, "承認待ちの間はmainへマージされない");
    const holdPost = posts.find((p) => p.text.includes("[承認待ち]") && p.text.includes("アルファ"));
    assert.ok(holdPost, "[承認待ち] の告知がボードに流れる");

    // 検証者が承認 → マージされる
    const apr = await betaTools.execute("approve_task", { task_id: "t-hold" });
    assert.equal(apr.ok, true, `approve_taskが成功: ${apr.text ?? ""}`);
    assert.equal(existsSync(join(ws, "wip.txt")), true, "承認後はmainへマージされる");
    const merged = posts.find((p) => p.text.includes("[承認]") && p.text.includes("t-hold"));
    assert.ok(merged, "[承認] マージ告知が流れる");
    assert.equal(approvals.pending.has("t-hold"), false, "保留は解消");
  } finally {
    cleanup();
  }
});

test("approvals: 保留中タスクが無ければ従来どおりラウンド終了時にmainへマージされる", async () => {
  const env = await mkEnv();
  const { ws, wtA, posts, host, cleanup } = env;
  try {
    writeFileSync(join(wtA, "ok.txt"), "承認不要の変更\n");
    await commitIn(wtA, "ok");

    host.say("[テスト] ラウンド実行2");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "alphaのラウンドが完了");

    assert.equal(existsSync(join(ws, "ok.txt")), true, "保留中タスクが無ければマージされる");
    const merged = posts.find((p) => p.text.includes("[マージ]") && p.text.includes("ラウンド中の作業"));
    assert.ok(merged, "[マージ] の告知が流れる");
  } finally {
    cleanup();
  }
});

test("approvals: 検証タスクはprojectを引き継ぎ、project指定レビュアーの検証完了でmainへマージされる", async () => {
  // 回帰(イシュー#22対応中に発見): 検証タスク起票時にprojectメタが欠落し、project絞り込みの
  // レビュアーがclaimできず承認待ちが詰まる実害。claim→検証finish→マージの実フローで検証する。
  const env = await mkEnv();
  const { ws, wtA, tasks, approvals, alphaTools, betaTools, host, cleanup } = env;
  try {
    tasks.assign({ agentId: "alpha", taskId: "t-proj", body: "project付きの仕事", project: "approvals" });
    writeFileSync(join(wtA, "proj.txt"), "project付きの変更\n");
    await commitIn(wtA, "proj");
    const fin = await alphaTools.execute("finish_task", { task_id: "t-proj" });
    assert.equal(fin.ok, true, "finish_taskが成功");
    const verify = tasks.list().open.find((t) => t.id === "verify-t-proj");
    assert.ok(verify, "検証タスクが起票されている");
    assert.equal(verify.project, "approvals", "元タスクのprojectを引き継ぐ");

    // ラウンド実行 → 承認待ちのため保留
    host.say("[テスト] ラウンド実行3");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "alphaのラウンドが完了");
    assert.equal(existsSync(join(ws, "proj.txt")), false, "承認待ちの間はmainへマージされない");

    // project指定の検証者がclaim → 検証finishでマージ(実フロー)
    const c = await betaTools.execute("claim_next_task", { project: "approvals" });
    assert.ok(c.ok, "レビュアーが検証タスクを請求できる: " + String(c.text ?? "").slice(0, 60));
    const vf = await betaTools.execute("finish_task", { task_id: "verify-t-proj" });
    assert.equal(vf.ok, true, "検証finishが成功: " + String(vf.text ?? "").slice(0, 60));
    assert.equal(existsSync(join(ws, "proj.txt")), true, "検証完了でmainへマージされる");
    assert.equal(approvals.pending.has("t-proj"), false, "保留は解消");
    assert.equal(tasks.claimedBy("alpha").some((t) => t.id === "t-proj"), false, "元タスクも完了確定");
  } finally {
    cleanup();
  }
});
