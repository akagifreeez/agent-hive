// pruneMemoriesが保護対象(system+直近)だけでmaxBytesを超える場合の契約(イシュー#21残課題):
// (1)刈れるbodyが無くても超過を黙殺せず、明示的警告メッセージを1件だけ挿入する
//    (毎ラウンド増殖させない: 直近に警告が無いときのみ挿入。changed=trueになる)
// (2)checkpoint復元(loadCheckpoint)でも同じ上限が適用される
// (3)saveMemories経由でも警告がmem-*.jsonへ反映され、再保存で増殖しない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { pruneMemories, MEM_WARN_HEADER } from "../src/engine/compact.js";

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsロックは無視 */ }
}

const isWarn = (m) => typeof m.content === "string" && m.content.startsWith(MEM_WARN_HEADER);

function makeHost(ws, { id = "mw-lead", memMaxMessages = 200, memMaxBytes = 64 * 1024 } = {}) {
  const bus = new Bus();
  const board = new Board(bus, "mw");
  const tasks = new TaskBlackboard(ws);
  const agent = { id, displayName: "エム", role: "lead", personaText: "# M" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: ws,
    modelFactory: () => ({ maxTokens: 10, chat: async () => ({ content: "ok", toolCalls: [], raw: {}, usage: {} }) }),
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus, staggerMs: 0,
    config: { chat: { memMaxMessages, memMaxBytes } },
  });
  return { host, agent, bus };
}

test("pruneMemories: 保護対象だけでmaxBytes超過→警告1件を挿入(changed=true・再挿入なし)", () => {
  // bodyが1件も刈れない状態: system(600KB) + user1件(500KB) で合計>1MB、上限512KB
  const msgs = [
    { role: "system", content: "s".repeat(600 * 1024) },
    { role: "user", content: "u".repeat(500 * 1024) },
  ];
  const r = pruneMemories(msgs, { keepRecent: 1, maxMessages: 200, maxBytes: 512 * 1024 });
  assert.equal(r.changed, true, "超過を黙殺しない(警告挿入でchanged)");
  assert.equal(r.removed, 0, "刈り取る余地が無いためremoved=0");
  assert.equal(r.messages[0].role, "system", "systemは先頭に保護される");
  const warnIdx = r.messages.findIndex(isWarn);
  assert.ok(warnIdx > 0, "警告はsystemの後ろに挿入される");
  const warn = r.messages[warnIdx].content;
  assert.match(warn, /524288/, "上限バイト値が警告に現れる");
  assert.match(warn, /\d{4}-\d{2}-\d{2}T/, "日時が付く(いつ警告したか記録が残る)");
  // 再度pruneしても警告は増殖しない(直近に警告が既にある)
  const r2 = pruneMemories(r.messages, { keepRecent: 1, maxMessages: 200, maxBytes: 512 * 1024 });
  assert.equal(r2.changed, false, "警告済みなら再挿入しない(毎ラウンド増殖しない)");
  assert.equal(r2.messages.filter(isWarn).length, 1);
});

test("pruneMemories: 刈り取り可能なbodyがある通常超過は警告を挟まない(既存契約を壊さない)", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "a".repeat(400 * 1024) },
    { role: "assistant", content: "b".repeat(400 * 1024) },
  ];
  const r = pruneMemories(msgs, { keepRecent: 1, maxMessages: 200, maxBytes: 512 * 1024 });
  assert.equal(r.changed, true);
  assert.equal(r.removed, 1, "刈れるときは普通に刈る");
  assert.equal(r.messages.filter(isWarn).length, 0, "通常刈り取りに警告は不要");
});

test("checkpoint復元(loadCheckpoint)でもmem上限が適用される", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-cp-prune-"));
  try {
    const { host } = makeHost(ws, { id: "cp-lead", memMaxMessages: 6, memMaxBytes: 10 * 1024 * 1024 });
    // モデル異常時に保存されるはずのスナップショット(40件・上限6件超過)を直接書く
    const big = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `m${i}` })),
    ];
    mkdirSync(join(ws, "state"), { recursive: true });
    writeFileSync(join(ws, "state", "checkpoint-cp-lead.json"), JSON.stringify({ messages: big }));
    const loaded = host.loadCheckpoint("cp-lead");
    assert.ok(Array.isArray(loaded), "checkpointが読める");
    assert.ok(loaded.length <= 6, `復元経路でも上限内に収まる: ${loaded.length}`);
    assert.equal(loaded[0].role, "system", "system保護は復元経路でも効く");
    rmTree(ws);
  } catch (e) {
    rmTree(ws);
    throw e;
  }
});

test("saveMemories経由でも保護対象超過時に警告がmem-*.jsonへ反映される(再保存で増殖しない)", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mem-warn-"));
  try {
    const { host } = makeHost(ws);
    host.memories.set("mw-lead", [
      { role: "system", content: "s".repeat(70 * 1024) }, // 上限64KBを単独で超えるsystem
      { role: "user", content: "hello" },
    ]);
    host.saveMemories({ id: "mw-lead" });
    const mem = JSON.parse(readFileSync(join(ws, "state", "mem-mw-lead.json"), "utf8"));
    assert.equal(mem.messages.filter(isWarn).length, 1, "警告が1件だけ永続化される");
    // 2回保存しても増殖しない
    host.saveMemories({ id: "mw-lead" });
    const mem2 = JSON.parse(readFileSync(join(ws, "state", "mem-mw-lead.json"), "utf8"));
    assert.equal(mem2.messages.filter(isWarn).length, 1, "再保存で警告が増えない");
    rmTree(ws);
  } catch (e) {
    rmTree(ws);
    throw e;
  }
});
