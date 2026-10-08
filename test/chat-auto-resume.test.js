// 停止後の自動再開(autoResume)のテスト。
// 「続けて」待ちで誰も動かない無駄時間を、仕事が残る停止に限り delaySec 後に自動で起こし直す。
// 連続回数はmaxConsecutiveで抑え、着地(進捗)と外部起点のwakeで予算が回復することを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost, normalizeAutoResume } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-aresume-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}
async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

function scriptedModel(steps, calls) {
  let i = 0;
  return {
    maxTokens: 100,
    async chat() {
      calls.push(i);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === "string"
        ? { content: step, toolCalls: [], raw: { content: step }, usage: { promptTokens: 1, completionTokens: 1 } }
        : { content: "", toolCalls: step.toolCalls ?? [], raw: { content: "" }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

function mkHost({ steps, project, autoResume, maxTurnsPerRound = 1, landingSignal = null }) {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "aresume");
  const tasks = new TaskBlackboard(ws, bus);
  const calls = [];
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const host = new ChatHost({
    mains: [agent],
    mainWorkspace: null,
    project,
    autoContinueRounds: 3,
    maxTurnsPerRound,
    staggerMs: 0,
    autoResume,
    landingSignal,
    modelFactory: (() => { const m = scriptedModel(steps, calls); return () => m; })(),
    toolsFactory: (a) => createTools({ agent: a, workspace: ws, mainWorkspace: null, board, tasks, bus }),
    board, tasks, bus,
  });
  return { host, board, tasks, calls, cleanup: () => rmTree(ws) };
}

test("自動再開: 仕事が残る停止はdelaySec後に再開し、上限で止まる", async () => {
  const { host, board, tasks, calls, cleanup } = mkHost({
    project: "ar-basic",
    steps: [{ toolCalls: [] }], // 毎ラウンドturn-limitで終わる(着地ゼロ)
    autoResume: { enabled: true, delaySec: 0, maxConsecutive: 1 },
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t1", body: "担当", project: "ar-basic" });
    host.say("着手してください");
    // 1ラウンド目が着地ゼロ停止→自動再開→2ラウンド目→予算切れで止まる
    assert.ok(await waitUntil(() => calls.length >= 2), "自動再開で2ラウンド目が走る");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "予算切れで停止");
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(calls.length >= 2 && calls.length < 4, "上限(1回)を超えて再開しない: " + calls.length);
    assert.ok(board.posts.some((p) => p.text.includes("[自動再開停止]")), "上限到達の告知がボードへ流れる");
    assert.ok(board.posts.some((p) => p.text.includes("[自動継続停止(着地ゼロ(進捗なし))]")), "従来の停止告知も維持");
  } finally {
    host.dispose();
    cleanup();
  }
});

test("自動再開: 仕事が無くなったら再開しない", async () => {
  const { host, tasks, calls, cleanup } = mkHost({
    project: "ar-nowork",
    steps: [{ toolCalls: [{ name: "finish_task", arguments: { task_id: "t1" } }] }],
    autoResume: { enabled: true, delaySec: 0, maxConsecutive: 3 },
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t1", body: "担当", project: "ar-nowork" });
    host.say("完了させてください");
    // finish_taskで着地→タスク消滅。停止時に仕事が無ければ再開しない
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("alpha");
      return st && !st.running;
    }), "ラウンド完走");
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, before, "仕事が無いので自動再開しない");
  } finally {
    host.dispose();
    cleanup();
  }
});

test("自動再開: 着地(進捗)があれば予算が回復し再開を続ける", async () => {
  let landed = true; // 常に着地ありを報せる(ハード上限停止+予算回復の経路)
  const { host, tasks, calls, cleanup } = mkHost({
    project: "ar-landed",
    steps: [{ toolCalls: [] }],
    autoResume: { enabled: true, delaySec: 0, maxConsecutive: 1 },
    landingSignal: () => landed,
  });
  try {
    tasks.assign({ agentId: "alpha", taskId: "t9", body: "担当", project: "ar-landed" }); // hasWork=trueを保つ
    host.say("着手してください");
    // 着地あり停止→再開(予算回復)→また停止→再開…と進み続ける(上限1でも複数回再開する)
    assert.ok(await waitUntil(() => calls.length >= 5), "着地で予算が回復し再開を繰り返す: " + calls.length);
  } finally {
    host.dispose();
    cleanup();
  }
});

test("自動再開: 設定の正規化(無効既定・範囲clamp)", () => {
  assert.equal(normalizeAutoResume(null).enabled, false, "未設定は無効");
  assert.equal(normalizeAutoResume({ enabled: true, delaySec: -5 }).delaySec, 0, "下限0にclamp");
  assert.equal(normalizeAutoResume({ enabled: true, maxConsecutive: 99 }).maxConsecutive, 10, "上限10にclamp");
  const d = normalizeAutoResume({ enabled: true });
  assert.deepEqual([d.delaySec, d.maxConsecutive], [120, 3], "既定値");
});
