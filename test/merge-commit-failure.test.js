// イシュー#28: pre-commitフックがexit 1するとworktree側のコミットが空振りしても
// mergeAgentWorkが{ok:true, merged:false}を返し、成果がmainに入らないまま成功扱いになっていた。
// ステップ1分解により commit失敗をok:false+理由で返し、フック無しは従来どおり成功すること。
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

const LF = String.fromCharCode(10);

async function mkEnv(hook) {
  const base = mkdtempSync(join(tmpdir(), "hive-mergefail-"));
  const ws = join(base, "main");
  const wtRoot = join(base, "wts");
  mkdirSync(ws, { recursive: true });
  await ensureGitRepo(ws);
  writeFileSync(join(ws, "base.txt"), "base" + LF);
  GIT("git add -A && git commit -qm base", ws);
  const wt = join(wtRoot, "alpha");
  mkdirSync(wtRoot, { recursive: true });
  GIT('git worktree add -q -b agent/alpha "' + wt + '" main', ws);
  GIT("git config user.email w@t && git config user.name w", wt);
  if (hook) {
    // フックは共通gitdir(main側 .git/hooks)に置く(worktreeのコミットも共通フックを参照)。
    // 実装経路と同じrunCommand経由ではなくexecSyncで直接書き、実行可能権限はWindowsでも付与不要(sh経由起動)。
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    writeFileSync(join(ws, ".git", "hooks", "pre-commit"), "#!/bin/sh" + LF + "exit 1" + LF);
  }
  return { base, ws, wt };
}

test("mergeAgentWork: pre-commitフック失敗時はok:falseでmainに成果が入らない", async () => {
  const { base, ws, wt } = await mkEnv(true);
  try {
    writeFileSync(join(wt, "work.txt"), "uncommitted" + LF);
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
    writeFileSync(join(wt, "work.txt"), "merged" + LF);
    const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha", displayName: "α" }, taskId: "t28" });
    assert.equal(r.ok, true, "フック無しはok:true: " + String(r.text ?? "").slice(0, 80));
    assert.equal(r.merged, true);
    assert.equal(GIT("git show main:work.txt", ws).trim(), "merged", "成果がmainへ入る");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});
