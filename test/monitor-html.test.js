// モニタページとチャートの統合検証(GitHubイシュー#16):
// HTMLにscript参照・チャート領域が入り、/monitor-chart.jsが配信され、
// /api/monitorスナップショットでチャートが更新できること(3秒間隔はUI側setInterval)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-monchart-"));
}

test("monitor HTML: チャートscript参照とチャート領域生成コードを含む", async () => {
  const ws = mktmp();
  try {
    const config = { workspace: ws, ui: { port: 0, monitorPort: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const html = await (await fetch(`http://127.0.0.1:${config.ui.monitorPort}/`)).text();
      assert.ok(html.includes('<script src="/monitor-chart.js">'), "チャート描画器を読み込む");
      assert.ok(html.includes("renderCharts"), "チャート描画を呼ぶコードがある");
      assert.ok(html.includes("setInterval(tick,3000)"), "3秒ごとに更新(イシュー#16の受け入れ基準)");
      assert.ok(html.includes("エージェント数・タスク進捗の推移"), "チャート見出し");
    } finally { ui.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("monitor: /monitor-chart.jsが配信され、monitorChart APIを公開する", async () => {
  const ws = mktmp();
  try {
    const config = { workspace: ws, ui: { port: 0, monitorPort: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const r = await fetch(`http://127.0.0.1:${config.ui.monitorPort}/monitor-chart.js`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /javascript/);
      const code = await r.text();
      const mc = new Function(code + "\n;return monitorChart;")();
      assert.equal(typeof mc.renderChartSvg, "function");
      assert.equal(typeof mc.renderTokenBarsSvg, "function");
      assert.equal(typeof mc.pushSample, "function");
    } finally { ui.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("monitor: /api/monitorのスナップショットがチャート入力形式を満たす", async () => {
  const ws = mktmp();
  try {
    const config = { workspace: ws, ui: { port: 0, monitorPort: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const bus = new Bus();
    const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
    try {
      const snap = await (await fetch(`http://127.0.0.1:${config.ui.monitorPort}/api/monitor`)).json();
      assert.ok(Array.isArray(snap.agents), "agents配列(エージェント数の源)");
      assert.ok(snap.tasks && Array.isArray(snap.tasks.open), "tasks.open配列");
      assert.ok(Array.isArray(snap.tasks.claimed), "tasks.claimed配列");
      assert.equal(typeof snap.tasks.doneCount, "number", "tasks.doneCount(タスク進捗の源)");
      // sampleFromSnapshotで履歴サンプルが作れる(実行時契約)
      const code = await (await fetch(`http://127.0.0.1:${config.ui.monitorPort}/monitor-chart.js`)).text();
      const mc = new Function(code + "\n;return monitorChart;")();
      const sample = mc.sampleFromSnapshot(snap);
      assert.deepEqual(Object.keys(sample).sort(), ["agents", "claimed", "done", "open", "tokens"]);
    } finally { ui.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
