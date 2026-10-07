// ブランチ漂流ガード(self-improve-lab-lessons・最重要)の受け入れテスト。
// 本番実害(2026-10-07朝): mainワークスペースのチェックアウトがagent/...-verifyへ漂流し、
// finish_taskのマージがagentブランチへ47コミット滞留。さらに中断マージ(MERGE_HEAD+競合
// マーカー)が残ってconfig.js構文エラー→起動不能に至った。
// 固定する振る舞い:
//   (1) ensureMainCheckout: 漂流を検出して安全にmainへ復帰(MERGE_HEAD残存なら先にabort、
//       未コミット変更があるときは捨てずに中止して理由を返す)
//   (2) mergeAgentWork: 漂流状態でも復帰してからマージする(成果がagentブランチへ滞留しない)
//   (3) runScenario起動時: 漂流を検出してボードへ警告し、復帰してから走行する
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMainCheckout } from "../src/engine/branch-guard.js";
import { mergeAgentWork, setupWorktrees } from "../src/engine/worktree.js";
import { runScenario } from "../src/runner.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { Board, Bus } from "../src/engine/board.js";
import { runCommand } from "../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function git(cmd, cwd) {
  return runCommand({ command: cmd, cwd, outputLimit: 2000 });
}
async function commitAll(cwd, msg) {
  await git("git add -A", cwd);
  await git(`git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd);
}
/** 現在ブランチ名 */
async function currentBranch(cwd) {
  const r = await git("git rev-parse --abbrev-ref HEAD", cwd);
  return (r.text.split("\n")[1] ?? "").trim();
}

test("ensureMainCheckout: 漂流(クリーン)を検出してmainへ復帰する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-drift-clean-"));
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "a.txt"), "1\n");
    await commitAll(ws, "base");
    await git("git checkout -q -b agent/ghost", ws);
    assert.equal(await currentBranch(ws), "agent/ghost", "準備: 漂流状態");
    const r = await ensureMainCheckout({ mainWorkspace: ws });
    assert.equal(r.ok, true, "クリーンな漂流は自動復帰できる");
    assert.equal(await currentBranch(ws), "main", "mainへ復帰している");
    assert.equal(r.branch, "main");
  } finally {
    rmTree(ws);
  }
});

test("ensureMainCheckout: 漂流+中断マージ(MERGE_HEAD残存)をabortしてmainへ復帰する(本番実害の再現)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-drift-mergehead-"));
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "c.txt"), "base\n");
    await commitAll(ws, "base");
    // 漂流ブランチ側でc.txtを変更
    await git("git checkout -q -b agent/ghost", ws);
    writeFileSync(join(ws, "c.txt"), "drift\n");
    await commitAll(ws, "drift-change");
    // main側もc.txtを変更(競合する形にする)
    await git("git checkout -q main", ws);
    writeFileSync(join(ws, "c.txt"), "mainline\n");
    await commitAll(ws, "main-change");
    // 漂流ブランチへ戻り、mainをマージして競合を未解決のまま放置(=本番の中断マージ状態)
    await git("git checkout -q agent/ghost", ws);
    const m = await git("git merge main", ws);
    assert.equal(m.ok, false, "準備: 競合が発生する");
    const mh = await git("git rev-parse -q --verify MERGE_HEAD", ws);
    assert.ok(mh.ok, "準備: MERGE_HEADが残存している");
    assert.equal(await currentBranch(ws), "agent/ghost");

    const r = await ensureMainCheckout({ mainWorkspace: ws });
    assert.equal(r.ok, true, "中断マージはabortで解消して復帰できる");
    assert.equal(r.abort, true, "abortが実行されたことを示す");
    assert.equal(await currentBranch(ws), "main", "mainへ復帰している");
    const mh2 = await git("git rev-parse -q --verify MERGE_HEAD", ws);
    assert.ok(!mh2.ok, "MERGE_HEADが解消されている");
    // 作業ファイルが壊れていない(競合マーカーが残らない)
    assert.ok(!readFileSync(join(ws, "c.txt"), "utf8").includes("<<<<<<<"), "abortで競合マーカーが持ち越されない");
  } finally {
    rmTree(ws);
  }
});

test("ensureMainCheckout: 未コミット変更がある漂流は勝手に復帰せず中止(理由を返す)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-drift-dirty-"));
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "a.txt"), "1\n");
    await commitAll(ws, "base");
    await git("git checkout -q -b agent/ghost", ws);
    writeFileSync(join(ws, "unsaved.txt"), "きちんと確認すべき作業中ファイル\n");
    const r = await ensureMainCheckout({ mainWorkspace: ws });
    assert.equal(r.ok, false, "勝手に消さないため復帰しない");
    assert.ok(String(r.reason).includes("agent/ghost"), "理由に漂流先ブランチが含まれる");
    assert.equal(await currentBranch(ws), "agent/ghost", "状態を壊していない");
    assert.ok(readFileSync(join(ws, "unsaved.txt"), "utf8").length > 0, "未コミット変更が保持されている");
  } finally {
    rmTree(ws);
  }
});

test("mergeAgentWork: 漂流したmainワークスペースでも復帰してからマージする(成果の滞留防止)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-drift-mergework-"));
  const wtRoot = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await commitAll(ws, "base");
    const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: wtRoot, agents: [{ id: "alpha" }] });
    // alphaのworktreeに成果をコミット
    writeFileSync(join(paths.alpha, "feature.txt"), "work\n");
    await commitAll(paths.alpha, "alpha-work");
    // mainワークスペースをagent/ghostへ漂流させる(クリーンな状態で)
    await git("git checkout -q -b agent/ghost", ws);
    assert.equal(await currentBranch(ws), "agent/ghost", "準備: 漂流状態");

    const m = await mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.alpha, agent: { id: "alpha", displayName: "alpha" }, taskId: "drift-1" });
    assert.equal(m.ok, true, `漂流復帰つきマージが成功する: ${m.text?.slice(0, 200)}`);
    assert.equal(await currentBranch(ws), "main", "マージ後にmainにいる");
    const log = await git("git log --oneline -2 main", ws);
    assert.ok(log.text.includes("merge: drift-1 by alpha"), "成果がmainへ入っている(滞留しない)");
    const f = await git("git show main:feature.txt", ws);
    assert.ok(f.ok, "成果ファイルがmainに存在する");
  } finally {
    rmTree(ws);
    rmTree(wtRoot);
  }
});

test("runScenario起動時: 漂流を検出してボードへ警告し、復帰してから走行する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-drift-scenario-"));
  const wtRoot = `${ws}-wt`;
  try {
    await ensureGitRepo(ws);
    writeFileSync(join(ws, "base.txt"), "base\n");
    await commitAll(ws, "base");
    await git("git checkout -q -b agent/ghost", ws);
    assert.equal(await currentBranch(ws), "agent/ghost", "準備: 漂流状態");

    const PERSONA = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "agents", "alpha.md");
    const config = {
      workspace: ws,
      worktrees: { dir: wtRoot },
      agents: [{ id: "alpha", displayName: "alpha", role: "impl", personaPath: PERSONA }],
      loop: { maxTurns: 4 },
      runner: { timeoutSec: 30 },
      discovery: { probes: { tests: "off" } },
      exec: { testMaxConcurrent: 1 },
      permissions: {},
      scenario: { name: "drift-check", seedFiles: [], tasks: [] },
    };
    const bus = new Bus();
    const warns = [];
    bus.on("scenario.warn", (e) => warns.push(String(e.message ?? "")));
    const modelFactory = () => ({ async chat() { return { content: null, toolCalls: [], raw: { role: "assistant", content: null } }; } });
    const snapshot = await runScenario({ config, modelFactory, bus });

    const driftPost = snapshot.board.find((p) => String(p.text ?? "").includes("[ブランチ漂流]"));
    assert.ok(driftPost, `起動時にボードへ漂流警告が投稿される(警告系: ${warns.join(" / ").slice(0, 300) || "なし"})`);
    assert.ok(driftPost.text.includes("agent/ghost"), "警告に漂流先ブランチが含まれる");
    assert.equal(await currentBranch(ws), "main", "起動時にmainへ復帰している");
    assert.ok(warns.some((w) => w.includes("ブランチ漂流")), "scenario.warnでも通知される");
  } finally {
    rmTree(ws);
    rmTree(wtRoot);
  }
});
