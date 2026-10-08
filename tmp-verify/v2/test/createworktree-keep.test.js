// worktree.js createWorktree の未マージ保護テスト(fix-createworktree-unmerged-loss)。
// イシュー#7系: プロセス死で中断した「コミット済み・未マージ」作業を、worktree再作成が
// 無音に壊さないことを担保する。setupWorktrees経由の保持(respawn.test.js / heavy/worktree.test.js)
// に加えて、(1)createWorktree直呼びの二重防御 (2)setupWorktrees→respawnの接続(再起動シナリオ)を検証。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { setupWorktrees, createWorktree, hasUnmergedWork } from "../src/engine/worktree.js";
import { respawnUnfinishedWork } from "../src/engine/respawn.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { runCommand } from "../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function commitIn(dir, file, content, msg) {
  writeFileSync(join(dir, file), content);
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}

test("createWorktree直呼び: 未マージコミット付きworktreeは削除・再作成せず保持する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-wt-keep-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });

    // 1回目: worktree作成→コミット済み・未マージの作業を残す(プロセス死の想定)
    const p1 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "delta" });
    await commitIn(p1, "feature.txt", "crashed work\n", "wip-crash");
    const before = await runCommand({ command: `git rev-parse agent/delta`, cwd: ws, outputLimit: 200 });
    const headBefore = before.text.split("\n")[1]?.trim();

    // 2回目: 同じworktreeでcreateWorktreeを再実行(ランナー再起動の想定)→ 壊さず保持
    const kept = [];
    const p2 = await createWorktree({
      mainWorkspace: ws, worktreeRoot: root, agentId: "delta",
      onKept: (k) => kept.push(k),
    });
    assert.equal(p2, p1, "worktreeパスは変えない(再作成しない)");
    const after = await runCommand({ command: `git rev-parse agent/delta`, cwd: ws, outputLimit: 200 });
    assert.equal(after.text.split("\n")[1]?.trim(), headBefore, "ブランチHEADが保持される(削除・再作成されていない)");
    assert.equal(existsSync(join(p2, "feature.txt")), true, "コミット済みの作業ファイルが残る");
    assert.deepEqual(kept, [{ agentId: "delta", path: p1, detail: "未マージコミットを保持" }], "onKeptで保持を告知する");
    assert.equal(await hasUnmergedWork({ mainWorkspace: ws, agentId: "delta" }), true, "hasUnmergedWork判定と整合");
  } finally { rmTree(ws); rmTree(root); }
});

test("createWorktree直呼び: マージ済みクリーンworktreeは従来どおりfreshに張り直す", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-wt-fresh-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const p1 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "eps" });
    await commitIn(p1, "done.txt", "done\n", "work-done");
    await runCommand({ command: `git merge --no-ff agent/eps -m "merge eps"`, cwd: ws, outputLimit: 500 });

    const kept = [];
    const p2 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "eps", onKept: (k) => kept.push(k) });
    assert.deepEqual(kept, [], "マージ済みは保持対象外(onKeptなし)");
    // マージ済みのファイルはmainの一部なのでfreshなworktreeにも存在する。
    // 検証すべきは「ブランチがmain位置で作り直された」こと。
    const bh = await runCommand({ command: `git rev-parse agent/eps main`, cwd: ws, outputLimit: 200 });
    const shas = bh.text.split("\n").filter((l) => /^[0-9a-f]{40}/.test(l.trim()));
    assert.equal(shas[0], shas[1], "再作成後のagent/epsはmainと同一位置(未マージコミットは無い)");
    assert.equal(await hasUnmergedWork({ mainWorkspace: ws, agentId: "eps" }), false, "hasUnmergedWork=false(作り直してよい)");
  } finally { rmTree(ws); rmTree(root); }
});

test("createWorktree直呼び: 未コミットの下書きはstash退避してから再作成する(イシュー#23)", async () => {
  // 直呼び経路でもremove --forceで下書きを無音に壊さない。退避はstash(push -uで
  // untracked含む)へ残るため、成果喪失ではなく退避+再作成が契約(イシュー#23)。
  const ws = mkdtempSync(join(tmpdir(), "hive-wt-dirty-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const p1 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "zeta" });
    writeFileSync(join(p1, "uncommitted.txt"), "dirty draft\n");
    writeFileSync(join(p1, "tracked.txt"), "modified draft\n"); // tracked変更(unstaged)も退避対象
    const kept = [];
    const p2 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "zeta", onKept: (k) => kept.push(k) });
    assert.equal(existsSync(join(p2, "uncommitted.txt")), false, "worktree自体はfreshに張り直す(退避済みのため文件は無い)");
    assert.equal(kept.length, 1, "onKeptで退避を告知");
    assert.match(kept[0].detail, /stash退避/, "退避の旨がdetailに入る");
    const sl = await runCommand({ command: `git stash list`, cwd: p2, outputLimit: 2000 });
    assert.match(sl.text, /hive-pre-recreate-zeta/, "stashに退避が残る(ブランチagent/zetaのstashとして復元可能)");
    assert.equal(await hasUnmergedWork({ mainWorkspace: ws, agentId: "zeta" }), false, "退避だけなら未マージコミット判定はfalse(再作成は正しい)");
  } finally { rmTree(ws); rmTree(root); }
});

test("再起動シナリオ: setupWorktreesが未マージを保持→respawnスキャンがタスク起票する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-wt-respawn-"));
  const root = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });

    // ラウンド1: 作業してコミットだけ残してプロセス死(マージされず)
    const p1 = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "eta" }] });
    await commitIn(p1.eta, "crash.txt", "lost work\n", "wip-crash");

    // ラウンド2(再起動): setupWorktrees(保持)→ respawnスキャン(runner起動シーケンスと同一順序)
    const kept = [];
    await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "eta" }], onKept: (k) => kept.push(k) });
    assert.deepEqual(kept.map((k) => k.agentId), ["eta"], "setupWorktreesが未マージを保持して告知");
    const bus = new Bus();
    const board = new Board(bus, "main");
    const tasks = new TaskBlackboard(ws, bus);
    const rr = await respawnUnfinishedWork({ mainWorkspace: ws, worktreeRoot: root, tasks, board, bus });
    assert.equal(rr.ok, true);
    assert.deepEqual(rr.respawned, ["eta"], "保持された未マージ作業がrespawn起票される");
    const t = tasks.list().open.find((x) => x.id.startsWith("respawn-eta-"));
    assert.ok(t, "respawn-eta-*タスクがopenに起票");
    assert.match(readFileSync(join(ws, "tasks", "open", t.id + ".md"), "utf8"), /worktrees\/eta|クラッシュ復旧/);
  } finally { rmTree(ws); rmTree(root); }
});
