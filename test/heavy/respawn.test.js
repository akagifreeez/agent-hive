// 起動時クラッシュ復旧(#7): worktree差分からの未完了作業再起票+放棄ブランチ掃除の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respawnUnfinishedWork } from "../../src/engine/respawn.js";
import { setupWorktrees } from "../../src/engine/worktree.js";
import { ensureGitRepo } from "../../src/engine/discover.js";
import { Board, Bus } from "../../src/engine/board.js";
import { TaskBlackboard } from "../../src/engine/tasks.js";
import { runCommand } from "../../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function commitIn(dir, file, content, msg) {
  writeFileSync(join(dir, file), content);
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}

test("respawn: 未マージのコミットがあるworktreeから再起票タスクが作られる", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] });
    await commitIn(paths.alpha, "feature.txt", "wip work\n", "wip-crash");
    const bus = new Bus();
    const board = new Board(bus, "main");
    const tasks = new TaskBlackboard(ws, bus);
    const r = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, board, bus });
    assert.equal(r.ok, true);
    assert.deepEqual(r.respawned, ["alpha"]);
    const ids = tasks.list().open.map((t) => t.id);
    const hit = ids.find((id) => id.startsWith("respawn-alpha-"));
    assert.ok(hit, "respawn-alpha-*タスクが起票されている");
    const body = readFileSync(join(ws, "tasks", "open", hit + ".md"), "utf8");
    assert.match(body, /クラッシュ復旧|worktrees\/alpha/);
    // ボード告知が出る
    assert.ok(board.posts.some((p) => p.text.includes("起動時スキャン") && p.text.includes("alpha")));
  } finally { rmTree(ws); rmTree(root); }
});

test("respawn: 既にmainへマージ済みのブランチは再起票しない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "beta" }] });
    await commitIn(paths.beta, "done.txt", "done work\n", "work-done");
    // mainへマージ(=仕事は回収済み)
    await runCommand({ command: `git merge --no-ff agent/beta -m "merge beta"`, cwd: ws, outputLimit: 500 });
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const r = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus });
    assert.equal(r.ok, true);
    assert.deepEqual(r.respawned, []);
    assert.equal(tasks.list().open.some((t) => t.id.startsWith("respawn-")), false);
  } finally { rmTree(ws); rmTree(root); }
});

test("respawn: 同じHEAD位置で2回呼んでも二重起票しない(冪等)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "gamma" }] });
    await commitIn(paths.gamma, "x.txt", "x\n", "wip-x");
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus });
    const r2 = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus });
    assert.equal(r2.respawned.length, 0, "2回目は新規起票なし");
    assert.equal(tasks.list().open.filter((t) => t.id.startsWith("respawn-")).length, 1);
  } finally { rmTree(ws); rmTree(root); }
});

test("respawn: 変更ゼロの放棄worktreeはcleanup=trueで削除/falseで提案", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "idle1" }, { id: "idle2" }] });
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    // cleanup=false(既定): 提案のみ
    const r1 = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus });
    assert.deepEqual(r1.suggested.sort(), ["idle1", "idle2"]);
    assert.deepEqual(r1.swept, []);
    assert.ok(existsSync(join(root, "idle1")), "worktreeは残る");
    // cleanup=true: 実削除
    const r2 = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus, opts: { cleanup: true } });
    assert.deepEqual(r2.swept.sort(), ["idle1", "idle2"]);
    assert.equal(existsSync(join(root, "idle1")), false);
    assert.equal(existsSync(join(root, "idle2")), false);
    const br = await runCommand({ command: `git branch --list agent/idle1`, cwd: ws, outputLimit: 500 });
    assert.equal(br.text.split("\n").slice(1).join("\n").trim(), "", "放棄ブランチも削除される");
  } finally { rmTree(ws); rmTree(root); }
});

test("respawn: 未コミット変更(dirty)だけのworktreeも再起票する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "delta" }] });
    writeFileSync(join(paths.delta, "uncommitted.txt"), "dirty\n");
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const r = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, bus });
    assert.deepEqual(r.respawned, ["delta"]);
    const t = tasks.list().open.find((x) => x.id.startsWith("respawn-delta-"));
    assert.ok(t, "dirtyworktreeからも起票");
    assert.match(readFileSync(join(ws, "tasks", "open", t.id + ".md"), "utf8"), new RegExp("worktrees/delta|クラッシュ復旧"));
  } finally { rmTree(ws); rmTree(root); }
});

test("respawn: worktreeRootが無くても起動を止めない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-respawn-"));
  try {
    await ensureGitRepo(ws);
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const r = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: join(ws, "nope"), tasks, bus });
    assert.equal(r.ok, true);
    assert.deepEqual(r.respawned, []);
  } finally { rmTree(ws); }
});
