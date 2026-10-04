// イシュー#20: 会話メモリ(mem-<id>.json)のラウンド間肥大止めの検証
// - pruneMemories: 上限(件数/バイト)超過時に古い分を刈り取り、要点ヘッダを残す
// - ChatHost.saveMemories: in-memoryと永続化の両方へ反映(復元時に再肥大しない)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneMemories, MEM_HEADER } from "../src/engine/compact.js";
import { ChatHost } from "../src/engine/chat.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-memprune-"));
}

function cleanup(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

test("pruneMemories: 上限内なら何もしない(非破壊)", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  const r = pruneMemories(msgs, { maxMessages: 10, maxBytes: 1024 });
  assert.equal(r.changed, false);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.messages, msgs); // 中身は同一(新配列)
  assert.notEqual(r.messages, msgs); // 参照は別(呼び出し側の配列を汚さない)
});

test("pruneMemories: 件数超過で古い分がヘッダ1件に置換され、systemと直近は保護される", () => {
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 50; i++) {
    msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg${i}` });
  }
  const r = pruneMemories(msgs, { keepRecent: 5, maxMessages: 20, maxBytes: 10 * 1024 * 1024 });
  assert.equal(r.changed, true);
  // system + ヘッダ + keepRecent
  assert.equal(r.messages.length, 1 + 1 + 5);
  assert.equal(r.messages[0].role, "system");
  assert.match(r.messages[1].content, new RegExp(MEM_HEADER));
  assert.match(r.messages[1].content, /46件/); // 50件中46件が刈り取り
  assert.match(r.messages[1].content, /\d{4}-\d{2}-\d{2}T/); // 日時付き
  // 直近5件は原形のまま残る
  assert.equal(r.messages[2].content, "msg45");
  assert.equal(r.messages[6].content, "msg49");
  assert.equal(r.removed, 46);
});

test("pruneMemories: バイト超過でも刈り取りが働く", () => {
  const big = "x".repeat(1000);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: big },
    { role: "assistant", content: big },
  ];
  const r = pruneMemories(msgs, { keepRecent: 2, maxMessages: 100, maxBytes: 512 });
  assert.equal(r.changed, true);
  assert.equal(r.messages.length, 1 + 1 + 2);
  assert.match(r.messages[1].content, new RegExp(MEM_HEADER));
});

test("pruneMemories: system無しの配列でも刈り取りできる", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: "user", content: `m${i}` });
  const r = pruneMemories(msgs, { keepRecent: 2, maxMessages: 5, maxBytes: 1024 * 1024 });
  assert.equal(r.changed, true);
  assert.equal(r.messages.length, 1 + 2); // ヘッダ + 直近2件
  assert.match(r.messages[0].content, new RegExp(MEM_HEADER));
});

test("pruneMemories: keepRecentが上限を食い潰す場合は保護枠を縮める", () => {
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 30; i++) msgs.push({ role: "user", content: `m${i}` });
  // maxMessages=4なのにkeepRecent=50 → keepは 4-1-1=2 に縮む
  const r = pruneMemories(msgs, { keepRecent: 50, maxMessages: 4, maxBytes: 1024 * 1024 });
  assert.equal(r.messages.length, 4);
});

test("ChatHost.saveMemories: 上限超過メモリは刈り取りされてからstate/へ保存される", async () => {
  const ws = mktmp();
  try {
    const bus = new Bus();
    const board = new Board(bus, "__main__", null);
    const tasks = new TaskBlackboard(join(ws, "tasks.jsonl"), bus);
    const host = new ChatHost({
      mains: [{ id: "t1", displayName: "T1", role: "impl", personaText: "p" }],
      mainWorkspace: ws,
      modelFactory: () => null,
      toolsFactory: () => null,
      board, tasks, bus,
      config: { chat: { memMaxMessages: 5, memMaxBytes: 1024 * 1024 } },
    });
    // 上限(5件)を超えるメモリを直接積む
    const mem = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 30; i++) mem.push({ role: i % 2 ? "assistant" : "user", content: `round${i}` });
    host.memories.set("t1", mem);
    host.saveMemories(host.mains[0]);
    // in-memoryも刈り取り反映(system + ヘッダ + keepRecent=12)
    const now = host.memories.get("t1");
    assert.ok(now.length < mem.length, "in-memoryも縮む");
    assert.equal(now.length, 1 + 1 + 12);
    assert.match(now[1].content, new RegExp(MEM_HEADER));
    // 永続化ファイルも同様に縮んでいる
    const saved = JSON.parse(readFileSync(join(ws, "state", "mem-t1.json"), "utf8"));
    assert.equal(saved.messages.length, now.length);
    assert.match(saved.messages[1].content, new RegExp(MEM_HEADER));
    // 再起動を想定した復元でも肥大が戻らない(loadMemoriesはそのまま読む)
    const host2 = new ChatHost({
      mains: [{ id: "t1", displayName: "T1", role: "impl", personaText: "p" }],
      mainWorkspace: ws,
      modelFactory: () => null,
      toolsFactory: () => null,
      board, tasks, bus,
    });
    const restored = host2.memory(host2.mains[0]);
    assert.equal(restored.length, now.length, "復元後も刈り取り済みサイズ");
  } finally {
    cleanup(ws);
  }
});

test("ChatHost.saveMemories: 上限内なら刈り取りされない(memory.prunedも発火しない)", () => {
  const ws = mktmp();
  try {
    const bus = new Bus();
    const board = new Board(bus, "__main__", null);
    const tasks = new TaskBlackboard(join(ws, "tasks.jsonl"), bus);
    let prunedEvents = 0;
    bus.on("memory.pruned", () => prunedEvents++);
    const host = new ChatHost({
      mains: [{ id: "t2", displayName: "T2", role: "impl", personaText: "p" }],
      mainWorkspace: ws,
      modelFactory: () => null,
      toolsFactory: () => null,
      board, tasks, bus,
    });
    host.memories.set("t2", [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    host.saveMemories(host.mains[0]);
    assert.equal(prunedEvents, 0);
    assert.equal(host.memories.get("t2").length, 3);
    assert.ok(existsSync(join(ws, "state", "mem-t2.json")));
  } finally {
    cleanup(ws);
  }
});

test("ChatHost: config省略時は既定上限(200件/512KB)が効く", () => {
  const ws = mktmp();
  try {
    const bus = new Bus();
    const board = new Board(bus, "__main__", null);
    const tasks = new TaskBlackboard(join(ws, "tasks.jsonl"), bus);
    const host = new ChatHost({
      mains: [{ id: "t3", displayName: "T3", role: "impl", personaText: "p" }],
      mainWorkspace: ws,
      modelFactory: () => null,
      toolsFactory: () => null,
      board, tasks, bus,
    });
    assert.deepEqual(host.memPrune, { maxMessages: 200, maxBytes: 512 * 1024 });
  } finally {
    cleanup(ws);
  }
});
