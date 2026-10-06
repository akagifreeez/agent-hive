// キャッシュヒット率集計(cache-hit-rate): usage-trace.jsonl(1行1ターン、cachedは
// プロバイダ未報告時null)から、日別・エージェント別のヒット率(cached÷prompt)を作る。
// 純関数 aggregateCacheHits を src/engine/usage.js に置き、UI(/api/usage-trace)・
// session-report・CLI(hive session)の3経路から共利用する。
// ルール: cachedがnullの行は分母・分子とも除外(0で扱わない。未報告と0の区別を保つ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateCacheHits } from "../src/engine/usage.js";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-cachehit-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

// usage-trace.jsonl を実データと同じ1行1ターン形式で書く
function seedTrace(ws, rows) {
  mkdirSync(join(ws, "state", "usage-trace"), { recursive: true });
  const lines = rows.map((r) => JSON.stringify({
    ts: "2026-10-06T00:00:00.000Z",
    agent: "w1", turn: 1,
    prompt: 1000, completion: 100, reasoning: 50,
    cached: null, ms: 0, tokPerSec: null, ctxChars: 4000, msgCount: 6,
    ...r,
  }));
  writeFileSync(join(ws, "state", "usage-trace", "usage-trace.jsonl"), lines.join("\n") + "\n");
}

test("aggregateCacheHits: cached÷promptを日別・エージェント別に集計する(合算率)", () => {
  const history = [
    // w1: prompt 1000 cached 500 + prompt 2000 cached 500 → (500+500)/(1000+2000)=1/3
    { ts: "2026-10-06T01:00:00.000Z", agent: "w1", prompt: 1000, cached: 500 },
    { ts: "2026-10-06T02:00:00.000Z", agent: "w1", prompt: 2000, cached: 500 },
    // w2: prompt 400 cached 100 → 0.25
    { ts: "2026-10-06T03:00:00.000Z", agent: "w2", prompt: 400, cached: 100 },
    // 翌日の行
    { ts: "2026-10-07T01:00:00.000Z", agent: "w1", prompt: 1000, cached: 250 },
  ];
  const r = aggregateCacheHits(history);
  assert.equal(r.byDate.length, 2, "日別は2日分");
  const d6 = r.byDate.find((d) => d.date === "2026-10-06");
  assert.ok(d6);
  assert.equal(d6.prompt, 3400, "日別の分母は全エージェント合算");
  assert.equal(d6.cached, 1100, "日別の分子も合算");
  assert.ok(Math.abs(d6.hitRatio - 1100 / 3400) < 1e-9, "ヒット率は合算値(cached÷prompt)");
  assert.equal(d6.calls, 3);
  // エージェント別(w1は日をまたいで合算)
  const w1 = r.byAgent.find((a) => a.agent === "w1");
  assert.equal(w1.prompt, 4000);
  assert.equal(w1.cached, 1250);
  assert.ok(Math.abs(w1.hitRatio - 0.3125) < 1e-9);
  assert.equal(w1.calls, 3);
  const w2 = r.byAgent.find((a) => a.agent === "w2");
  assert.ok(Math.abs(w2.hitRatio - 0.25) < 1e-9);
  // 日別xエージェント
  const key = (d, a) => d + "|" + a;
  const m = Object.fromEntries(r.matrix.map((x) => [key(x.date, x.agent), x]));
  assert.ok(Math.abs(m[key("2026-10-06", "w2")].hitRatio - 0.25) < 1e-9);
});

