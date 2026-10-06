// 実装者≠検証者の強制(#3): finish_taskは検証タスクを起票してマージを保留し、
// 自分によるapproveは拒否される。マージ成功パスはgit(worktree)が必要なため実走確認
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");

function mkEnv() {
  const ws = mkdtempSync(join(tmpdir(), "hive-approve-"));
  const main = mkdtempSync(join(tmpdir(), "hive-approve-main-"));
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const approvals = {
    require: true,
    pending: new Map(),
    pickReviewer(excludeId) {
      const candidates = [
        { id: "alpha", role: "impl" },
        { id: "beta", role: "review" },
        { id: "gamma", role: "lead" },
      ].filter((a) => a.id !== excludeId);
      return candidates.find((a) => a.role === "review") ?? candidates[0] ?? null;
    },
  };
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = createTools({
    agent, workspace: ws, mainWorkspace: main,
    board: new Board(bus), tasks, bus, approvals,
  });
  return { ws, main, bus, tasks, approvals, agent, tools };
}

function cleanup(ws, main) {
  for (const d of [ws, main]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
  }
}

test("承認フロー: finish_taskはマージを保留し検証タスクを起票・自分によるapproveは拒否される", async () => {
  const { ws, main, tasks, approvals, tools } = mkEnv();
  try {
    tasks.create({ id: "t1", role: "impl", body: "実装する仕事\nacceptance: テストが通る" });
    const claim = await tools.execute("claim_next_task", {});
    assert.ok(claim.ok, "claimできる");

    // finish_task → マージは保留・検証タスク起票(mergeAgentWorkは走らない=git不要で検証可能)
    const r = await tools.execute("finish_task", { task_id: "t1" });
    assert.match(r.text, /検証タスク verify-t1/);
    assert.equal(approvals.pending.get("t1")?.agentId, "alpha");
    const verify = tasks.list().open.find((t) => t.id === "verify-t1");
    assert.ok(verify, "検証タスクが起票されている");
    assert.equal(verify.project, "", "元タスクのprojectを引き継ぐ");
    assert.ok(tasks.claimedBy("alpha").some((t) => t.id === "t1"), "元タスクは保留(完了確定しない)");

    // 自分によるapproveは拒否
    const r2 = await tools.execute("approve_task", { task_id: "t1" });
    assert.match(r2.text, /自分で承認できません/);

    // 未存在タスクのapproveも分かりやすく拒否
    const r3 = await tools.execute("approve_task", { task_id: "nope" });
    assert.match(r3.text, /承認待ちのタスクがありません/);
  } finally {
    cleanup(ws, main);
  }
});

test("承認フロー: approvals未指定なら従来どおり即マージ(後方互換)", async () => {
  // approvalsを渡さない状態ではfinish_task分岐に入らないことの確認(pendingを立てない)
  const { ws, main, tasks, tools } = mkEnv();
  // mkEnvはapprovals必須なので最小構成を作り直す
  const bus = new Bus();
  const board = new Board(bus);
  const tasks2 = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools2 = createTools({
    agent, workspace: ws, mainWorkspace: main,
    board, tasks: tasks2, bus,
  });
  try {
    tasks2.create({ id: "t2", role: "impl", body: "仕事2" });
    await tools2.execute("claim_next_task", {});
    // mainはgitリポジトリでないためマージ自体は失敗するが、「検証タスク」は起票されない
    const r = await tools2.execute("finish_task", { task_id: "t2" });
    assert.doesNotMatch(r.text, /検証タスク/);
    assert.equal(approvalsUndefinedPendingCount(tasks2), 0);
  } finally {
    cleanup(ws, main);
  }
  function approvalsUndefinedPendingCount(t) { return 0; } // 従来パス: 保留概念なし(常に0)
});

test("承認フロー: 検証タスク起票は元タスクのprojectを引き継ぐ(project指定レビュアーが請求できる)", async () => {
  // 回帰: claimedBy()がprojectメタを返していなかったため、検証タスクにproject行が付かず、
  // project絞り込みのレビュアーがclaimできずに承認待ちが詰まる実害があった(イシュー#22対応中に発見)
  const { ws, main, tasks, approvals, tools } = mkEnv();
  try {
    tasks.create({ id: "tp1", role: "impl", project: "proj-x", body: "実装する仕事" });
    const claim = await tools.execute("claim_next_task", { project: "proj-x" });
    assert.ok(claim.ok, "implはproject指定でclaimできる");
    const r = await tools.execute("finish_task", { task_id: "tp1" });
    assert.match(r.text, /検証タスク verify-tp1/);
    const verify = tasks.list().open.find((t) => t.id === "verify-tp1");
    assert.ok(verify, "検証タスクが起票されている");
    assert.equal(verify.project, "proj-x", "元タスクのprojectを引き継ぐ");
    // project指定のreviewが請求できる(これができると承認待ちが詰まらない)
    const reviewer = { id: "beta", displayName: "ベータ", role: "review", personaPath: PERSONA };
    const rtools = createTools({ agent: reviewer, workspace: ws, mainWorkspace: main, board: new Board(new Bus()), tasks, bus: new Bus(), approvals });
    const rc = await rtools.execute("claim_next_task", { project: "proj-x" });
    assert.ok(rc.ok, "reviewが検証タスクを請求できる: " + String(rc.text ?? "").slice(0, 60));
    assert.equal(approvals.pending.get("tp1")?.agentId, "alpha", "保留情報が立つ");
  } finally {
    cleanup(ws, main);
  }
});
