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
    agent: { id: "beta", displayName: "ベータ", role: "review", personaText: "# R" },
    workspace: ws,
    mainWorkspace: main,
    board, tasks, bus,
    approvals,
    modelPolicy,
  });
  return { tools, approvals };
}


test("finish_task(verify)の競合経路でnoteRejectionがmodelPolicyを受け、差し戻しが記録される", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-confw-"));
  try {
    const { main, ws } = initRepos(base);
    writeFileSync(join(ws, "README.md"), "worker side\n");
    GIT("git add -A", ws);
    GIT("git -c user.email=w@t -c user.name=w commit -qm wip", ws);
    // 実装側worktreeをmainから先行させて競合を作る: main側でREADMEを変更してコミット
    writeFileSync(join(main, "README.md"), "main side changed\n");
    GIT("git add -A", main);
    GIT("git -c user.email=t@t -c user.name=t commit -qm main-change", main);
    const bus = new Bus();
    const tasks = new TaskBlackboard(base, bus);
    tasks.create({ id: "cw1", role: "impl", body: "work" });
    const posts = [];
    bus.on("board", (p) => posts.push(p.text ?? ""));
    const board = new Board(bus, "s");
    const { tools } = mkTools({ main, ws, board, tasks, bus, modelPolicy: { escalationThreshold: 1, escalateModel: null } });
    // 実装者(alpha)がverify-cw1を起票済みの前提(実運流れを固定)。
    tasks.create({ id: "verify-cw1", role: "review", body: "verify cw1", dependsOn: [] });
    tasks.assign({ agentId: "beta", taskId: "verify-cw1", body: "verify cw1", project: "s" });
    await tools.execute("claim_next_task", {});
    const r = await tools.execute("finish_task", { task_id: "verify-cw1" });
    assert.ok(r.ok === false, "競合時はok:false: " + String(r.text ?? "").slice(0, 80));
    assert.match(r.text, /競合/);
    assert.equal(rejectionCount(main, "cw1"), 1, "差し戻しが台帳に残る");
    const notice = posts.find((t) => /差し戻し|エスカレーション/.test(t));
    assert.ok(notice, "差し戻し告知(1回目=即差し戻し・2回目以降=エスカレーション)がボードに流れる");
    assert.match(notice, /1 回/, "閾値config(しきい値1)が反映される(2回目からでも1回目で即差し戻し)");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* 掃除失敗は無視 */ }
  }
});
