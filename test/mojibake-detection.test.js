// fix-mojibake-detection(イシュー#20 提案3): U+FFFD(置換文字)入力の検知とリーダー警告
// ユーザー入力経路のどこかでエンコードが壊れるとテキストがU+FFFD(置換文字)へ化ける。
// 化けた入力をそのまま渡すとリーダーが断片から主題を推測して応答してしまうため、
// say()注入時に入力を検査し、注入文へ「推測で応答せず再送を求める」警告を明示する。
// 検知は U+FFFD に加え、UTF-8→cp932二重エンコードの兆候(典型パターン)も対象。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-moji-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function mkHost(ws) {
  const bus = new Bus();
  const board = new Board(bus, "cp");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "cp-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  const host = new ChatHost({
    mains: [agent], project: "cp", autoContinueRounds: 0, staggerMs: 0,
    board, tasks, bus, // 配線必須(board.lastId参照・タスク起床イベント)。抜けるとlastId参照エラー
    modelFactory: () => ({ maxTokens: 10, async chat() { return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 } }; } }),
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    autoStart: false,
  });
  return { host, board, bus, tasks, agent };
}

// lastKickoff(直近ラウンドの注入文)を取り出すwake登録ラッパ
function captureKickoff(host) {
  const captured = [];
  const orig = host.wake.bind(host);
  host.wake = (main, text, delay) => { captured.push(String(text)); return orig(main, text, delay); };
  return captured;
}

async function waitRunning(host, id, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const st = host.roundState.get(id);
    if (st && st.running) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("detectBrokenInput: U+FFFDを含む入力を検知する", async () => {
  const { detectBrokenInput } = await import("../src/engine/chat.js");
  assert.ok(detectBrokenInput("スラッシュコマンドが\uFFFD効かない"), "置換文字で検知");
  assert.ok(detectBrokenInput("\uFFFDTOK/s"), "先頭置換文字");
  assert.ok(!detectBrokenInput("ふつうの日本語入力です"), "正常文は検知しない");
  assert.ok(!detectBrokenInput("emoji 👍 ok"), "絵文字は置換文字ではない");
  assert.ok(!detectBrokenInput(""), "空は検知しない");
});

test("detectBrokenInput: UTF-8→cp932二重エンコードの兆候を検知する", async () => {
  const { detectBrokenInput } = await import("../src/engine/chat.js");
  // 「テスト」のUTF-8バイトをcp932として再解釈した際に生じる典型文字(テ→Ã、ス→1/2等の化けパターン)
  assert.ok(detectBrokenInput("Ã\u00A6\u00A5\u00B9\u00C8"), "ラテン文字+記号の塊パターン");
  // UTF-8の先頭バイトが単独で残る「ã」「å」等の文字で日本語混在は高確率で化け
  assert.ok(detectBrokenInput("ã\u0081¦ã\u0081™ã\u0081¨"), "ã塊");
  assert.ok(!detectBrokenInput("カタカナとひらがな"), "正常な日本語");
  assert.ok(!detectBrokenInput("Hello world 123"), "ASCII");
});

test("say(): U+FFFD入力時に注入文へ『入力が壊れている/推測禁止/再送指示』が付く", async () => {
  const ws = mktmp();
  try {
    const { host } = mkHost(ws);
    const captured = captureKickoff(host);
    host.say("UIのスラッシュコマンドが\uFFFD効かない");
    await waitRunning(host, "cp-lead");
        assert.equal(captured.length, 1);
    const t = captured[0];
    assert.ok(t.includes("壊れて"), "入力が壊れている旨を明示");
    assert.ok(t.includes("推測"), "推測で応答しないよう指示");
    assert.ok(t.includes("再送"), "ユーザーへの再送依頼を指示");
  } finally { rmTree(ws); }
});

test("say(): 正常入力の注入文は従来どおり(警告を付けない)", async () => {
  const ws = mktmp();
  try {
    const { host } = mkHost(ws);
    const captured = captureKickoff(host);
    host.say("ふつうの質問です");
    await waitRunning(host, "cp-lead");
    assert.equal(captured.length, 1);
    assert.ok(captured[0].includes("最優先"), "通常のユーザー入力優先文");
    assert.ok(!captured[0].includes("壊れて"), "警告文は付かない");
  } finally { rmTree(ws); }
});

test("say(): 破損検知時も本文はボードへ記録される(欠落させない)", async () => {
  const ws = mktmp();
  try {
    const { host, board } = mkHost(ws);
    host.say("\uFFFDな入力");
    await waitRunning(host, "cp-lead");
    const posts = board.posts.filter((p) => p.from === "you"); // Board契約: 投稿はposts配列(list()は無い)
    assert.ok(posts.some((p) => p.text.includes("\uFFFD")), "ユーザー入力の記録は残る");
  } finally { rmTree(ws); }
});
