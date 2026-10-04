// イシュー#21回帰テスト: 未読worker投稿が大量(6,100文字)でもユーザー質問が欠落しないこと。
// 実害(2026-10-04 fix-lead-priority): 旧実装はボード新着を連結して text.slice(0,6000) で打ち切り、
// かつ seen を最後の投稿まで進めていた。その結果 (1)巨大投稿の後半が永遠に届かない
// (2)あとから届いた通常投稿も一緒に消える、という2重の欠落が起きていた。
// 修正後の契約: ボード新着は「投稿単位で予算(6,000文字)に詰めて」配信し、収まらなかった投稿は
// 未読のまま残す(次ターン/次ラウンドで配信)。1件だけで超過する巨大投稿は先頭部分のみ配信して
// 既読へ進める(無限再配信を防ぐ。利用側の緩和: 巨大報告は分割投稿)。
// ユーザー質問(host.say)はキックオフ+steering経路で別メッセージのため打ち切りの影響を受けない
// ことも併せて固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { runAgentLoop } from "../src/engine/loop.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-trunc21-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("イシュー#21: 巨大未読投稿の後ろの通常投稿は同じターンで消えず、次ターン以降で配信される", async () => {
  const bus = new Bus();
  const board = new Board(bus, "t21b");
  const tasks = new TaskBlackboard(mktmp(), bus);
  const agent = { id: "w", displayName: "ダブ", role: "impl", personaText: "# W", scenarioName: "t" };
  const saw = { betaHead: false, gamma: false };
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      // 毎ターンclaimしてidle退場を避け、未読の配信を続けさせる
      return {
        content: "確認",
        toolCalls: [{ name: "claim_next_task", arguments: {} }],
        raw: { content: "確認" },
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };
  // モデル応答を横取りして新着の有無を記録(claim結果のテキスト注入もlastで来るため全部見る)
  const seenTexts = [];
  const orig = model.chat.bind(model);
  model.chat = async ({ messages }) => {
    for (const m of messages) {
      if (typeof m.content === "string") seenTexts.push(m.content);
    }
    return orig({ messages });
  };
  board.post("beta", "x".repeat(6100));
  board.post("gamma", "ガンマの通常報告G9Z: ここは消えてはいけない");
  const r = await runAgentLoop({
    agent,
    model,
    tools: { specs: [], execute: async () => ({ ok: true, text: "empty" }) },
    board, tasks, bus,
    maxTurns: 5,
    shellKind: "bash",
    contextWindow: 200000,
    seenBoard: 0,
  });
  const all = seenTexts.join("\n");
  saw.betaHead = all.includes("beta #1");
  saw.gamma = all.includes("ガンマの通常報告G9Z");
  assert.ok(saw.betaHead, "巨大投稿の先頭は配信される");
  assert.ok(saw.gamma, "後続の通常投稿も同一ラウンド内の後続ターンで配信される(欠落しない)");
  assert.equal(r.seenBoard, board.lastId(), "最終的に全投稿が既読へ進む");
  rmTree(tasks.workspace);
});

test("イシュー#21: 巨大投稿超過分は単一ラウンドでは再配信されない(先頭のみ配信して既読へ進める)", async () => {
  const bus = new Bus();
  const board = new Board(bus, "t21c");
  const agent = { id: "w", displayName: "ダブ", role: "impl", personaText: "# W", scenarioName: "t" };
  const tail = "TAILZ8K"; // 6,000文字境界の後ろに置くマーカー
  board.post("beta", "x".repeat(6100 - tail.length) + tail);
  let tailSeen = 0;
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      for (const m of messages) {
        if (typeof m.content === "string" && m.content.includes(tail)) tailSeen++;
      }
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: {} };
    },
  };
  const r = await runAgentLoop({
    agent,
    model,
    tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus,
    maxTurns: 3,
    shellKind: "bash",
    contextWindow: 200000,
    seenBoard: 0,
  });
  assert.equal(tailSeen, 0, "単一ラウンド内で打ち切り後半が再配信されない(既読へ進めて無限ループを防ぐ)");
  assert.equal(r.seenBoard, 1, "先頭のみ配信して既読へ進む");
});

test("イシュー#21: 未読worker投稿6,100文字→say(質問)でも質問本文はモデル入力に完全な形で含まれる", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "t21");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "t21-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  const prompts = []; // モデルが受けた全messagesの連結
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      prompts.push(messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "t21", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus,
  });

  // 未読のworker投稿を6,100文字ぶん積む(リーダーはまだラウンドを走らせていない=全て未読)
  board.post("t21-beta", "x".repeat(6100));
  // その直後にユーザー質問(say)
  const question = "この6100文字の投稿と私の質問、両方見えていますか?質問固有トークンQX7Kを応答に含めてください";
  host.say(question);

  assert.ok(await waitUntil(() => prompts.length >= 1), "1ラウンド目が走る");
  assert.ok(await waitUntil(() => !host.roundState.get("t21-lead")?.running), "ラウンド完了");
  // 質問はsayのキックオフメッセージとして独立して配信されるため、打ち切りの影響を受けない
  for (const p of prompts) {
    assert.ok(p.includes(question), "質問本文が完全な形でモデル入力に含まれる");
  }
  // 巨大投稿は先頭部分のみとはいえ参照(投稿者+id)ごとモデルへ届く
  assert.ok(prompts[0].includes("t21-beta #1"), "巨大投稿の参照(投稿者+id)はモデルへ届く");
  rmTree(ws);
});

test("イシュー#21: ラウンドをまたいで未読投稿が欠落しない(ホストのseen保持と合流)", async () => {
  const bus = new Bus();
  const board = new Board(bus, "t21d");
  const tasks = new TaskBlackboard(mktmp(), bus);
  const agent = { id: "w", displayName: "ダブ", role: "impl", personaText: "# W", scenarioName: "t" };
  board.post("beta", "x".repeat(6100));
  board.post("gamma", "ガンマの通常報告G9Z");
  // ラウンド1: 巨大投稿の先頭のみ配信(seen=1で終わる)
  const r1 = await runAgentLoop({
    agent,
    model: { maxTokens: 100, async chat() { return { content: "ok1", toolCalls: [], raw: { content: "ok1" }, usage: {} }; } },
    tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus,
    maxTurns: 2, shellKind: "bash", contextWindow: 200000, seenBoard: 0,
  });
  assert.equal(r1.seenBoard, 1, "ラウンド1は巨大投稿の先頭のみ配信");
  // ラウンド2: ホストがseen=1を保持して再開 → ガンマが届く
  let got = "";
  await runAgentLoop({
    agent,
    model: {
      maxTokens: 100,
      async chat({ messages }) {
        for (const m of messages) if (typeof m.content === "string" && m.content.includes("[ボード新着]")) got = m.content;
        return { content: "ok2", toolCalls: [], raw: { content: "ok2" }, usage: {} };
      },
    },
    tools: { specs: [], execute: async () => ({ ok: true, text: "" }) },
    board, tasks: null, bus,
    maxTurns: 2, shellKind: "bash", contextWindow: 200000, seenBoard: r1.seenBoard,
  });
  assert.ok(got.includes("ガンマの通常報告G9Z"), "ラウンド2で後続投稿が配信される");
  rmTree(tasks.workspace);
});
