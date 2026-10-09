// 競合マーカーガード: mainやworktree側の変更にマーカーが入ったままマージすると
// main全体が構文破損する(r7で実際に発生)。マージ前検査で1件だけ拒否することを検証する。
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
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@local commit -m "${msg}"`, cwd, outputLimit: 1000 });
}

const MARKER_FILE = "broken.js";
const MARKER_BODY = "const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> main\n";

test("main汚染: mainにマーカーがあるときはマージを拒否する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mg-"));
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] });

  // mainを汚染して確定
  writeFileSync(join(ws, MARKER_FILE), MARKER_BODY);
  await gitCommitAll(ws, "contaminate main");

  // worktree側はクリーンな変更
  writeFileSync(join(paths.alpha, "clean.txt"), "ok");
  const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.alpha, agent: { id: "alpha" }, taskId: "t-main-guard" });
  assert.equal(m.ok, false);
  assert.equal(m.marker, true);
  assert.match(m.text, /mainに競合マーカー/);
  assert.equal(existsSync(join(ws, "clean.txt")), false, "クリーンな変更は取り込まれない");
  rmTree(ws); rmTree(root);
});

test("worktree汚染: ブランチ側の変更にマーカーがあるときはマージを拒否して作業者へ返す", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mg-"));
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "beta" }] });

  // worktree側だけ汚す(mainはクリーン)
  writeFileSync(join(paths.beta, MARKER_FILE), MARKER_BODY);
  const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.beta, agent: { id: "beta" }, taskId: "t-wt-guard" });
  assert.equal(m.ok, false);
  assert.equal(m.marker, true);
  assert.match(m.text, /worktree側の変更に競合マーカー/);
  assert.match(m.text, /finish_task/);
  assert.equal(existsSync(join(ws, MARKER_FILE)), false, "汚染ファイルはmainに入らない");
  rmTree(ws); rmTree(root);
});

test("1.5ガード診断: 拒否ログにマージベースSHAと差分一覧が出る", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mg-"));
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "gamma" }] });

  // worktree側だけ汚して確定
  writeFileSync(join(paths.gamma, MARKER_FILE), MARKER_BODY);
  await gitCommitAll(paths.gamma, "contaminate branch");

  // マージベース(main側HEAD)を先に控える — これが診断に出るべきSHA
  const pre = await runCommand({ command: "git rev-parse main", cwd: ws, outputLimit: 200 });
  const expectedBase = pre.text.split("\n")[1].trim();

  const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.gamma, agent: { id: "gamma" }, taskId: "t-diag" });
  assert.equal(m.ok, false);
  assert.equal(m.marker, true);
  // 診断: マージベースSHA
  assert.match(m.text, new RegExp(`merge-base=${expectedBase}`), "診断にマージベースSHAが含まれる");
  // 診断: 3ドット相当の差分一覧(broken.jsが運ばれるファイルとして挙がる)
  assert.match(m.text, /diff一覧\([^)]*agent\/gamma\): .*broken\.js/, "診断に差分一覧が含まれる");
  assert.match(m.text, /broken\.js/, "差分一覧にマーカー入りファイルが出る");
  // 診断: grep対象
  assert.match(m.text, /grep対象/, "診断にgrep対象が含まれる");
  rmTree(ws); rmTree(root);
});

test("1.5ガード排他: マージ中のmain参照移動をガードdiffが拾わない(SHA固定の根拠)", async () => {
  // コード読解根拠: worktree.js mergeAgentWorkはqueueMerge(=withMergeLockのpromiseミューテックス)
  // で全体が直列化され、ガードdiff(diffBase固定。L188-192)はmerge-base SHAを1回だけ読んで
  // `git diff --name-only <sha> agent/<id>` とする。`main...`リビジョン式(実行時main再読み替え)
  // を使わないため、マージ中に他ブランチのマージでmain参照が移動してもdiff集合は不変=混入しない。
  // ここでは排他プリミティブの性質(逐次実行)を実動作で確認する。
  const { withMergeLock } = await import("../src/engine/worktree.js");
  const order = [];
  const t1 = withMergeLock(async () => { order.push("A1"); await new Promise((r) => setTimeout(r, 30)); order.push("A2"); });
  const t2 = withMergeLock(async () => { order.push("B1"); });
  await Promise.all([t1, t2]);
  assert.deepEqual(order, ["A1", "A2", "B1"], "ロック内処理は並走せず直列に走る");
});
