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
