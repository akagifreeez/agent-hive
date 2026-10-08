// mem-*.json の肥大化対策(イシュー#20-2):
// ChatHostはラウンド終了ごとに全messagesを state/mem-<id>.json へ保存するため、
// 常駐チャットでは記憶ファイルが際限なく育つ。ラウンド境界で上限を超えたら
// 「system + 要約 + 直近N件」へ刈り取り、上限は chat.memMaxMessages で設定可能にする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost, trimMemories, MEM_REF_RE } from "../src/engine/chat.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-memg-"));
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

test("trimMemories: 上限超過時にsystem+要約+直近分へ刈り取る", () => {
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "初期化" },
    { role: "assistant", content: "古い応答1" },
    { role: "user", content: "[ボード新着]\nbeta: ボード#12で議論(2026-09-15)" },
    { role: "assistant", content: "了解しました。ボード#12を確認します。" },
    { role: "user", content: "次の指示" },
  ];
  const trimmed = trimMemories(messages, { memMaxMessages: 3 });
  assert.ok(trimmed.length <= 3, "上限を守る");
  assert.equal(trimmed[0].content, "SYS", "systemプロンプトは先頭に保持");
  const summary = trimmed.find((m) => m.role === "user" && m.content.includes("[Memory pruned]"));
  assert.ok(summary, "刈り取りの要約が注入される");
  assert.ok(summary.content.includes("2026-09-15"), "要約には日時ラベル付き参照が残る");
  const tail = trimmed[trimmed.length - 1];
  assert.equal(tail.content, "次の指示", "直近の入力は保持される");
});

test("trimMemories: 上限以内ならそのまま(同一内容・同順序)", () => {
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  const trimmed = trimMemories(messages, { memMaxMessages: 10 });
  assert.deepEqual(trimmed, messages);
  // 上限未指定(config無し)は初期値で動く(刈り取りが有効)
  const defaultTrimmed = trimMemories(messages, {});
  assert.equal(defaultTrimmed[0].content, "SYS");
});

test("trimMemories: 旧参照(番号単独)は要約時にラベル/日時付きへ補正される", () => {
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "ボード#7 を見て" },
    { role: "assistant", content: "ボード#7 を確認した" },
    { role: "user", content: "では次へ" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "締め" },
  ];
  const trimmed = trimMemories(messages, { memMaxMessages: 3 });
  const summary = trimmed.find((m) => m.role === "user" && m.content.includes("[Memory pruned]"));
  assert.ok(summary, "要約あり");
  assert.ok(summary.content.includes("ボード#7(main・日時不明)"), "番号単独の参照にはスレッドラベルが付く");
  assert.ok(!MEM_REF_RE.test(summary.content.replace(/main・日時不明\)/g, "")), "補正済み参照が再補正されない");
});

test("trimMemories: 刈り取り後も参照が日時ラベル付きで要約へ残る", () => {
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "調べもの" },
    { role: "assistant", content: "ボード#3に調査依頼を出した(2026-09-16 10:00)" },
    { role: "user", content: "結果は?" },
    { role: "assistant", content: "まだ" },
    { role: "user", content: "了解" },
  ];
  const trimmed = trimMemories(messages, { memMaxMessages: 3 });
  const summary = trimmed.find((m) => m.role === "user" && m.content.includes("[Memory pruned]"));
  assert.ok(summary.content.includes("2026-09-16 10:00"), "日時ラベルが要約に保持される");
});

test("ChatHost: ラウンド終了時、mem-<id>.jsonが上限を超えない(configで設定)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "memg");
  const tasks = new TaskBlackboard(ws, bus);
  let n = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      n++;
      return { content: `応答${n}`, toolCalls: [], raw: { content: `応答${n}` } };
    },
  };
  const agent = { id: "memg-lead", displayName: "メム", role: "lead", depth: 0, personaText: "# M" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: ws,
    modelFactory: () => model,
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus, maxTurnsPerRound: 6, staggerMs: 0,
    chatConfig: { memMaxMessages: 6 },
  });
  // 3ラウンド分入力を積む(各ラウンドでuser+assistantが2件ずつ増える)
  host.say("ラウンド1");
  await waitUntil(() => n >= 1);
  await waitUntil(() => !host.roundState.get("memg-lead")?.running);
  host.wake(agent, "ラウンド2");
  await waitUntil(() => n >= 2);
  await waitUntil(() => !host.roundState.get("memg-lead")?.running);
  host.wake(agent, "ラウンド3");
  await waitUntil(() => n >= 3);
  await waitUntil(() => !host.roundState.get("memg-lead")?.running);
  const memFile = join(ws, "state", "mem-memg-lead.json");
  assert.ok(existsSync(memFile), "memファイルが保存されている");
  const mem = JSON.parse(readFileSync(memFile, "utf8"));
  assert.ok(mem.messages.length <= 6, `上限以下に刈り取られている(実際: ${mem.messages.length})`);
  assert.ok(mem.messages[0].role === "system" && mem.messages[0].content.startsWith("# M"), "systemプロンプト(ペルソナ)は先頭に保持される");
  rmTree(ws);
});

test("ChatHost: チャンク刈り取り後も会話が続き、再起動復元でも壊れない", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "memg2");
  const tasks = new TaskBlackboard(ws, bus);
  let n = 0;
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      n++;
      return { content: `返答${n}`, toolCalls: [], raw: { content: `返答${n}` } };
    },
  };
  const agent = { id: "memg2", displayName: "メム2", role: "impl", depth: 0, personaText: "# M2" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: ws,
    modelFactory: () => model,
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus, maxTurnsPerRound: 6, staggerMs: 0,
    chatConfig: { memMaxMessages: 4 },
  });
  host.say("ひとつめ");
  await waitUntil(() => n >= 1);
  await waitUntil(() => !host.roundState.get("memg2")?.running);
  host.wake(agent, "ふたつめ");
  await waitUntil(() => n >= 2);
  await waitUntil(() => !host.roundState.get("memg2")?.running);
  const mem = JSON.parse(readFileSync(join(ws, "state", "mem-memg2.json"), "utf8"));
  assert.ok(mem.messages.length <= 4, "保存時に刈り取り済み");
  assert.ok(mem.messages.some((m) => m.content.includes("ふたつめ")), "直近の入力は記憶に残る");
  // 復元系: trimMemoriesはnullやsystemのみでも壊れない
  assert.doesNotThrow(() => trimMemories([{ role: "system", content: "S" }], { memMaxMessages: 2 }));
  assert.equal(trimMemories(null, { memMaxMessages: 2 }), null);
  rmTree(ws);
});
