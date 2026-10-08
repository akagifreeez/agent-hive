// /api/wtdiff?agent=<id>: worktree(agent/<id>ブランチ)とmainの差分APIの検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorktrees } from "../src/engine/worktree.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { handleWtdiff } from "../src/ui/server.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function makeFixture() {
  const ws = mkdtempSync(join(tmpdir(), "hive-wtdiff-"));
  await ensureGitRepo(ws);
  writeFileSync(join(ws, "base.txt"), "base\n");
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] });
  // alphaのworktreeでコミットを作る
  writeFileSync(join(paths.alpha, "feature.txt"), "new feature line\n");
  const { runCommand } = await import("../src/engine/exec.js");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -q -m add-feature", cwd: paths.alpha, outputLimit: 500 });
  return { ws, root, paths, close: () => { rmTree(ws); rmTree(root); } };
}

test("wtdiff: statとpatchが返る", async () => {
  const fx = await makeFixture();
  try {
    const r = await handleWtdiff({ mainWorkspace: fx.ws, worktreeRoot: fx.root, agentId: "alpha" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.stat, /feature\.txt/);
    assert.match(r.body.patch, /new feature line/);
  } finally { fx.close(); }
});

test("wtdiff: 出力上限で打ち切られる(truncated=true)", async () => {
  const fx = await makeFixture();
  try {
    // 上限(20KB)を超える巨大差分を作る
    const big = "x".repeat(30 * 1024);
    writeFileSync(join(fx.paths.alpha, "big.txt"), big);
    const { runCommand } = await import("../src/engine/exec.js");
    await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -q -m big", cwd: fx.paths.alpha, outputLimit: 500 });
    const r = await handleWtdiff({ mainWorkspace: fx.ws, worktreeRoot: fx.root, agentId: "alpha", limit: 1024 });
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, true);
    assert.ok(r.body.patch.length <= 1024 + 200); // 打ち切り告知分の余裕
  } finally { fx.close(); }
});

test("wtdiff: agent指定が無い/不正な場合は400", async () => {
  const missing = await handleWtdiff({ mainWorkspace: "x", worktreeRoot: "y", agentId: null });
  assert.equal(missing.status, 400);
  const bad = await handleWtdiff({ mainWorkspace: "x", worktreeRoot: "y", agentId: "../evil" });
  assert.equal(bad.status, 400);
  // 存在しないworktreeも400
  const ws = mkdtempSync(join(tmpdir(), "hive-wtdiff2-"));
  try {
    const noWt = await handleWtdiff({ mainWorkspace: ws, worktreeRoot: join(ws, "nope"), agentId: "ghost" });
    assert.equal(noWt.status, 400);
  } finally { rmTree(ws); }
});