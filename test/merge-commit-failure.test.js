// イシュー#28: pre-commitフックがexit 1するとworktree側のコミットが空振りしても
// mergeAgentWorkが成功扱いになり、成果がmainに入らないままokが返っていた。
// ステップ分解により commit失敗をok:false+理由で返し、フック無しは従来どおり成功すること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { mergeAgentWork } from "../src/engine/worktree.js";
import { ensureGitRepo } from "../src/engine/discover.js";

function GIT(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

async function mkEnv(hook) {
  const base = mkdtempSync(join(tmpdir(), "hive-mergefail-"));
  const ws = join(base, "main");
  const wtRoot = join(base, "wts");
  mkdirSync(ws, { recursive: true });
  await ensureGitRepo(ws);
  writeFileSync(join(ws, "base.txt"), "base" + String.fromCharCode(10));
  GIT("git add -A && git commit -qm base", ws);
  const wt = join(wtRoot, "alpha");
  mkdirSync(wtRoot, { recursive: true });
  GIT("git worktree add -q -b agent/alpha \"" + wt + "\" main", ws);
  GIT("git config user.email w@t && git config user.name w", wt);
  if (hook) {
    mkdirSync(join(wt, ".git"), { recursive: true });
    // worktreeの.gitはファイル(gitdir:ポインタ)なので実リポジトリ側のhooksへ置く
    const gitDir = GIT("git rev-parse --git-dir", wt).trim();
    const abs = gitDir.includes(":") || gitDir.startsWith("/") ? gitDir : join(ws, gitDir);
    writeFileSync(join(abs, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
  }
  return { base, ws, wt };
}

test("mergeAgentWork: pre-commitフック失敗時はok:falseでmainに成果が入らない", async () => {
  const { base, ws, wt } = await mkEnv(true);
  try {
    writeFileSync(join(wt, "work.txt"), "uncommitted" + String.fromCharCode(10));
    const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha", displayName: "α" }, taskId: "t28" });
    assert.equal(r.ok, false, "フック失敗はok:false: " + String(r.text ?? "").slice(0, 80));
    assert.match(r.text, /コミットに失敗/);
    let inMain = false;
    try { GIT("git cat-file -e main:work.txt", ws); inMain = true; } catch { /* 無いのが正 */ }
    assert.equal(inMain, false, "成果はmainへ入らない");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});

test("mergeAgentWork: フック無しは従来どおりok:trueでマージされる", async () => {
  const { base, ws, wt } = await mkEnv(false);
  try {
    writeFileSync(join(wt, "work.txt"), "merged" + String.fromCharCode(10));
    const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha", displayName: "α" }, taskId: "t28" });
    assert.equal(r.ok, true, "フック無しはok:true: " + String(r.text ?? "").slice(0, 80));
    assert.equal(r.merged, true);
    assert.equal(GIT("git show main:work.txt", ws).trim(), "merged", "成果がmainへ入る");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});
