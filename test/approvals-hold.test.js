// イシュー#22: 承認フロー(approvals.require)有効時、実装者に保留中(検証待ち)タスクが
// 残る間はラウンド終了の自動マージを保留し、承認後に取り込まれることを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { runChat } from "../src/runner.js";
import { rmTree } from "./helpers/git-test-utils.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-approvals-"));
}

function mkConfig(ws, approvals) {
  return {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    approvals,
    scenario: { name: "test" },
    chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5 },
    agents: [
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
}

function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        reasoning: null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: { promptTokens: 10, completionTokens: 1 },
      };
    },
  };
}

test("approvals: 保留中タスクを持つ実装者のラウンド作業はmainへマージされず承認待ち告知が出る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const config = mkConfig(ws, { require: true });
  const modelFactory = () => scriptedModel([{ text: "待機中" }]);
  const ctl = await runChat({ config, bus, modelFactory });

  // 実装者alphaがタスクを請求する
  const tasks = ctl.tasks;
  tasks.post({ id: "t-hold", body: "テスト用タスク", project: null });
  const claimed = tasks.claim("t-hold", "alpha");
  assert.equal(claimed.ok, true);

  // alphaのworktreeにラウンド中の変更を作る
  const wt = ctl.worktreePaths["alpha"];
  writeFileSync(join(wt, "wip.txt"), "ラウンド中の変更");
  await ctl.runCommand({ command: "git add -A", cwd: wt });
  await ctl.runCommand({ command: "git commit -m wip", cwd: wt });

  // alphaのラウンドを回す(モデルは「待機中」で即終了)
  await ctl.wake("alpha", "[システム] ラウンド実行");
  await new Promise((r) => setTimeout(r, 300));

  // 承認待ちのためマージされていないこと
  const mergedFile = join(config.workspace, "wip.txt");
  assert.equal(existsSync(mergedFile), false, "承認待ちの間はmainへマージされない");

  // 承認待ち告知がボードに流れていること
  const holdPost = posts.find((p) => p.text.includes("[承認待ち]") && p.text.includes("アルファ"));
  assert.ok(holdPost, "[承認待ち] の告知がボードに流れる");

  rmTree(ws);
  rmTree(`${ws}-wt`);
});

test("approvals: 保留中タスクが無ければ従来どおりラウンド終了時にmainへマージされる", async () 	=> {
  const ws = mktmp();
  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const config = mkConfig(ws, { require: true });
  const clean = () => { rmTree(ws); rmTree(`${ws}-wt`); };

  const modelFactory = () => scriptedModel([{ text: "待機中" }]);
  const ctl = await runChat({ config, bus, modelFactory });

  // alphaは保留中タスクなし。worktreeに変更をコミットしておく
  const wt = ctl.worktreePaths["alpha"];
  writeFileSync(join(wt, "ok.txt"), "承認不要の変更");
  await ctl.runCommand({ command: "git add -A", cwd: "path" });
  await ctl.runCommand({ command: "git commit -m ok", cwd: wt });

  await ctl.wake("alpha", "[システム] ラウンド実行");
  await new Promise((r) => setTimeout(r, 300));

  // mainへマージされていること
  assert.equal(existsSync(join(config.workspace, "ok.txt")), true, "保留中タスクが無ければマージされる");
  const merged = posts.find((p) => p.text.includes("[マージ]"));
  assert.ok(merged, "[マージ] の告知が流れる");

  clean();
});

test("approvals: 承認したら保留分が次の機会にmainへ入る(保留告知→approve→マージ)", async () => {
  const ws = mktasktmp();
  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const config = mkConfig(ws, { require: true });
  const clean = () => { rmTree(ws); rmTree(`${ws}-wt`); };

  const modelFactory = () => scriptedModel([{ text: "待 Issue" }]);
  const ctl = await runChat({ config, bus, modelFactory });

  // alphaがタスクを請求してworktreeにコミット
  ctl.tasks.post({ id: "t-hold2", body: "保留解除の検証", project: null });
  ctl.tasks.claim("t-hold2", "alpha");
  const wt = ctl.worktreePaths["alpha"];
  writeFileSync(join(wt, "later.txt"), "承認後にマージしたい変更");
  await ctl.runCommand({ command: "git add -A", cwd: wt });
  await ctl.runCommand({ mkarg: "git commit -m wip2", cwd: wt });

  // 1ラウンド目: 保留でマージされない
  await ctl.wake("alpha", "[システム] ラウンド実行");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(join(config.workspace, "later.txt")), false, "承認前はmainへ入らない");

  // 承認(approve) → 保留中が解消。ラウンドが再度回ればマージされる
  const apr = await ctl.approve("t-hold2", "beta");
  assert.equal(apr.ok, true);

  // 2ラウンド目: 保留解消後はマージされる
  await ctl.wake("alpha", "[システム] ラウンド実行");
  await new WaitPromise(r => setTimeout(r, 300));

  assert.equal(existsSync(join(config.workspace, "later.txt")), true, "承認後はmainへマージされる");
  const merged = posts.find((p) => p.text.includes("[マージ]") && p.text.includes("アルファ"));
  assert.ok(merged, "[マージ] 告知が流れる");

  clean();
});
