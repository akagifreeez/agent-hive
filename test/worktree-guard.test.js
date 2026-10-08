import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAgentWork } from "../src/engine/worktree.js";

test("mergeAgentWork: 作業フォルダー未設定では現在のフォルダーでgitを実行しない", async () => {
  for (const paths of [
    { mainWorkspace: "/main" },
    { mainWorkspace: "/main", worktreePath: "" },
    { mainWorkspace: "/main", worktreePath: "   " },
    { mainWorkspace: "", worktreePath: "/worker" },
  ]) {
    const calls = [];
    const result = await mergeAgentWork({
      ...paths, agent: { id: "alpha" }, taskId: "chat-round",
      exec: async (args) => { calls.push(args); return { ok: false, text: "exit=1\n" }; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0, "フォルダーが未設定ならgitを実行しない");
    assert.match(result.text, /未設定/);
  }
});

// #28: pre-commitフック等でコミットが空振りしてもmergeAgentWorkが成功扱いにしない。
// 従来は `git add -A && (... || commit)` を1コマンドに潰していたため、commit失敗が
// 見えず {ok:true, merged:false} になり、成果がmainに入らないまま完了扱いになった
// (ボード#168で実害再現)。
test("mergeAgentWork: コミット失敗(pre-commitフック等)はok:falseでmainに成果が入らない", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureGitRepo } = await import("../src/engine/discover.js");
  const { runCommand } = await import("../src/engine/exec.js");
  const { createWorktree } = await import("../src/engine/worktree.js");
  const ws = mkdtempSync(join(tmpdir(), "hive-mrg-hook-"));
  const root = `${ws}-wt`;
  const rmTree = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } };
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const wt = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "alpha" });
    // pre-commitフックが必ず失敗するworktreeを作る
    const hookOk = await runCommand({
      command: `printf '#!/bin/sh\\nexit 1\\n' > .git/hooks/pre-commit`,
      cwd: ws,
      outputLimit: 500,
    });
    assert.ok(hookOk.ok, "フック設置に成功する: " + hookOk.text.slice(0, 100));

    // (1) 未コミット変更あり → ok:false、理由にコミット失敗、mainに成果が無い
    writeFileSync(join(wt, "work.txt"), "should not merge\n");
    const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t28" });
    assert.equal(r.ok, false, "ok:falseを返す: " + (r.text ?? "").slice(0, 120));
    assert.match(r.text, /コミットに失敗/);
    const onMain = await runCommand({ command: `git show main:work.txt`, cwd: ws, outputLimit: 300 });
    assert.equal(onMain.ok, false, "mainに成果が入っていない");

    // (2) フックを外せば従来どおり成功する(同一環境でリカバリ可能)
    await runCommand({ command: `rm -f .git/hooks/pre-commit`, cwd: ws, outputLimit: 300 });
    const r2 = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t28" });
    assert.equal(r2.ok, true, "フック撤去後はok:true: " + (r2.text ?? "").slice(0, 120));
    const merged = await runCommand({ command: `git show main:work.txt`, cwd: ws, outputLimit: 300 });
    assert.ok(merged.ok && /should not merge/.test(merged.text), "フック無しはマージされる");
  } finally { rmTree(ws); rmTree(root); }
});

test("mergeAgentWork: 変更なし(no-op)はフックがあっても従来どおり成功扱い", async () => {
  // no-op(diff --cached --quiet)はコミットを試みないため、フック失敗と無関係
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureGitRepo } = await import("../src/engine/discover.js");
  const { runCommand } = await import("../src/engine/exec.js");
  const { createWorktree } = await import("../src/engine/worktree.js");
  const ws = mkdtempSync(join(tmpdir(), "hive-mrg-noop-"));
  const root = `${ws}-wt`;
  const rmTree = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } };
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: ws, outputLimit: 500 });
    const wt = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "beta" });
    await runCommand({ command: `printf '#!/bin/sh\\nexit 1\\n' > .git/hooks/pre-commit`, cwd: ws, outputLimit: 500 });
    const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "beta" }, taskId: "t28-noop" });
    assert.equal(r.ok, true, "no-opは成功扱い: " + (r.text ?? "").slice(0, 120));
    assert.equal(r.merged, false, "取り込む差分は無い");
  } finally { rmTree(ws); rmTree(root); }
});
