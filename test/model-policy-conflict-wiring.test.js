// 修正タスク fix-model-policy-config-wiring の検証:
// 承認フローの競合経路(verify-* finish_task / approve_task → mergeAgentWork conflict)で
// noteRejection(mainWorkspace, originalId, modelPolicy) の第3引数が
// 未定義識別子ではなく createTools に渡された modelPolicy であることを実gitで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { rejectionCount } from "../src/engine/model-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function initRepos(base) {
  const main = join(base, "main");
  const ws = join(base, "wt");
  mkdirSync(main, { recursive: true });
  GIT("git init -q -b main", main);
  GIT("git config user.email t@t && git config user.name t", main);
  writeFileSync(join(main, "package.json"), '{"name":"x","private":true}\n');
  GIT("git add -A && git commit -qm init", main);
  mkdirSync(ws, { recursive: true });
  GIT(`git clone -q "${main}" "${ws}"`, base);
  GIT("git config user.email w@t && git config user.name w", ws);
  GIT("git checkout -q -b agent/alpha", ws);
  return { main, ws };
}

function mkTools({ main, ws, board, tasks, bus, modelPolicy }) {
  const approvals = { require: true, pending: new Map([["cw1", { agentId: "alpha", worktreePath: ws }]]), pickReviewer: () => null };
  const tools = createTools({
    agent: { id: "beta", displayName: "検証係", role: "review", personaText: "# b" },
    workspace: ws, mainWorkspace: main,
    board, tasks, bus, approvals, modelPolicy,
  });
  return { tools, approvals };
}

test("verify完了の競合経路: noteRejectionにmodelPolicyが渡り、しきい値到達で推奨がボードへ出る", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-confw-"));
  try {
    const { main, ws } = initRepos(base);
    // 競合を作る: worktreeとmainの両方でREADMEを別内容に変更
    writeFileSync(join(ws, "README.md"), "worker side\n");
    GIT("git add -A && git commit -qm w1", ws);
    writeFileSync(join(main, "README.md"), "main side\n");
    GIT("git add -A && git commit -qm m1", main);
    const bus = new Bus();
    const board = new Board(bus);
    const tasks = new TaskBlackboard(ws, bus);
    tasks.create({ id: "cw1", role: "impl", body: "work" });
    const capture = new Board({ post(role, text) { board.post(role, text); }, on() { return () => {}; } });
    const { tools } = mkTools({ main, ws, board: capture, tasks, bus, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
    // 検証者(beta)が検証タスクverify-cw1を請求済みの状態を作る
    await tools.execute("claim_next_task", {});
    const r = await tools.execute("finish_task", { task_id: "verify-cw1" });
    assert.ok(r.ok === false, "競合時はok:false: " + String(r.text ?? "").slice(0, 80));
    assert.match(r.text, /競合/);
    assert.equal(rejectionCount(main, "cw1"), 1, "差し戻しが記録される");
    const notice = boardPostsOf(capture).find((t) => /モデル選択エスカレーション推奨/.test(t));
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
    writeFileSync(join(ws, "README.md"), "worker side\n");
    GIT("test: 競合經路テスト(approve_task側)をtools.jsのL482付近に追加
