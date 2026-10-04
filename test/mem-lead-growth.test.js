// 会話メモリ刈り取り(イシュー#20)の検証。
// (1)mem-*.jsonがラウンド間で上限(maxMessages/maxBytes)を超えない(超えたら古い分を刈り取り)
// (2)刈り取りヘッダ/保存済みボード参照には日時・ラベルが付き、番号単独の参照で再起動後の衝突を起こさない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatHost } from "../src/engine/chat.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { startDiscovery } from "../src/engine/discover.js";
import { pruneMemories, MEM_KEEP_RECENT, MEM_HEADER } from "../src/engine/compact.js";

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsロックは無視 */ }
}

function makeMain(id = "lead") {
  return { id, displayName: id, role: "lead", personaText: "x", scenarioName: "t" };
}

function makeController(ws, { memMaxMessages = 200, memMaxBytes = 512 * 1024 } = {}) {
  const bus = new Bus();
  const board = new Board(bus, "__main__");
  const tasks = new TaskBlackboard(ws);
  const mains = [makeMain()];
  const ctl = new ChatHost({
    mains,
    mainWorkspace: ws,
    modelFactory: () => ({ maxTokens: 10, chat: async () => ({ content: "ok", toolCalls: [], raw: {}, usage: {} }) }),
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus,
    config: { chat: { memMaxMessages, memMaxBytes } },
    staggerMs: 0,
  });
  return { ctl, mains, bus, board, tasks };
}

test("pruneMemories: maxMessages/maxBytes超過で古い分が刈られ、systemと直近は保護される", () => {
  const msgs = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `m${i}` })),
  ];
  const r = pruneMemories(msgs, { keepRecent: 5, maxMessages: 10, maxBytes: 10 * 1024 * 1024 });
  assert.equal(r.changed, true);
  assert.ok(r.removed >= 40);
  assert.equal(r.messages[0].role, "system");
  assert.ok(r.messages.length <= 10, `上限内に収まる: ${r.messages.length}`);
  assert.ok(r.messages[1].content.startsWith(MEM_HEADER), "刈り取りヘッダが入る");
  assert.match(r.messages[1].content, /\d{4}-\d{2}-\d{2}T/, "ヘッダに日時が付く(番号単独の参照を防ぐ)");
  // バイト上限: 保護枠(keepRecent)より古い巨大メッセージがあれば発動する
  const big = [
    { role: "system", content: "sys" },
    { role: "user", content: "x".repeat(600 * 1024) },
    { role: "assistant", content: "y".repeat(600 * 1024) },
    { role: "user", content: "z" },
  ];
  const r2 = pruneMemories(big, { keepRecent: 1, maxMessages: 200, maxBytes: 512 * 1024 });
  assert.equal(r2.changed, true, "バイト超過でも刈り取り発動");
  // 上限内なら非破壊
  const r3 = pruneMemories(msgs.slice(0, 5), { keepRecent: 5, maxMessages: 10, maxBytes: 512 * 1024 });
  assert.equal(r3.changed, false);
});

test("mem-*.jsonはラウンドをまたいで上限を超えない(刈り取りがin-memoryと永続の両方へ反映)", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-memprune-"));
  try {
    const { ctl, mains, board } = makeController(ws, { memMaxMessages: 12, memMaxBytes: 512 * 1024 });
    const main = mains[0];
    // 初期化
    ctl.memory(main);
    // 上限を大きく超えるメッセージを積む(ラウンド間の肥大を再現)。
    // 投稿参照は loop.js の実契約「from #id (ISO時刻/スレッド): text」と同じ形にする
    const mem = ctl.memory(main);
    const fmtAt = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16);
    for (let i = 0; i < 40; i++) {
      const pid = board.lastId() + 1;
      board.post("colleague", `ダミー投稿 ${i} ` + "x".repeat(200));
      mem.push({ role: "user", content: `[ボード新着]
colleague #${pid} (${fmtAt(Date.now())}/__main__): ダミー投稿 ${i} ` + "x".repeat(200) });
      mem.push({ role: "assistant", content: `応答 ${i}` });
    }
    ctl.saveMemories(main);
    const p = join(ws, "state", "mem-lead.json");
    assert.ok(existsSync(p));
    const saved = JSON.parse(readFileSync(p, "utf8"));
    assert.ok(saved.messages.length <= 12 + 1, `永続化ファイルも上限内: ${saved.messages.length}`);
    // in-memoryも同一(復元時に再肥大しない)
    assert.equal(ctl.memory(main).length, saved.messages.length);
    // 保存済みボード参照は「番号+投稿者ラベル+日時+スレッド」付きで記録される
    // (イシュー#20: 番号単独だと再起動後のid再採番で衝突するため)
    const boardRef = saved.messages.find((m) => typeof m.content === "string" && m.content.includes("[ボード新着]"));
    assert.ok(boardRef, "ボード参照メッセージが残る");
    assert.match(boardRef.content, /colleague #\d+ \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\/__main__\): ダミー投稿 \d+/, "番号+ラベル+日時+スレッド付きで保存される");
  } finally {
    rmTree(ws);
  }
});

test("memMaxMessages=0で刈り取り無効(config化の契約)", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-memoff-"));
  try {
    const { ctl, mains } = makeController(ws, { memMaxMessages: 0, memMaxBytes: 0 });
    assert.equal(ctl.memPrune.maxMessages, 0);
    assert.equal(ctl.memPrune.maxBytes, 0);
    const main = mains[0];
    ctl.memory(main);
    const mem = ctl.memory(main);
    for (let i = 0; i < 30; i++) mem.push({ role: "user", content: `d${i}` });
    ctl.saveMemories(main);
    const saved = JSON.parse(readFileSync(join(ws, "state", "mem-lead.json"), "utf8"));
    assert.ok(saved.messages.length >= 31, "無効化時は刈られない");
  } finally {
    rmTree(ws);
  }
});
