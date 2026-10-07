// fix-28回帰(pre-commitフック失敗の黙殺を防ぐ): mergeAgentWorkのステップ1(git add/commit)を
// 個別検査し、pre-commitフックexit 1等でコミットが空振りしたら ok:false+理由を返してmainへ
// 成果が入らないことを保証する。フック無しは従来どおりok:true(マージされる)。
// 実git(mkdtempSync隔離リポジトリ)+実フックで3面を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { mergeAgentWork, createWorktree } from "../src/engine/worktree.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

const GIT = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
const SH = String.fromCharCode(35) + "!/bin/sh"; // POSIXシバン(Windows Git Bash環境でも動く)
const NL = String.fromCharCode(10);

// main(worktree親)→子worktree(agent/alpha)を準備
function initRepos(base) {
  const main = join(base, "main");
  const wtRoot = join(base, "wts");
  mkdirSync(main, { recursive: true });
  GIT("git init -q -b main", main);
  GIT("git config user.email t@t && git config user.name t", main);
  writeFileSync(join(main, "package.json"), '{"name":"x"}' + NL);
  GIT("git add -A && git commit -qm init", main);
  mkdirSync(wtRoot, { recursive: true });
  return { main, wtRoot };
}

test("fix-28: pre-commitフックexit 1のworktreeではok:false+理由、mainに成果は入らない", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-fix28-"));
  try {
    const { main, wtRoot } = initRepos(base);
    const wt = await import("../src/engine/worktree.js").then((m) =>
      m.createWorktree({ mainWorkspace: main, worktreeRoot: wtRoot, agentId: "alpha" })
    );
    // 失敗するpre-commitフックを設置(linked worktreeの.gitはファイルなのでmain側の共通hooksへ)
    mkdirSync(join(main, ".git", "hooks"), { recursive: true });
    writeFileSync(join(main, ".git", "hooks", "pre-commit"), SH + NL + "exit 1" + NL);
    chmodSync(join(main, ".git", "hooks", "pre-commit"), 0o755);
    // 未コミット変更を作る(ステージ差分あり=コミットを試みる状態)
    writeFileSync(join(wt, "work.txt"), "worker output" + NL);
    const m = await mergeAgentWork({ mainWorkspace: main, worktreePath: wt, agent: { id: "alpha" }, taskId: "fix28a" });
    assert.equal(m.ok, false, "フック失敗時はok:false: " + String(m.text ?? "").slice(0, 80));
    assert.match(m.text, /コミットに失敗/);
    // 成果がmainに入っていないこと
    const mainFiles = GIT("git ls-files", main);
    assert.ok(!mainFiles.includes("work.txt"), "mainに成果が漏れていない");
    assert.ok(!/work\.txt/.test(GIT("git log --oneline -3", main)), "mainログに新規コミットが無い");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});

test("fix-28: フック無しは従来どおりok:trueで未コミット変更がmainへマージされる", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-fix28-"));
  try {
    const { main, wtRoot } = initRepos(base);
    const wt = await import("../src/engine/worktree.js").then((m) =>
      m.createWorktree({ mainWorkspace: main, worktreeRoot: wtRoot, agentId: "alpha" })
    );
    writeFileSync(join(wt, "work.txt"), "worker output" + NL);
    const m = await mergeAgentWork({ mainWorkspace: main, worktreePath: wt, agent: { id: "alpha" }, taskId: "fix28b" });
    assert.equal(m.ok, true, "フック無しはok:true: " + String(m.text ?? "").slice(0, 80));
    assert.equal(m.merged, true, "新たに取り込まれる");
    const mainFiles = GIT("git ls-files", main);
    assert.ok(mainFiles.includes("work.txt"), "mainに成果が入る");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});

test("fix-28: 変更無し(no-op)はフックがあっても実行されずok:true、フック実行痕跡が残らない", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-fix28-"));
  try {
    const { main, wtRoot } = initRepos(base);
    const wt = await import("../src/engine/worktree.js").then((m) =>
      m.createWorktree({ mainWorkspace: main, worktreeRoot: wtRoot, agentId: "alpha" })
    );
    // 失敗フックを置くが、未コミット変更は無い(staged差分ゼロ→コミット自体が走らない)。
    // linked worktreeの.gitはファイルなのでmain側の共通hooksへ置く
    mkdirSync(join(main, ".git", "hooks"), { recursive: true });
    writeFileSync(join(main, ".git", "hooks", "pre-commit"), SH + NL + "touch " + join(wt, "hook-ran") + NL);
    chmodSync(join(main, ".git", "hooks", "pre-commit"), 0o755);
    const m = await mergeAgentWork({ mainWorkspace: main, worktreePath: wt, agent: { id: "alpha" }, taskId: "fix28c" });
    assert.equal(m.ok, true, "no-opは成功扱い: " + String(m.text ?? "").slice(0, 80));
    assert.ok(!existsSync(join(wt, "hook-ran")), "フックが実行されていない(コミットを試みていない)");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});

// end-to-end面: finish_task経由でもフック失敗がエラー伝播すること(tools.jsの!m.ok経路)
// approvals無効(mainWorkspace指定のみ)なのでfinish_taskは直接マージを試みる
test("fix-28: finish_taskでフック失敗がエラーとして伝播する(tools.js経路)", async () => {
  const base = mkdtempSync(join(tmpdir(), "hive-fix28-"));
  try {
    const { main, wtRoot } = initRepos(base);
    const wt = await createWorktree({ mainWorkspace: main, worktreeRoot: wtRoot, agentId: "alpha" });
    mkdirSync(join(main, ".git", "hooks"), { recursive: true });
    writeFileSync(join(main, ".git", "hooks", "pre-commit"), SH + NL + "exit 1" + NL);
    chmodSync(join(main, ".git", "hooks", "pre-commit"), 0o755);
    writeFileSync(join(wt, "work.txt"), "worker output" + NL);
    const bus = new Bus();
    const tasks = new TaskBlackboard(wt, bus);
    const posted = [];
    const tools = createTools({
      agent: { id: "alpha", displayName: "実装係", role: "impl", personaText: "# a" },
      workspace: wt, mainWorkspace: main,
      board: { post(role, text) { posted.push(text); }, on() { return () => {}; } },
      tasks, bus,
    });
    tasks.create({ id: "f28", role: "impl", body: "work" });
    const c = await tools.execute("claim_next_task", {});
    assert.ok(c.ok, "claimできる");
    const f = await tools.execute("finish_task", { task_id: "f28" });
    assert.equal(f.ok, false, "フック失敗はok:falseで伝播: " + String(f.text ?? "").slice(0, 80));
    assert.match(f.text, /マージに失敗しました[\s\S]*コミットに失敗|コミットに失敗/);
    // タスクは完了扱いになっていない(成果が無いのにdoneにしない)
    assert.ok(!tasks.list().done.some((t) => t.id === "f28"), "タスクはdoneになっていない");
    assert.ok(!GIT("git ls-files", main).includes("work.txt"), "mainに成果が漏れていない");
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ロック無視 */ }
  }
});