test("aggregateCacheHits: cachedがnullの行は分母・分子とも除外、cached=0の行は有効", () => {
  const history = [
    { ts: "2026-10-06T01:00:00.000Z", agent: "w1", prompt: 1000, cached: null }, // 未報告→除外
    { ts: "2026-10-06T02:00:00.000Z", agent: "w1", prompt: 1000, cached: 0 },    // 0は有効(命中率0)
    { ts: "2026-10-06T03:00:00.000Z", agent: "w1", cached: 100 },                 // prompt欠け→除外
    { ts: "2026-10-06T04:00:00.000Z", agent: "w1" },                              // 両方無し→除外
    { ts: "2026-10-06T05:00:00.000Z", agent: "w2", prompt: 0, cached: 0 },        // prompt=0は0除算防止で除外
  ];
  const r = aggregateCacheHits(history);
  const w1 = r.byAgent.find((a) => a.agent === "w1");
  assert.equal(w1.calls, 1, "有効行はcached=0の1行だけ");
  assert.equal(w1.prompt, 1000);
  assert.equal(w1.cached, 0);
  assert.equal(w1.hitRatio, 0, "cached=0は命中率0として有効(nullとは区別)");
  const w2 = r.byAgent.find((a) => a.agent === "w2");
  assert.equal(w2, undefined, "分母0の行だけで構成されるエージェントは出力しない");
  assert.equal(r.byDate.length, 1, "日別も有効行だけで作る");
  assert.equal(r.total.calls, 1);
});

test("aggregateCacheHits: 全行が無効なら空集算・壊れ行は無視(監査APIと同じ)", () => {
  assert.deepEqual(aggregateCacheHits(null), { byDate: [], byAgent: [], matrix: [], total: { calls: 0, prompt: 0, cached: 0, hitRatio: null } });
  assert.deepEqual(aggregateCacheHits("not-array"), { byDate: [], byAgent: [], matrix: [], total: { calls: 0, prompt: 0, cached: 0, hitRatio: null } });
  const r = aggregateCacheHits([
    { ts: "2026-10-06T01:00:00.000Z", agent: "w1", prompt: 100, cached: null },
    null,
    "not-object",
    { agent: "w1", prompt: 100, cached: 50 }, // ts無し(日付不明)→除外
  ]);
  assert.equal(r.byDate.length, 0);
  assert.equal(r.byAgent.length, 0);
  assert.equal(r.total.hitRatio, null, "有効行ゼロではヒット率も出ない(null)");
});

test("GET /api/usage-trace: cacheHits(日別・エージェント別ヒット率)を含む", async () => {
  const ws = mktmp();
  seedTrace(ws, [
    { ts: "2026-10-06T01:00:00.000Z", agent: "w1", turn: 1, prompt: 1000, cached: 500 },
    { ts: "2026-10-06T02:00:00.000Z", agent: "w1", turn: 2, prompt: 1000, cached: 250 },
    { ts: "2026-10-06T03:00:00.000Z", agent: "w2", turn: 1, prompt: 500, cached: null }, // 未報告は集計外
  ]);
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const r = await (await fetch(`${base}/api/usage-trace`)).json();
    assert.ok(r.cacheHits, "cacheHitsフィールドがある");
    const w1 = r.cacheHits.byAgent.find((a) => a.agent === "w1");
    assert.ok(w1);
    assert.ok(Math.abs(w1.hitRatio - 0.375) < 1e-9, "w1は(500+250)/(1000+1000)=0.375");
    assert.equal(r.cacheHits.byAgent.find((a) => a.agent === "w2"), undefined, "未報告行だけのエージェントは出ない");
    assert.ok(Math.abs(r.cacheHits.total.hitRatio - 0.375) < 1e-9);
    assert.equal(r.cacheHits.byDate.length, 1);
    // 低ヒット警告(閾値は定数): 0.375は既定閾値0.5未満でlow=true
    assert.equal(w1.low, true);
  } finally {
    ui.close();
    rmTree(ws);
  }
});

test("GET /api/usage-trace: cacheHitsはファイル無しでも空で200", async () => {
  const ws = mktmp();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const r = await (await fetch(`${base}/api/usage-trace`)).json();
    assert.equal(r.cacheHits.total.calls, 0);
    assert.deepEqual(r.cacheHits.byAgent, []);
    assert.deepEqual(r.cacheHits.byDate, []);
  } finally {
    ui.close();
    rmTree(ws);
  }
});
