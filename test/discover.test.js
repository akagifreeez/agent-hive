// v2: 発見器(テスト→タスク化・diff→レビュー化)と承認制ゲートの検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";

function rmTree(p) { try { rmTree(p); } catch { /* Windowsのファイルロックは無視 */ } }
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { PermissionGate } from "../src/engine/permissions.js";
import { startDiscovery, ensureGitRepo } from "../src/engine/discover.js";

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "hive-v2-"));
}

function makeEnv(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { bus, board, tasks };
}

test("テスト失敗→fixタスク生成、テスト復旧→自動解決", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  let fail = true;
  const fakeExec = async () => (fail ? { ok: false, text: "exit=1\n... 3 tests, 2 failures ..." } : { ok: true, text: "exit=0\n... all pass ..." });
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: "node --test tests/", exec: fakeExec });

  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("fix-test-failures"), true);
  const body = readFileSync(join(ws, "tasks", "open", "fix-test-failures.md"), "utf8");
  assert.match(body, /テストが失敗している/);
  assert.match(body, /2 failures/);

  fail = false;
  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("fix-test-failures"), false);
  assert.ok(tasks.snapshot().done.some((f) => f.includes("fix-test-failures")));
  d.stop();
  rmTree(ws);
});

test("既にfixタスクがある間は二重生成しない", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  const fakeExec = async () => ({ ok: false, text: "exit=1\nfail" });
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: "node --test tests/", exec: fakeExec });
  await d.tick();
  await d.tick();
  const open = tasks.snapshot().open.filter((f) => f === "fix-test-failures.md");
  assert.equal(open.length, 1);
  d.stop();
  rmTree(ws);
});

test("diff検出(reviewed..main)→reviewタスク生成、レビュー完了→タグ前進", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  await ensureGitRepo(ws);
  const { writeFileSync: wf } = await import("node:fs");
  const { runCommand } = await import("../src/engine/exec.js");
  wf(join(ws, "src.txt"), "成果物");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -m 'feature'", cwd: ws, outputLimit: 1000 });
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: null });

  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("review-changes"), true);
  const body = readFileSync(join(ws, "tasks", "open", "review-changes.md"), "utf8");
  assert.match(body, /src\.txt/);

  // ベータが請求して完了した想定 → reviewedタグがmainまで前進する
  tasks.claim({ id: "beta", role: "review" });
  const claimed = tasks.snapshot().claimed.find((f) => f.includes("review-changes"));
  assert.ok(claimed);
  const id = claimed.replace(/\.md$/, "").split("--").slice(1).join("--");
  tasks.finish({ id: "beta" }, id);
  // タグ移動は非同期。高負荷でもフレークしないよう一致するまでポーリングする
  let tag = null;
  let main = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    tag = await runCommand({ command: "git rev-parse reviewed", cwd: ws, outputLimit: 500 });
    main = await runCommand({ command: "git rev-parse main", cwd: ws, outputLimit: 500 });
    if (tag.ok && main.ok && tag.text.trim() === main.text.trim()) break;
  }
  assert.equal(tag.text.trim(), main.text.trim());
  d.stop();
  rmTree(ws);
});

test("impl等の通常タスクが残っている間はテスト失敗を仕事化しない", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  tasks.seed([{ id: "impl-something", role: "impl", body: "作業中" }]);
  const fakeExec = async () => ({ ok: false, text: "exit=1\nfail" });
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: "node --test tests/", exec: fakeExec });
  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("fix-test-failures"), false);
  assert.equal(tasks.existsOpenOrClaimed("impl-something"), true);
  d.stop();
  rmTree(ws);
});

