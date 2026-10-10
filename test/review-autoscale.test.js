// 検証滞留の自動増員の検証: role:review固定タスクの滞留で検証係(reviewロール)が
// 1体だけスポーンされること・稼働中の検証係がいれば追加増員しないこと・
// しきい値未満/しきい値0で増員しないこと。
// 観測点: autoscaleTick()を明示呼び出し(interval依存を避ける)し、agent.spawnedイベントの
// roleを見る。モデルはゲートで止めて検証係の稼働状態(working)を確定的に保持する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

// スレッドのmainはalpha(impl)1体にする(検証役betaを置くとタスク起票の起床で
// reviewロールのラウンドが走り、reviewBusy判定が増員を握って検証できなくなるため)
function mkConfig(ws, extraChat = {}) {
  return {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    hierarchy: { maxDepth: 2, maxConcurrent: 8 },
    chat: {
      lead: "lead", workers: ["alpha"],
      maxTurnsPerRound: 8, staggerMs: 0,
      autoscale: false, // autoscaleTick()を明示呼び出しして確定的に検証する
      ...extraChat,
    },
    agents: [
      { id: "lead", displayName: "リーダー", role: "lead" },
      { id: "alpha", displayName: "アルファ", role: "impl" },
    ],
  };
}

// 応答をゲートで止めるモデル(検証係を稼働中のまま確定的に保持する)
function blockedModelFactory(gate) {
  return {
    maxTokens: 4000,
    async chat() {
      await gate;
      return { content: "応答", toolCalls: [], raw: { content: "応答" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
}

function mkGate() {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  return { gate, release: () => release?.() };
}

test("検証滞留の自動増員: reviewタスク3件で検証係が1体スポーンされ、稼働中は追加増員しない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-rvasc-"));
  const { gate, release } = mkGate();
  const config = mkConfig(ws);
  const bus = new Bus();
  const ctl = await runChat({ config, bus, modelFactory: () => blockedModelFactory(gate) });
  const spawned = [];
  bus.on("agent.spawned", (p) => spawned.push(p.agent));
  try {
    const opened = await ctl.openThread({ project: "rva", goal: "検証係自動増員の検証" });
    assert.equal(opened.error, undefined, "スレッドが開ける: " + String(opened?.error ?? ""));
    // しきい値(既定3)未満では増員しない
    for (const id of ["verify-rva-a", "verify-rva-b"]) {
      assert.ok(ctl.tasks.create({ id, role: "review", project: "rva", body: "検証タスク" }), id + "起票");
    }
    await ctl.autoscaleTick();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spawned.filter((a) => a.role === "review").length, 0, "しきい値未満では増員しない");
    // 3件到達で増員される
    assert.ok(ctl.tasks.create({ id: "verify-rva-c", role: "review", project: "rva", body: "検証タスク" }), "3件目起票");
    await ctl.autoscaleTick();
    assert.ok(
      await waitUntil(() => spawned.some((a) => a.role === "review")),
      "検証係(reviewロール)がスポーンされた"
    );
    const reviews = spawned.filter((a) => a.role === "review");
    assert.equal(reviews.length, 1, "1tick1体: " + reviews.map((a) => a.id).join(","));
    assert.equal(reviews[0].thread, "rva", "滞留スレッドへ増員される");
    // 検証係が稼働中の間は2体目を増員しない
    await ctl.autoscaleTick();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spawned.filter((a) => a.role === "review").length, 1, "稼働中の検証係がいれば追加増員しない");
  } finally {
    release();
    await waitUntil(() => ctl.manager.live.size === 0, 15000); // ワーカー退場まで待ってから掃除
    rmTree(ws); rmTree(ws + "-wt");
  }
});

test("検証滞留の自動増員: reviewBacklogThreshold=0で無効", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-rvoff-"));
  const { gate, release } = mkGate();
  const config = mkConfig(ws, { reviewBacklogThreshold: 0 });
  const bus = new Bus();
  const ctl = await runChat({ config, bus, modelFactory: () => blockedModelFactory(gate) });
  const spawned = [];
  bus.on("agent.spawned", (p) => spawned.push(p.agent));
  try {
    const opened = await ctl.openThread({ project: "rvoff", goal: "無効設定の検証" });
    assert.equal(opened.error, undefined);
    for (const id of ["verify-rvoff-a", "verify-rvoff-b", "verify-rvoff-c", "verify-rvoff-d"]) {
      assert.ok(ctl.tasks.create({ id, role: "review", project: "rvoff", body: "検証タスク" }), id + "起票");
    }
    await ctl.autoscaleTick();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spawned.filter((a) => a.role === "review").length, 0, "しきい値0では増員しない");
  } finally {
    release();
    await waitUntil(() => ctl.manager.live.size === 0, 15000);
    rmTree(ws); rmTree(ws + "-wt");
  }
});
