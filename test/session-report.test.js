// 裏ログ集計(G2・dsh-vs-hive比較doc): summarizeSessionDirの集計とAPI(/api/session-report)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSessionDir } from "../src/engine/session-report.js";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-sessionreport-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

function writeLog(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("session-report: エージェント別に呼出/失敗/圧縮/トークンを集計する", async () => {
  const ws = mktmp();
  const dir = join(ws, "state", "session-log");
  writeLog(dir, [
    { ts: "2026-10-06T10:00:00Z", agent: "lead", turn: 1, kind: "chat", request: {}, response: { content: "a", usage: { promptTokens: 1000, completionTokens: 50, reasoningTokens: 10, cachedTokens: 800 } }, ms: 1000 },
    { ts: "2026-10-06T10:01:00Z", agent: "lead", turn: 2, kind: "chat", request: {}, error: "クォータ上限に到達しました", ms: 500 },
    { ts: "2026-10-06T10:02:00Z", agent: "lead", turn: 2, kind: "compact", request: {}, response: { content: "要約", usage: { promptTokens: 9000, completionTokens: 100, cachedTokens: null } }, ms: 3000 },
    { ts: "2026-10-06T10:03:00Z", agent: "alpha", turn: 1, kind: "chat", request: {}, response: { content: "b", usage: { promptTokens: 100, completionTokens: 20 } }, ms: 2000 },
  ]);
  const r = await summarizeSessionDir(dir);
  assert.equal(r.scanned, 4);
  assert.equal(r.files, 1);
  const lead = r.agents.find((a) => a.agent === "lead");
  const alpha = r.agents.find((a) => a.agent === "alpha");
  assert.equal(lead.calls, 2);
  assert.equal(lead.errors, 1);
  assert.equal(lead.compactions, 1);
  assert.equal(lead.promptTokens, 10000);
  assert.equal(lead.completionTokens, 150);
  assert.equal(lead.cachedTokens, 800, "cachedは数値のみ加算(nullは無視)");
  assert.equal(lead.cacheHitRatio, 0.08, "cached/promptの命中率(GLM形はpromptにcachedを含む)");
  // 失敗attemptのmsも計測に含む(呼出に掛かった実時間として)。小数1桁に丸めて返す
  assert.equal(lead.tokPerSec, 33.3);
  assert.equal(lead.firstTs, "2026-10-06T10:00:00Z");
  assert.equal(lead.lastTs, "2026-10-06T10:02:00Z");
  assert.equal(alpha.cachedTokens, null, "未報告はnullのまま");
  assert.equal(alpha.cacheHitRatio, null);
  rmTree(ws);
});

test("session-report: cacheHits(日別・エージェント別ヒット率。cached未報告行は除外)", async () => {
  const ws = mktmp();
  const dir = join(ws, "state", "session-log");
  writeLog(dir, [
    // lead: prompt 1000+2000, cached 500+500 → 0.333(日跨ぎ無しでも日別1行)
    { ts: "2026-10-06T10:00:00Z", agent: "lead", kind: "chat", request: {}, response: { usage: { promptTokens: 1000, completionTokens: 10, cachedTokens: 500 } }, ms: 100 },
    { ts: "2026-10-06T10:01:00Z", agent: "lead", kind: "chat", request: {}, response: { usage: { promptTokens: 2000, completionTokens: 10, cachedTokens: 500 } }, ms: 100 },
    // cached未報告(null)の行は分母・分子とも除外
    { ts: "2026-10-06T10:02:00Z", agent: "lead", kind: "chat", request: {}, response: { usage: { promptTokens: 9000, completionTokens: 10, cachedTokens: null } }, ms: 100 },
    // alpha: 未報告のみ → byAgentに出ない
    { ts: "2026-10-06T10:03:00Z", agent: "alpha", kind: "chat", request: {}, response: { usage: { promptTokens: 100, completionTokens: 10 } }, ms: 100 },
  ]);
  const r = await summarizeSessionDir(dir);
  assert.ok(r.cacheHits, "cacheHitsフィールドがある");
  const lead = r.cacheHits.byAgent.find((a) => a.agent === "lead");
  assert.ok(lead, "未報告行だけのエージェントは出ず、有効行のあるleadは出る");
  assert.equal(lead.calls, 2, "null行は集計から除外される");
  assert.equal(lead.prompt, 3000);
  assert.equal(lead.cached, 1000);
  assert.ok(Math.abs(lead.hitRatio - 1000 / 3000) < 0.001, "小数3桁丸めなので誤差0.001許容");
  assert.equal(lead.low, true, "既定閾値0.5未満はlow");
  assert.equal(r.cacheHits.byAgent.find((a) => a.agent === "alpha"), undefined, "cachedが全て未報告のエージェントは出ない");
  assert.equal(r.cacheHits.byDate.length, 1);
  assert.equal(r.cacheHitLowThreshold, 0.5, "閾値定数を同梱(UI/CLIがハードコードせず参照)");
  assert.ok(Math.abs(r.cacheHits.total.hitRatio - 1000 / 3000) < 0.001, "小数3桁丸めなので誤差0.001許容");
  assert.equal(r.cacheHitLowThreshold, 0.5, "閾値定数も応答に載る(UI/CLIで共利用)");
  rmTree(ws);
});

test("session-report: maxRecordsで打ち切る", async () => {
  const ws = mktmp();
  const dir = join(ws, "state", "session-log");
  writeLog(dir, Array.from({ length: 10 }, (_, i) => ({ ts: "t", agent: `a${i}`, kind: "chat", request: {}, response: { usage: { promptTokens: 1, completionTokens: 1 } }, ms: 1 })));
  const r = await summarizeSessionDir(dir, { maxRecords: 3 });
  assert.equal(r.scanned, 3);
  assert.equal(r.agents.length, 3);
  rmTree(ws);
});

test("session-report: ログが無ければ空結果(例外にしない)", async () => {
  const r = await summarizeSessionDir(join(mktmp(), "state", "session-log"));
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.agents, []);
  assert.equal(r.files, 0);
});

test("GET /api/session-report: 裏ログの集計がAPIで読める", async () => {
  const ws = mktmp();
  writeLog(join(ws, "state", "session-log"), [
    { ts: "t1", agent: "lead", turn: 1, kind: "chat", request: {}, response: { content: "x", usage: { promptTokens: 10, completionTokens: 2 } }, ms: 100 },
  ]);
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
  const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const res = await fetch(`${base}/api/session-report`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scanned, 1);
    assert.equal(body.agents[0].agent, "lead");
    assert.equal(body.agents[0].calls, 1);
    const resLimited = await fetch(`${base}/api/session-report?maxRecords=1`);
    assert.equal((await resLimited.json()).window, 1);
  } finally {
    ui.close();
    rmTree(ws);
  }
});
