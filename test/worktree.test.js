// v3: worktree隔離とマージ(クリーン/競合ループ)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

function rmTree(p) { try { rmTree(p); } catch { /* Windowsのファイルロックは無視 */ } }
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { setupWorktrees, mergeAgentWork } from "../src/engine/worktree.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { runCommand } from "../src/engine/exec.js";

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "hive-wt-"));
}

test("setupWorktrees: クリーンならfreshに張り直し、未コミット変更は保持+onKept告知", async () => {
  const ws = makeWorkspace();
  const bus = new Bus();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const agents = [{ id: "alpha" }, { id: "beta" }];
  const p1 = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents });
  assert.ok(existsSync(p1.alpha));
  assert.ok(existsSync(join(p1.alpha, ".gitignore")));
  // alphaはクリーン(コミットだけ) → 再実行でブランチごとfreshになる
  await runCommand({ command: "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m old-work", cwd: p1.alpha, outputLimit: 500 });
  // betaは未コミットの下書き → 無音に壊さず保持する
  writeFileSync(join(p1.beta, "draft.md"), "未コミットの下書き");
  const kept = [];
  const p2 = await setupWorktrees({
    mainWorkspace: ws, worktreeRoot: root, agents,
    onKept: (k) => kept.push(k),
  });
  const log = await runCommand({ command: "git log --oneline agent/alpha", cwd: ws, outputLimit: 500 });
  assert.doesNotMatch(log.text, /old-work/); // クリーンなブランチ残骸は掃除
  assert.equal(existsSync(join(p2.beta, "draft.md")), true); // 未コミット変更は保持
  assert.deepEqual(kept.map((k) => k.agentId), ["beta"]);
  rmTree(ws);
  rmTree(root);
});

test("finish_taskの実体: worktreeの変更がmainへマージされる", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  writeFileSync(join(wt, "code.txt"), "v1 by alpha");
  const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t1" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "code.txt"), "utf8"), "v1 by alpha");
  const log = await runCommand({ command: "git log --oneline", cwd: ws, outputLimit: 2000 });
  assert.match(log.text, /merge: t1 by alpha/);
  rmTree(ws);
  rmTree(root);
});

test("競合時はconflict返却でmainは無傷。解決して再finishすれば取り込まれる", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  // main側が先に進む(レビュー担当の修正を想定)
  writeFileSync(join(ws, "code.txt"), "line from main");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -m 'main change'", cwd: ws, outputLimit: 1000 });
  // alphaも同じ行を別内容で変更
  writeFileSync(join(wt, "code.txt"), "line from alpha");
  const r1 = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t2" });
  assert.equal(r1.conflict, true);
  assert.equal(readFileSync(join(ws, "code.txt"), "utf8"), "line from main"); // mainは無傷
  // 解決ループ: worktreeでmainを取り込み、解決してコミット、再マージ
  await runCommand({ command: "git merge main", cwd: wt, outputLimit: 2000 });
  writeFileSync(join(wt, "code.txt"), "resolved by alpha");
  await runCommand({ command: "git add -A && git -c user.name=alpha -c user.email=alpha@hive.local commit -m 'resolve'", cwd: wt, outputLimit: 1000 });
  const r2 = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t2" });
  assert.equal(r2.ok, true);
  assert.equal(readFileSync(join(ws, "code.txt"), "utf8"), "resolved by alpha");
  rmTree(ws);
  rmTree(root);
});

test("finish_taskツール経由: マージ+ボード投稿+タスクdoneまで通る", async () => {
  const ws = makeWorkspace();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  tasks.seed([{ id: "build-thing", role: "impl", body: "作る" }]);
  const { createTools } = await import("../src/engine/tools.js");
  const tools = createTools({ agent: { id: "alpha", displayName: "アルファ", role: "impl" }, workspace: wt, mainWorkspace: ws, board, tasks, bus });
  await tools.execute("claim_next_task", {});
  await tools.execute("write_file", { path: "out.txt", content: "成果" });
  const r = await tools.execute("finish_task", { task_id: "build-thing" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "成果");
  assert.ok(tasks.snapshot().done.some((f) => f.includes("build-thing")));
  assert.ok(board.posts.some((p) => p.from === "system" && /マージ/.test(p.text)));
  rmTree(ws);
  rmTree(root);
});
