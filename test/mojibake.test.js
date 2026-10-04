// 文字化け入力の検知(イシュー#20 提案3): U+FFFDを含むユーザー入力を検知し、
// リーダーへの注入文に「推測で応答せず再送を求める」警告を付ける。
// 尚可: UTF-8→cp932二重エンコード兆候( mojibake )の型検知。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import {
  containsReplacementChar,
  looksDoubleEncoded,
  mojibakeWarning,
} from "../src/engine/chat.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function makeHost(ws, calls) {
  const bus = new Bus();
  const board = new Board(bus, "mj");
  const tasks = new TaskBlackboard(ws, bus);
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      calls.push(messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })));
      return { content: "応答", toolCalls: [], raw: { content: "応答" } };
    },
  };
  const agent = { id: "mj-lead", displayName: "エム", role: "lead", depth: 0, personaText: "# M" };
  return new ChatHost({
    mains: [agent],
    modelFactory: () => model,
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus, maxTurnsPerRound: 4, staggerMs: 0, mainWorkspace: ws,
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("containsReplacementChar: U+FFFDの検知と通常文の非検知", () => {
  assert.equal(containsReplacementChar("こんにちは" + String.fromCharCode(0xfffd) + "です"), true);
  assert.equal(containsReplacementChar("通常の日本語入力です"), false);
  assert.equal(containsReplacementChar(""), false);
  assert.equal(containsReplacementChar(null), false);
});

test("looksDoubleEncoded: UTF-8→cp932二重エンコードの兆候(置換文字なしでも化け型)を検知", () => {
  const samples = [
    "ã\u0081\u0093ã\u0082\u0093ã\u0081«ã\u0081¡ã\u0081¯", // UTF-8バイトがラテン文字として再解読された型
    "ÆüËÜ¸ì", // Shift系で化けた型
  ];
  assert.equal(looksDoubleEncoded(samples[0]), true);
  assert.equal(looksDoubleEncoded(samples[1]), true);
  assert.equal(looksDoubleEncoded("正常な日本語の文章です。"), false);
  assert.equal(looksDoubleEncoded("Plain English is fine."), false);
});

test("mojibakeWarning: 警告文に再送依頼と推測禁止が含まれる", () => {
  const w = mojibakeWarning("文字" + String.fromCharCode(0xfffd) + "化け");
  assert.ok(w.includes("入力が壊れていて読めない"), w);
  assert.ok(w.includes("推測で応答せず"), w);
  assert.ok(w.includes("再送"), w);
});

test("ChatHost.say: U+FFFD入力時に注入文へ警告が付く(リーダーが受けるkickoffText)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mj-"));
  try {
    const calls = [];
    const host = makeHost(ws, calls);
    host.say("依頼です " + String.fromCharCode(0xfffd) + " 続き");
    await wait(300);
    assert.ok(calls.length >= 1, "ラウンドが走る");
    const kickoff = calls[0].map((m) => m.content).join("\n");
    assert.ok(kickoff.includes("入力が壊れていて読めない"), kickoff);
    assert.ok(kickoff.includes("推測で応答せず"), kickoff);
  } finally { rmTree(ws); }
});

test("ChatHost.say: 正常入力時は警告が付かない(通常文と変わらない)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mj-"));
  try {
    const calls = [];
    const host = makeHost(ws, calls);
    host.say("この内容で進めてください");
    await wait(300);
    assert.ok(calls.length >= 1);
    const kickoff = calls[0].map((m) => m.content).join("\n");
    assert.ok(!kickoff.includes("入力が壊れていて読めない"), kickoff);
    assert.ok(kickoff.includes("新着入力"), kickoff);
  } finally { rmTree(ws); }
});

test("ChatHost.say: 化け型(二重エンコード兆候)でも警告が付く(尚可の検知)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mj-"));
  try {
    const calls = [];
    const host = makeHost(ws, calls);
    host.say("ã\u0081\u0093ã\u0082\u0093ã\u0081«ã\u0081¡ã\u0081¯ 依頼");
    await wait(300);
    assert.ok(calls.length >= 1);
    const kickoff = calls[0].map((m) => m.content).join("\n");
    assert.ok(kickoff.includes("入力が壊れていて読めない"), kickoff);
  } finally { rmTree(ws); }
});
