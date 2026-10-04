// v6.1: チャット復帰(ボード投稿/スレッド/会話メモリの永続化)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../../src/engine/board.js";
import { runChat } from "../../src/runner.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-persist-"));
}

async function waitUntil(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
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

test("Board: persistPathに追記され、新しいBoardでリプレイされる", () => {
  const ws = mktmp();
  const path = join(ws, "state", "board-x.jsonl");
  const b1 = new Board(new Bus(), "x", path);
  b1.post("alpha", "1件目");
  b1.post("beta", "2件目");
  assert.equal(b1.seq, 2);

  const b2 = new Board(new Bus(), "x", path); // 再起動相当
  assert.equal(b2.posts.length, 2);
  assert.equal(b2.posts[1].text, "2件目");
  const p = b2.post("gamma", "3件目"); // 続き番号が続く
  assert.equal(p.id, 3);
  rmTree(ws);
});

test("v6.1: 再起動してもボード投稿・スレッド・会話メモリが復元される", async () => {
  const ws = mktmp();
  const config = {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5, autoscale: false },
    agents: [
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
  const modelFactory = () => scriptedModel([{ text: "承知しました" }]);
  const logLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : -1);
  const mainLog = () => join(ws, "state", "board__main__.jsonl");
  const demoLog = () => join(ws, "state", "board-demo.jsonl");

  // 1回目: 会話して、スレッドを開いて、終了(=プロセスを落とす想定)
  const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
  ctl1.say("こんにちは");
  await waitUntil(() => logLines(mainLog()) >= 2, 15000); // you+リーダーの投稿が永続化
  assert.ok(logLines(mainLog()) >= 2);
  assert.equal(existsSync(join(ws, "state", "mem-lead.json")), true); // 会話メモリ保存
  await ctl1.openThread({ project: "demo", goal: "復元テスト" });
  await waitUntil(() => ctl1.listThreads().includes("demo"));
  // ワーカー3体の起動ラウンド(キックオフ+各ワーカーの応答投稿)が落ち着くまで待つ。
  // 2連続同一行数だけだとstagger遅延で早期抜けし、直後の応答が混入する競合があった
  // (memory: persist行数固定assertは並行負荷に弱い)。2連続同一+1秒静止を要求する。
  let prev = -1;
  let stableCount = 0;
  for (let i = 0; i < 100; i++) {
    const c = logLines(demoLog());
    if (c === prev && c > 0) {
      stableCount++;
      if (stableCount >= 5) break; // 2連続同一+約1秒静止
    } else {
      stableCount = 0;
    }
    prev = c;
    await new Promise((r) => setTimeout(r, 200));
  }
  const demoLinesBefore = logLines(demoLog());
  assert.ok(demoLinesBefore >= 1);

  // 2回目: 同じworkspaceで再起動
  const opened2 = [];
  const bus2 = new Bus();
  bus2.on("thread.opened", (p) => opened2.push(p));
  await runChat({ config, bus: bus2, modelFactory });

  const demo2 = opened2.find((t) => t.name === "demo");
  assert.ok(demo2, "スレッドが無音で復元されている");
  assert.equal(demo2.agents.length, 3);
  // 無音復元の確認: 起動ラウンドの遅延投稿(stagger等)が混ざる場合があるため、
  // 行数が静止するまで待ってから比較する(固定行数assertは並行負荷でフレーキーする)
  {
    let cur = logLines(demoLog());
    let last = -1;
    const deadline = Date.now() + 10000;
    while (cur !== last && Date.now() < deadline) {
      last = cur;
      await new Promise((r) => setTimeout(r, 300));
      cur = logLines(demoLog());
    }
  }
  assert.equal(logLines(demoLog()), demoLinesBefore, "無音復元なので投稿が増えない");
  assert.ok(logLines(mainLog()) >= 2, "メインの履歴も保持されている");
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
