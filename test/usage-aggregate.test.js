// コスト集計の日別・スレッド別ビュー(GitHubイシュー#6):
// usage.round / usage.summary に日付+スレッド名を付けて state/usage.json へ蓄積し、
// /api/usage が集計ビュー(byDate / byThread / 日別×スレッドのマトリクス)を返す。
// UIのusageタブ(status)に日別・スレッド別の集計表を表示する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { aggregateUsage } from "../src/engine/usage.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";

tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-usageagg-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

// 既存のUI起動ヘルパー(budget-alert.test.jsと同じ形)
async function setup() {
  const ws = mktmp();
  const bus = new Bus();
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUiTokenized(startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const getUsage = async () => (await (await fetch(`${base}/api/usage`)).json());
  return { ws, bus, ui, getUsage };
}

test("aggregateUsage: usage.jsonから日別・スレッド別・日別xスレッドの集計を作る", () => {
  const now = new Date();
  const d = (offsetDays, hour) => {
    const t = new Date(now);
    t.setDate(t.getDate() - offsetDays);
    t.setHours(hour, 0, 0, 0);
    return t.toISOString();
  };
  const history = [
    { at: d(0, 10), agent: "lead", endedBy: "ok", totals: { calls: 2, promptTokens: 100, completionTokens: 50, reasoningTokens: 10, costUsd: 0.2 } },
    { at: d(0, 15), agent: "issue-x-alpha", endedBy: "turn-limit", totals: { calls: 3, promptTokens: 200, completionTokens: 80, reasoningTokens: 20, costUsd: 0.4 } },
    { at: d(1, 9), agent: "issue-x-alpha", endedBy: "ok", totals: { calls: 1, promptTokens: 300, completionTokens: 120, reasoningTokens: 30, costUsd: 0.6 } },
    { at: d(1, 9), totals: { calls: 5, promptTokens: 1000, completionTokens: 500, reasoningTokens: 0, costUsd: 1.0 } }, // summary(agent無し)=集計対象外(二重計上防止)
    // thread付き(スレッドチャットのusage.round)
    { at: d(0, 11), thread: "issue-x", agent: "issue-x-alpha", endedBy: "ok", totals: { calls: 1, promptTokens: 40, completionTokens: 20, reasoningTokens: 0, costUsd: 0.1 } },
    { at: d(1, 12), thread: "issue-x", agent: "issue-x-beta", endedBy: "ok", totals: { calls: 3, promptTokens: 60, completionTokens: 30, reasoningTokens: 0, costUsd: 0.3 } },
    { at: "不正な日付", totals: { calls: 9, costUsd: 9 } },
    null,
  ];
  const agg = aggregateUsage(history, { days: 14 });
  // 日別(新しい順)
  assert.ok(agg.byDate.length >= 2);
  assert.equal(agg.byDate[0].date, now.toISOString().slice(0, 10), "1件目は今日");
  const today = agg.byDate[0];
  assert.equal(today.calls, 6);
  assert.ok(Math.abs(today.costUsd - 0.7) < 1e-9, 'costUsd合計(浮動小数は接近比較)');
  assert.equal(today.promptTokens, 340);
  assert.equal(today.completionTokens, 150);
  assert.equal(today.reasoningTokens, 30);
  // スレッド別
  const th = Object.fromEntries(agg.byThread.map((r) => [r.thread, r]));
  assert.equal(th["__main__"].calls, 2, "mainはusage.roundの積み上げのみ(summaryは二重計上になるため集計対象外)");
  assert.ok(Math.abs(th["__main__"].costUsd - 0.2) < 1e-9, "mainのcost合計");
  assert.equal(th["issue-x"].calls, 8, "issue-xは4レコード分(3+1+1+3)");
  assert.ok(Math.abs(th["issue-x"].costUsd - 1.4) < 1e-9, "issue-xのcost合計");
  assert.ok(!th["__main__"].agentIds.includes("issue-x-alpha"), "スレッド別のエージェント一覧は自分のスレッド分だけ");
  assert.ok(th["issue-x"].agentIds.includes("issue-x-alpha"));
  // 日別xスレッド
  const key = (date, thread) => `${date}|${thread}`;
  const m = Object.fromEntries(agg.matrix.map((r) => [key(r.date, r.thread), r]));
  // 今日のスレッド別内訳: __main__はleadラウンドのみ(calls=2)、issue-xはalpha(推測)3+thread付き1で4
  const todayMain = m[key(now.toISOString().slice(0, 10), "__main__")];
  assert.ok(todayMain && todayMain.calls === 2, "今日のmain分はleadラウンドのみ(summaryは昨日)");
});

test("aggregateUsage: 空や形状不良のhistoryでも安全に空集計を返す", () => {
  assert.deepEqual(aggregateUsage(null), { byDate: [], byThread: [], matrix: [] });
  assert.deepEqual(aggregateUsage("not-array"), { byDate: [], byThread: [], matrix: [] });
  const agg = aggregateUsage([{ at: "不正", totals: null }]);
  assert.deepEqual(agg.byDate, []);
  assert.deepEqual(agg.byThread, []);
  assert.deepEqual(agg.matrix, []);
});

test("usage.json: usage.round/summaryの蓄積に日付とスレッド名が付き、旧形式とも共存する", async () => {
  const { ws, bus, ui, getUsage } = await setup();
  try {
    bus.emit("usage.round", { agent: "lead", endedBy: "ok", totals: { calls: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.1 } });
    bus.emit("usage.round", { agent: "issue-y-alpha", thread: "issue-y", endedBy: "ok", totals: { calls: 2, promptTokens: 20, completionTokens: 8, reasoningTokens: 2, costUsd: 0.2 } });
    bus.emit("usage.summary", { byAgent: {}, totals: { calls: 3, costUsd: 0.3 } });

    const file = join(ws, "state", "usage.json");
    assert.ok(existsSync(file), "usage.jsonが作られる");
    const history = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(history.length, 3);
    const r1 = history.find((h) => h.agent === "lead");
    assert.ok(r1.thread === "__main__" && r1.date === new Date().toISOString().slice(0, 10), "mainのusage.roundにthread=__main__と日付が付く");
    const r2 = history.find((h) => h.agent === "issue-y-alpha");
    assert.equal(r2.thread, "issue-y", "スレッドのusage.roundにthread名が付く");
    assert.ok(r2.date, "日付が付く");
    const s = history.find((h) => h.totals && !h.agent);
    assert.equal(s.thread, "__main__", "usage.summaryはメインボードの消費として記録");
    assert.ok(s.date, "summaryにも日付が付く");

    // /api/usageが集計ビューを返す(旧契約のusage raw文字列も維持)
    const { usage, aggregate } = await getUsage();
    assert.equal(typeof usage, "string", "旧契約: usageはusage.jsonのraw文字列");
    assert.ok(aggregate && Array.isArray(aggregate.byDate) && Array.isArray(aggregate.byThread) && Array.isArray(aggregate.matrix));
    const th = Object.fromEntries(aggregate.byThread.map((r) => [r.thread, r]));
    assert.equal(th["issue-y"].calls, 2);
    assert.equal(th["issue-y"].costUsd, 0.2);
    assert.equal(th["__main__"].calls, 1, "mainはusage.roundのみ(summaryは二重計上のため対象外)");
    assert.equal(th["__main__"].costUsd, 0.1);
  } finally {
    try { ui.close(); } catch {}
    rmTree(ws);
  }
});
