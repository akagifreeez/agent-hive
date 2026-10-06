// 修正タスク fix-model-policy-config-wiring の検証:
// 承認フローの競合経路(verify-* finish_task / approve_task → mergeAgentWork conflict)で
// noteRejection(mainWorkspace, taskId, modelPolicy) の第3引数が
// 未定義識別子ではなく createTools に渡された modelPolicy であることを実gitで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { rejectionCount } from "../src/engine/model-policy.js";

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function initRepos(base) {
  const main = join(base, "main");
  const ws = join(base, "wt");
  mkdirSync(main, { recursive: true });
  GIT("git init -q -b main", main);
  GIT("git config user.email t@t && git config user.name t", main);
  writeFileSync(join(main, "package.json"), '{"name":"x"}' + String.fromCharCode(10));
  GIT("git add -A && git commit -qm init", main);
  mkdirSync(ws, { recursive: true });
  GIT('git clone -q "' + main + '" "' + ws + '"', base);
  GIT("git config user.email w@t && git config user.name w", ws);
  GIT("git checkout -q -b agent/alpha", ws);
  return { main, ws };
}

// 競合工作: worktree側とmain側の両方でREADMEを別内容に変更してコミット
function makeConflict(main, ws) {
  writeFileSync(join(ws, "README.md"), "worker side" + String.fromCharCode(10));
  GIT("git add -A && git commit -qm w1", ws);
  writeFileSync(join(main, "README.md"), "main side" + String.fromCharCode(10));
  GIT("git add -A && git commit -qm m1", main);
}

function captureBoard(posted) {
  return { post(role, text) { posted.push(text); }, on() { return () => {}; } };
}

const APPROVALS = (ws) => ({
  require: true,
  pickReviewer() { return { id: "beta", role: "review" }; },
  pending: new Map(),
});

test("verify完了の競合経路: noteRejectionにmodelPolicyが渡り、しきい値到達で推奨がボードへ出る", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-confw-"));
  try {
    const { main, ws } = initRepos(base);
    makeConflict(main, ws);
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    tasks.create({ id: "cw1", role: "impl", body: "work" });
<<<<<<< HEAD
    const posted = [];
    const capture = { post(role, text) { posted.push(text); }, on() { return () => {}; } };
    const { tools } = mkTools({ main, ws, board: capture, tasks, bus, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
    // 検証者(beta)が検証タスクverify-cw1を請求済みの状態を作る
    tasks.create({ id: "verify-cw1", role: null, body: "検証する" });
    await tools.execute("claim_next_task", {});
    const r = await tools.execute("finish_task", { task_id: "verify-cw1" });
=======
    const approvals = APPROVALS(ws);
    const postedA = [];
    const postedB = [];
    const alpha = createTools({
      agent: { id: "alpha", displayName: "実装係", role: "impl", personaText: "# a" },
      workspace: ws, mainWorkspace: main,
      board: captureBoard(postedA), tasks, bus, approvals,
      modelPolicy: { escalationThreshold: 1, escalateModel: null },
    });
    // 実装者が cw1 を請求→完了(検証タスクverify-cw1が起票・保留情報が立つ)
    const c1 = await alpha.execute("claim_next_task", {});
    assert.ok(c1.ok, "alphaがclaimできる");
    const f1 = await alpha.execute("finish_task", { task_id: "cw1" });
    assert.match(f1.text, /検証タスク verify-cw1/);
    assert.ok(approvals.pending.get("cw1"), "保留情報が立つ");
    // 検証者(beta)が検証タスクを請求→完了 → マージ競合 → noteRejectionにmodelPolicyが渡る
    const beta = createTools({
      agent: { id: "beta", displayName: "検証係", role: "review", personaText: "# b" },
      workspace: ws, mainWorkspace: main,
      board: captureBoard(postedB), tasks, bus, approvals,
      modelPolicy: { escalationThreshold: 1, escalateModel: null },
    });
    const c2 = await beta.execute("claim_next_task", {});
    assert.ok(c2.ok && c2.text.includes("verify-cw1"), "betaが検証タスクを請求: " + String(c2.text).slice(0, 60));
    const r = await beta.execute("finish_task", { task_id: "verify-cw1" });
>>>>>>> main
    assert.ok(r.ok === false, "競合時はok:false: " + String(r.text ?? "").slice(0, 80));
    assert.match(r.text, /競合/);
    assert.equal(rejectionCount(main, "cw1"), 1, "差し戻しが記録される");
    const notice = postedB.find((t) => /モデル選択エスカレーション推奨/.test(t));
    assert.ok(notice, "しきい値1なら1回目で推奨が投稿される");
    assert.match(notice, /1 回/, "実config(しきい値1)が効いている(既定2なら出ない)");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});

test("approve_taskの競合経路でもnoteRejectionがmodelPolicyを受け、差し戻しが記録される", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-confw-"));
  try {
    const { main, ws } = initRepos(base);
    makeConflict(main, ws);
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    tasks.create({ id: "cw1", role: "impl", body: "work" });
    const approvals = APPROVALS(ws);
    approvals.pending.set("cw1", { agentId: "alpha", worktreePath: ws });
    const posted = [];
    const beta = createTools({
      agent: { id: "beta", displayName: "検証係", role: "review", personaText: "# b" },
      workspace: ws, mainWorkspace: main,
      board: captureBoard(posted), tasks, bus, approvals,
      modelPolicy: { escalationThreshold: 1, escalateModel: null },
    });
    const r = await beta.execute("approve_task", { task_id: "cw1" });
    assert.ok(r.ok === false, "競合時はok:false: " + String(r.text ?? "").slice(0, 80));
    assert.match(r.text, /競合/);
    assert.equal(rejectionCount(main, "cw1"), 1, "approve_task側でも差し戻しが記録される");
    const notice = posted.find((t) => /モデル選択エスカレーション推奨/.test(t));
    assert.ok(notice, "しきい値1ならapprove経路でも推奨が出る");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});
