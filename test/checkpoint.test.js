// ラウンドcheckpoint/resume(イシュー#4):
// ツール実行済みmessagesのスナップショットをラウンド中に保存し、モデル異常で中断した
// ラウンドがスナップショット地点から再開できること。state/checkpoint-<id>.json が土台。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { Board } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-checkpoint-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function waitUntil(cond, ms = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond() || Date.now() - t0 > ms) { clearInterval(timer); resolve(); }
    }, 20);
  });
}

test("checkpoint: モデル異常で中断したラウンドがスナップショット地点から再開する", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "cp");
  const tasks = new TaskBlackboard(ws, bus);
  const calls = []; // model.chat()に渡ったmessagesを記録
  let n = 0;
  const model = {
    maxTokens: 100,
    async chat({ messages }) {
      n++;
      calls.push(messages.map((m) => m.role));
      if (n === 1) {
        // 1回目: 1ターン目は応答するがツール実行後に2ターン目で死ぬ
        return { content: "", toolCalls: [{ name: "noop", args: {} }], raw: {} };
      }
      if (n === 2) throw new Error("モデルAPIが死んだ(テスト)");
      return { content: "復帰後の応答", toolCalls: [], raw: { content: "復帰後の応答" } };
    },
  };
  const agent = { id: "cp-lead", displayName: "シー", role: "lead", depth: 0, personaText: "# C" };
  const host = new ChatHost({
    mains: [agent],
    modelFactory: () => model,
    toolsFactory: () => ({
      specs: [{ name: "noop", description: "何もしない", parameters: { type: "object", properties: {} } }],
      execute: async () => ({ ok: true, text: "noop実行" }),
    }),
    board, tasks, bus, maxTurnsPerRound: 6, staggerMs: 0,
  });
  host.say("チェックポイント検証");
  // エラーで復元されるまで待つ(n>=2のmodel.chat失敗→スナップショット復元)
  let restored = null;
  bus.on("checkpoint.restored", (e) => { restored = e; });
  await waitUntil(() => restored !== null, 4000);
  assert.ok(restored, "モデル異常時にcheckpoint復元が走る");
  assert.equal(restored.agent, "cp-lead");
  assert.ok(restored.messages >= 3, "復元されたmessagesはスナップショット一式");
  // スナップショットは一度書かれて、復元時に削除される
  const cpFile = join(ws, "state", "checkpoint-cp-lead.json");
  assert.equal(existsSync(cpFile), false, "復元後はcheckpointを削除(失敗の無限ループ防止)");

  // 次のラウンドがスナップショット地点から再開する(kickoff二重積みなし)
  host.wake(agent, "[チャット] 続きをどうぞ");
  await waitUntil(() => n >= 3, 4000);
  await waitUntil(() => !host.roundState.get("cp-lead")?.running, 4000);
  const second = calls[2];
  assert.ok(second.includes("tool"), "復元後のラウンドにツール結果が引き継がれている");
  const mem = JSON.parse(readFileSync(join(ws, "state", "mem-cp-lead.json"), "utf8"));
  const continuations = mem.messages.filter((m) => m.role === "user" && m.content.includes("続きをどうぞ"));
  assert.equal(continuations.length, 1, "継続入力は1回だけ積まれる(スナップショットは置き換えなので二重化しない)");
  rmTree(ws);
});

test("checkpoint: モデル異常でもcheckpointFn未指定(ワーカー等)なら従来どおり動く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "cp2");
  const tasks = new TaskBlackboard(ws, bus);
  let n = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      n++;
      if (n === 1) throw new Error("即死(テスト)");
      return { content: "ok", toolCalls: [], raw: {} };
    },
  };
  const agent = { id: "w", displayName: "ダブ", role: "impl", depth: 1, personaText: "# W" };
  // runAgentLoopを直接使う形ではないが、ChatHostでもcheckpointはmainWorkspace有無に依存しない。
  // ここでは単純に、1発死ぬモデルでもラウンドが例外で落ちない(従来どおりエラー扱い)ことを確認。
  const host = new ChatHost({
    mains: [agent],
    modelFactory: () => model,
    toolsFactory: () => ({ specs: [], execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus, maxTurnsPerRound: 2, staggerMs: 0,
  });
  host.say("即死テスト");
  await waitUntil(() => n >= 1, 4000);
  await waitUntil(() => !host.roundState.get("w")?.running, 4000);
  assert.equal(existsSync(join(ws, "state", "checkpoint-w.json")), false, "スナップショット無しで終わったラウンドはcheckpointを残さない");
  rmTree(ws);
});
