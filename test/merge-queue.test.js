// merge-queue: finish_taskのマージ直列化と競合自動取込の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorktrees, mergeAgentWork, withMergeLock } from "../src/engine/worktree.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { runCommand } from "../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }
function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "hive-mq-"));
}

test("withMergeLock: 同時実行でも逐次化される(オーバーラップなし)", async () => {
  const events = [];
  const [a, b] = await Promise.all([
    withMergeLock(async () => { events.push("a-start"); await new Promise((r) => setTimeout(r, 30)); events.push("a-end"); return 1; }),
    withMergeLock(async () => { events.push("b-start"); await new Promise((r) => setTimeout(r, 10)); events.push("b-end"); return 2; }),
  ]);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withMergeLock: 前のジョブが失敗しても後続は実行される", async () => {
  const r = await withMergeLock(async () => { throw new Error("boom"); }).then(() => "ok", (e) => `err:${e.message}`);
  assert.equal(r, "err:boom");
  const s = await withMergeLock(async () => "next");
  assert.equal(s, "next");
});

test("同時finish: 2エージェントのマージが逐次化されmainが壊れない", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const paths = await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }, { id: "beta" }] });
  writeFileSync(join(paths.alpha, "a.txt"), "alpha work");
  writeFileSync(join(paths.beta, "b.txt"), "beta work");
  const [ra, rb] = await Promise.all([
    mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.alpha, agent: { id: "alpha" }, taskId: "t-a" }),
    mergeAgentWork({ mainWorkspace: ws, worktreePath: paths.beta, agent: { id: "beta" }, taskId: "t-b" }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "alpha work");
  assert.equal(readFileSync(join(ws, "b.txt"), "utf8"), "beta work");
  const log = await runCommand({ command: "git log --oneline", cwd: ws, outputLimit: 2000 });
  assert.match(log.text, /merge: t-a by alpha/);
  assert.match(log.text, /merge: t-b by beta/);
  rmTree(ws);
  rmTree(root);
});

test("競合自動取込(成功側): 初回マージ失敗→worktree内merge main→再マージで通る", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  // main側が先に進む
  writeFileSync(join(ws, "main.txt"), "main side");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -m 'main change'", cwd: ws, outputLimit: 1000 });
  // alphaは別ファイルを変更
  writeFileSync(join(wt, "alpha.txt"), "alpha side");
  // exec注入: 最初の mainWorkspace への merge --no-ff を競合失敗に偽装し、自動取込経路を強制する
  let firstMergeFailed = false;
  const fakeExec = async (args) => {
    if (!firstMergeFailed && args.cwd === ws && /git merge --no-ff/.test(args.command)) {
      firstMergeFailed = true;
      return { ok: false, text: "exit=1\nCONFLICT (content): Merge conflict in alpha.txt" };
    }
    return runCommand(args);
  };
  const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t-auto", exec: fakeExec });
  assert.equal(r.ok, true);
  assert.equal(r.autoMerged, true); // 自動取込経路を通った証
  assert.equal(readFileSync(join(ws, "alpha.txt"), "utf8"), "alpha side");
  assert.equal(readFileSync(join(ws, "main.txt"), "utf8"), "main side");
  // worktree内に自動merge mainのコミットが残る
  const log = await runCommand({ command: "git log --oneline -2", cwd: wt, outputLimit: 1000 });
  assert.match(log.text, /auto-import/);
  rmTree(ws);
  rmTree(root);
});

test("競合自動取込(成功側): worktreeがmainに遅れても自動merge mainで吸収される", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  // main側が先に進む
  writeFileSync(join(ws, "main.txt"), "main side");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -m 'main change'", cwd: ws, outputLimit: 1000 });
  // alphaは別ファイルを変更
  writeFileSync(join(wt, "alpha.txt"), "alpha side");
  const r = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t-auto2" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "alpha.txt"), "utf8"), "alpha side");
  assert.equal(readFileSync(join(ws, "main.txt"), "utf8"), "main side");
  rmTree(ws);
  rmTree(root);
});

test("競合自動取込(失敗側): 競合マーカーが残る形ならconflictエラー+案内メッセージ", async () => {
  const ws = makeWorkspace();
  await ensureGitRepo(ws);
  const root = `${ws}-wt`;
  const [wt] = Object.values(await setupWorktrees({ mainWorkspace: ws, worktreeRoot: root, agents: [{ id: "alpha" }] }));
  // main側が先に進む
  writeFileSync(join(ws, "code.txt"), "line from main");
  await runCommand({ command: "git add -A && git -c user.name=t -c user.email=t@t commit -m 'main change'", cwd: ws, outputLimit: 1000 });
  // alphaも同じ行を別内容で変更 → worktree内 merge main も競合する
  writeFileSync(join(wt, "code.txt"), "line from alpha");
  const r1 = await mergeAgentWork({ mainWorkspace: ws, worktreePath: wt, agent: { id: "alpha" }, taskId: "t-conflict" });
  assert.equal(r1.conflict, true);
  // 案内メッセージに解消案内が含まれる
  assert.match(r1.text ?? "", /競合ファイルを解消/);
  assert.equal(readFileSync(join(ws, "code.txt"), "utf8"), "line from main"); // mainは無傷
  // worktreeはマージ前の状態に戻っている(エージェントが手動でmerge mainすると競合マーカーが出る)
  const manual = await runCommand({ command: "git merge main", cwd: wt, outputLimit: 2000 });
  assert.equal(manual.ok, false);
  const marker = readFileSync(join(wt, "code.txt"), "utf8");
  assert.match(marker, /<<<<<<< /);
  assert.match(marker, />>>>>>> /);
  rmTree(ws);
  rmTree(root);
});