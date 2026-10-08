// to_thread起床通知: 宛先スレッドのChatHostが、to_thread経由で投稿された@表示名を検知して起床する
// (design-to-thread.md「起床通知」節。宛先Boardがpostを発行するためpost.thread===宛先名になり、
//  handleBoardPostの既存フィルタをそのまま通る)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { ChatHost } from "../src/engine/chat.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 一時ディレクトリ */ } }

async function waitUntil(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test("to_thread宛投稿の@表示名で宛先スレッドのエージェントが起床する", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-ttwake-"));
  const bus = new Bus();
  const boardA = new Board(bus, "a"); // 投稿者(自分のボードには載らない)
  const boardB = new Board(bus, "b"); // 宛先スレッド
  let wokeB = 0;
  let wokeA = 0;
  const modelB = { maxTokens: 100, async chat() { wokeB++; return { content: "応答b", toolCalls: [], raw: { content: "応答b" } }; } };
  const modelA = { maxTokens: 100, async chat() { wokeA++; return { content: "応答a", toolCalls: [], raw: { content: "応答a" } }; } };
  const agentB = { id: "b-beta", displayName: "ベータ", role: "impl", personaText: "# B" };
  const agentA = { id: "a-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const hostB = new ChatHost({
    mains: [agentB],
    modelFactory: () => modelB,
    toolsFactory: () => ({ specs: [] }),
    board: boardB, bus, maxTurnsPerRound: 2, staggerMs: 0,
  });
  void hostB;
  const hostA = new ChatHost({
    mains: [agentA],
    modelFactory: () => modelA,
    toolsFactory: () => ({ specs: [] }),
    board: boardA, bus, maxTurnsPerRound: 2, staggerMs: 0,
  });
  void hostA;

  // post_to_board({ text, to_thread: "b" }) の resolveBoard 経路相当: 宛先Boardに投稿する
  const destBoard = boardB; // resolveBoard("b") === boardB
  const post = destBoard.post("a-alpha", "@ベータ この件を見てください");
  assert.equal(post.thread, "b");

  // 宛先スレッドのベータが起床する
  await waitUntil(() => wokeB >= 1, 4000);
  assert.ok(wokeB >= 1, "宛先スレッドのエージェントが起床していない");

  // 投稿者側(スレッドa)は起床しない(投稿は宛先Boardだけが発行)
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(wokeA, 0, "投稿者側が起床してしまった");

  // 自分のスレッド名をto_threadに指定した場合も従来どおり起床する
  const before = wokeB;
  boardB.post("x", "@ベータ もう一件");
  await waitUntil(() => wokeB >= before + 1, 4000);
  rmTree(ws);
});
