// fix#28: worktree側のgit add/commit失敗(pre-commitフックのexit 1等)を無視して
// マージへ進めないこと。従来はコミット失敗が握り潰され、成果がmainへ入らないまま
// ok:true(マージ処理続行)になっていた。コミットに失敗したらok:false+理由で返り、
// mainへは何も取り込まれない。フック無しの通常フローは従来どおりok:true。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorktrees, mergeAgentWork } from "../src/engine/worktree.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { runCommand } from "../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }
async function gitCommitAll(cwd, msg) {
  const r = await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@local commit -m "${msg}"`, cwd, outputLimit: 1000 });
  assert.ok(r.ok, `git commit失敗: ${r.text.slice(0, 200)}`);
}

test("mergeAgentWork: pre-commitフック失敗時はok:falseでmainへ取り込まれない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-cf-"));
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] });

  // worktreeへpre-commitフック(exit 1)を設置 → add/commitが必ず失敗する
  writeFileSync(join(paths.alpha, "work.txt"), "worker output");
  const hooksDir = join(paths.alpha, ".git", "hooks");
  // worktreeの.gitはファイル(gitdir: ...参照)なので実フックディレクトリはmain側
  const gitFile = (await runCommand({ command: "cat .git", cwd: paths.alpha, outputLimit: 200 })).text;
  const realGitDir = gitFile.split("gitdir:")[1]?.trim() ?? hooksDir;
  writeFileSync(join(realGitDir, "pre-commit"), "exit 1\n");
  const chmod = await runCommand({ command: "git config core.hooksPath .githooks-fail && mkdir -p .githooks-fail", cwd: paths.alpha, outputLimit: 500 });
  // Windowsではフック実行にシェル互換が必要なため、core.hooksPath経由でもexit 1のスクリプトを置く
  const hookFallback = `echo ok > ${join(paths.alpha, ".githooks-fail", "pre-commit").replace(/\\/g, "/")} && echo exit 1 >> ${join(paths.alpha, ".githooks-fail", "pre-commit").replace(/\\/g, "/")}`;
  if (chmod.ok) await runCommand({ command: hookFallback, cwd: paths.alpha, outputLimit: 500 });

  const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.alpha, agent: { id: "alpha" }, taskId: "t-commit-fail" });
  try {
    assert.equal(m.ok, false, "コミット失敗なのにok:trueになった");
    assert.equal(m.commitFailed, true);
    assert.match(m.text, /コミットに失敗/);
    assert.match(m.text, /finish_task/);
    assert.equal(existsSync(join(ws, "work.txt")), false, "コミット失敗の成果がmainへ流入している");
  } finally {
    // フックを消してrmTreeが確実に通るようにする
    await runCommand({ command: "git config --unset core.hooksPath", cwd: paths.alpha, outputLimit: 500 });
    rmTree(ws); rmTree(root);
  }
});

test("mergeAgentWork: フック無しの通常フローは従来どおりok:trueでマージされる", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-cf-ok-"));
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "beta" }] });

  writeFileSync(join(paths.beta, "clean.txt"), "ok");
  const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.beta, agent: { id: "beta" }, taskId: "t-commit-ok" });
  assert.equal(m.ok, true, `通常マージが失敗: ${m.text.slice(0, 200)}`);
  assert.equal(m.merged, true);
  assert.equal(existsSync(join(ws, "clean.txt")), true, "クリーンな成果はmainへ入る");
  rmTree(ws); rmTree(root);
});
