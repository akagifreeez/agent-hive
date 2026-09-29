// usage-trace可視化(GitHubイシュー#15)のAPI側テスト:
// GET /api/usage-trace が state/usage-trace/usage-trace.jsonl を解析し、
// ワーカー別・ターン別のトークン消費推移(series/points)とサマリを返すこと。
// agentフィルタ・turn範囲(fromTurn/toTurn)の指定も受け付ける。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-usagetrace-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mkConfig(ws) {
  return { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
}

async function fetchJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

// トレースJSONLを書く(実データと同じ1行1ターン形式)
function seedTrace(ws, rows) {
  mkdirSync(join(ws, "state", "usage-trace"), { recursive: true });
  const lines = rows.map((r) => JSON.stringify({
    ts: "2026-09-14T00:00:00.000Z",
    agent: "w1", turn: 1,
    prompt: 1000, completion: 100, reasoning: 50,
    ctxChars: 4000, msgCount: 6,
    ...r,
  }));
  writeFileSync(join(ws, "state", "usage-trace", "usage-trace.jsonl"), lines.join("\n") + "\n");
}

test("GET /api/usage-trace: ワーカー別・ターン別のseriesとサマリを返す", async () => {
  const ws = mktmp();
  seedTrace(ws, [
    { agent: "w1", turn: 1, prompt: 1200, completion: 200, reasoning: 50, ts: "2026-09-14T01:00:00.000Z" },
    { agent: "w1", turn: 2, prompt: 2400, completion: 300, reasoning: 80, ts: "2026-09-14T01:01:00.000Z" },
    { agent: "w2", turn: 1, prompt: 500, completion: 40, reasoning: 0, ts: "2026-09-14T01:02:00.000Z" },
  ]);
  const config = mkConfig(ws);
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const r = await fetchJson(`${base}/api/usage-trace`);
    assert.equal(r.status, 200);
    // ワーカー別の系列: agent/points(ターン順)/totalTokens
    assert.equal(r.body.series.length, 2);
    const w1 = r.body.series.find((s) => s.agent === "w1");
    assert.ok(w1);
    assert.equal(w1.points.length, 2);
    assert.equal(w1.points[0].turn, 1);
    assert.equal(w1.points[0].totalTokens, 1450); // 1200+200+50
    assert.equal(w1.points[1].totalTokens, 2780); // 2400+300+80
    assert.equal(w1.totalTokens, 4230);
    // 内訳も持つ
    assert.equal(w1.points[1].prompt, 2400);
    assert.equal(w1.points[1].completion, 300);
    assert.equal(w1.points[1].reasoning, 80);
    // サマリ
    assert.equal(r.body.total.turns, 3);
    assert.equal(r.body.total.totalTokens, 4770); // 4230 + 540
    assert.deepEqual(r.body.total.byAgent, { w1: 4230, w2: 540 });
    // 最新のtsが分かる(いつまでのデータか)
    assert.equal(r.body.lastTs, "2026-09-14T01:02:00.000Z");
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("GET /api/usage-trace: agentフィルタとturn範囲(fromTurn/toTurn)で絞れる", async () => {
  const ws = mktmp();
  seedTrace(ws, [
    { agent: "w1", turn: 1, prompt: 100 },
    { agent: "w1", turn: 2, prompt: 200 },
    { agent: "w2", turn: 1, prompt: 300 },
    { agent: "w1", turn: 5, prompt: 400 },
    { agent: "w1", turn: 9, prompt: 500 },
  ]);
  const config = mkConfig(ws);
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    // agentフィルタ
    const r1 = await fetchJson(`${base}/api/usage-trace?agent=w1`);
    assert.equal(r1.body.series.length, 1);
    assert.equal(r1.body.series[0].agent, "w1");
    assert.equal(r1.body.series[0].points.length, 4);
    // turn範囲
    const r2 = await fetchJson(`${base}/api/usage-trace?fromTurn=2&toTurn=5`);
    assert.deepEqual(r2.body.series.map((s) => s.agent).sort(), ["w1", "w2"]);
    const w1 = r2.body.series.find((s) => s.agent === "w1");
    assert.deepEqual(w1.points.map((p) => p.turn), [2, 5]);
    // agent+範囲の併用
    const r3 = await fetchJson(`${base}/api/usage-trace?agent=w2&fromTurn=2`);
    assert.equal(r3.body.series.length, 0);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("GET /api/usage-trace: ファイルが無くても空応答で200(壊れ行はスキップ)", async () => {
  const ws = mktmp();
  const config = mkConfig(ws);
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const r = await fetchJson(`${base}/api/usage-trace`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.series, []);
    assert.deepEqual(r.body.total.byAgent, {});
    // 壊れ行混在: パース出来る行だけ採用
    mkdirSync(join(ws, "state", "usage-trace"), { recursive: true });
    writeFileSync(join(ws, "state", "usage-trace", "usage-trace.jsonl"),
      "{broken json\n" + JSON.stringify({ ts: "2026-09-14T00:00:00.000Z", agent: "w9", turn: 3, prompt: 10, completion: 0, reasoning: 0, ctxChars: 1, msgCount: 1 }) + "\n");
    const r2 = await fetchJson(`${base}/api/usage-trace`);
    assert.equal(r2.body.series.length, 1);
    assert.equal(r2.body.series[0].agent, "w9");
    assert.equal(r2.body.total.turns, 1);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("UI: usageタブにトレースセクションがあり、/api/usage-traceから描画する", async () => {
  // 静的確認(index.htmlは生JSのためソースパターンで担保。budget-alert-ui.test.jsと同じ方式)
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");
  // データ源API
  assert.match(html, /\/api\/usage-trace/);
  // セクション見出しとフィルタ UI
  assert.match(html, /トレース/);
  assert.match(html, /usageTraceFilter|usage-trace-filter/);
});
