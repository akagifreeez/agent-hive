// 検証の軽量化(isImplMergedIntoMain)のテスト。
// 実装ブランチHEADがmainの先祖なら差分ゼロ=軽量検証可と判定することを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isImplMergedIntoMain } from "../src/engine/tools.js";

import { execFileSync } from "node:child_process";
function git2(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hive-fastpath-"));
  git2(dir, ["init", "-q", "-b", "main"]);
  git2(dir, ["config", "user.email", "t@t"]);
  git2(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "1");
  git2(dir, ["add", "."]);
  git2(dir, ["commit", "-qm", "init"]);
  return dir;
}

test("軽量検証判定: HEADがmainに含まれるならtrue、先コミットならfalse", async () => {
  const repo = mkRepo();
  try {
    // mainと同じ位置のブランチ=反映済み扱い
    git2(repo, ["checkout", "-q", "-b", "b-merged"]);
    const merged = await isImplMergedIntoMain({ mainWorkspace: repo, worktreePath: repo });
    assert.equal(merged, true, "同位置ブランチは反映済み");

    // ブランチ側にだけ新コミット=未反映
    writeFileSync(join(repo, "b.txt"), "2");
    git2(repo, ["add", "."]);
    git2(repo, ["commit", "-qm", "branch only"]);
    const notMerged = await isImplMergedIntoMain({ mainWorkspace: repo, worktreePath: repo });
    assert.equal(notMerged, false, "先コミットは未反映");

    // mainへマージしたら反映済みに戻る
    git2(repo, ["checkout", "-q", "main"]);
    git2(repo, ["merge", "-q", "--no-edit", "b-merged"]);
    const afterMerge = await isImplMergedIntoMain({ mainWorkspace: repo, worktreePath: repo });
    assert.equal(afterMerge, true, "マージ後は反映済み");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("軽量検証判定: リポジトリでない場所ではfalse(git不備の安全側)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-fastpath-ng-"));
  try {
    const r = await isImplMergedIntoMain({ mainWorkspace: dir, worktreePath: dir });
    assert.equal(r, false, "git不備時はfalse");
    assert.equal(await isImplMergedIntoMain({ mainWorkspace: null, worktreePath: dir }), false, "main無しはfalse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