test("承認制ゲート: denyは即拒否、askは承認で通る、拒否/タイムアウトでは遮る", async () => {
  const bus = new Bus();
  const gate = new PermissionGate({ bus, deny: ["shutdown"], ask: ["rm -rf"], askTimeoutSec: 5 });

  const denied = await gate.check("shutdown /s");
  assert.equal(denied.allowed, false);

  const askP = gate.check("rm -rf tmp/x");
  // 承認が来る前は未決
  let settled = false;
  void askP.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false);
  bus.emit("permission.verdict", { id: 1, approve: true });
  assert.equal((await askP).allowed, true);

  const askP2 = gate.check("rm -rf tmp/y");
  bus.emit("permission.verdict", { id: 2, approve: false });
  assert.equal((await askP2).allowed, false);
});

test("bashツールはゲートを通り、拒否時はok:falseで理由を返す", async () => {
  const ws = makeWorkspace();
  const { bus, board, tasks } = makeEnv(ws);
  const { createTools } = await import("../src/engine/tools.js");
  const gate = new PermissionGate({ bus, deny: ["git push"], ask: [] });
  const tools = createTools({ agent: { id: "alpha" }, workspace: ws, board, tasks, bus, gate });
  const out = await tools.execute("bash", { command: "echo ok" });
  assert.equal(out.ok, true);
  const out2 = await tools.execute("bash", { command: "git push origin main" });
  assert.equal(out2.ok, false);
  assert.match(out2.text, /拒否/);
  rmTree(ws);
});

test("READMEプローブ: コード変更を検知してupdate-readmeタスク生成・二重生成しない", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  const { writeFileSync: wf, mkdirSync: mkd } = await import("node:fs");
  mkd(join(ws, "bin"), { recursive: true });
  wf(join(ws, "bin", "hive.js"), "const HELP = `x\n  status     一覧\n`;\nexport { parseGlobalArgs };\n");
  wf(join(ws, "README.md"), "# タイトル\n\n<!-- auto:cli-commands start -->\n```\nnode bin/hive.js old   古い\n```\n<!-- auto:cli-commands end -->\n");
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: null });

  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("update-readme"), true);
  const body = readFileSync(join(ws, "tasks", "open", "update-readme.md"), "utf8");
  assert.match(body, /自動セクション/);
  assert.match(body, /cli-commands/);

  await d.tick(); // 既にある間は二重生成しない
  const open = tasks.snapshot().open.filter((f) => f === "update-readme.md");
  assert.equal(open.length, 1);
  d.stop();
  rmTree(ws);
});

test("READMEプローブ: 一致していれば起票しない・マーカー無しREADMEは保護", async () => {
  const ws = makeWorkspace();
  const { bus, tasks } = makeEnv(ws);
  const { writeFileSync: wf, mkdirSync: mkd } = await import("node:fs");
  mkd(join(ws, "bin"), { recursive: true });
  wf(join(ws, "bin", "hive.js"), "const HELP = `x\n  status     一覧\n`;\nexport { parseGlobalArgs };\n");
  const { updateReadmeFromCode } = await import("../src/engine/readme-auto.js");
  // まずは自動セクション無しの手書きREADME → 何も起きない(保護)
  wf(join(ws, "README.md"), "# 手書きREADME\n\n機械管理領域は無い。\n");
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: null });
  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("update-readme"), false);

  // 自動セクションを設置してコードと同期 → これも起票しない
  updateReadmeSections(
    { repoRoot: ws, sections: [{ id: "cli-commands", content: "PLACEHOLDER" }] },
  );
  const { markerStart, markerEnd } = await import("../src/engine/readme-auto.js");
  const synced = wf(join(ws, "README.md"), "");
  wf(
    join(ws, "README.md"),
    ["# タイトル", "", markerStart("cli-commands"), "```\nnode bin/hive.js status     一覧\n```", markerEnd("cli-commands"), ""].join("\n"),
  );
  await d.tick();
  assert.equal(tasks.existsOpenOrClaimed("update-readme"), false);
  assert.equal(synced, ""); // 未使用変数の暗示的な確認(常に空文字)
  d.stop();
  rmTree(ws);
});
