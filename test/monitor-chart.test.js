// モニタ用SVGチャート描画器の検証(ブラウザ相当のグローバルで評価/markdown.test.jsと同じパターン)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const code = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "public", "monitor-chart.js"),
  "utf8",
);
const mc = new Function(code + "\n;return monitorChart;")();

test("sampleFromSnapshot: スナップショットから履歴サンプルへ変換する", () => {
  const s = mc.sampleFromSnapshot({
    agents: [{ tokens: 100 }, { tokens: 250 }, { tokens: 0 }],
    tasks: { open: [1, 2], claimed: [3], doneCount: 9 },
  });
  assert.equal(s.agents, 3);
  assert.equal(s.open, 2);
  assert.equal(s.claimed, 1);
  assert.equal(s.done, 9);
  assert.equal(s.tokens, 350);
});

test("sampleFromSnapshot: 形状不良でも安全に0扱い", () => {
  const s = mc.sampleFromSnapshot({});
  assert.deepEqual(s, { agents: 0, open: 0, claimed: 0, done: 0, tokens: 0 });
  const s2 = mc.sampleFromSnapshot(null);
  assert.deepEqual(s2, { agents: 0, open: 0, claimed: 0, done: 0, tokens: 0 });
});

test("pushSample: 履歴は最大60件に制限される", () => {
  const hist = [];
  for (let i = 0; i < 70; i++) {
    mc.pushSample(hist, { agents: [{ tokens: i }], tasks: { open: [], claimed: [], doneCount: i } });
  }
  assert.equal(hist.length, mc.MAX_POINTS);
  assert.equal(hist[0].done, 10); // 古いサンプルが落ちている(70-60=10番目から)
  assert.equal(hist[59].done, 69);
});

test("chartModel: 折れ線の座標がY軸スケールに沿って並ぶ", () => {
  const hist = [
    { agents: 0, open: 0, claimed: 0, done: 0, tokens: 0 },
    { agents: 2, open: 1, claimed: 1, done: 2, tokens: 100 },
    { agents: 4, open: 2, claimed: 0, done: 4, tokens: 100 },
  ];
  const m = mc.chartModel(hist, { width: 540, height: 120 });
  assert.equal(m.series.length, 2);
  assert.equal(m.series[0].key, "agents");
  assert.equal(m.series[1].key, "tasks");
  const ag = m.series[0].points;
  assert.equal(ag.length, 3);
  // エージェント数 0→2→4(yMax=4なので 0,1/2,1 に正規化)
  const ih = m.height - m.pad.t - m.pad.b;
  assert.ok(Math.abs(ag[0].y - (m.pad.t + ih)) < 0.11, "0は下端");
  assert.ok(Math.abs(ag[2].y - m.pad.t - ih / 3) < 0.11, "最大は上端からih/3(共通yMax=6でagents=4)");
  // X座標は左パッドから右へ均等間隔
  assert.equal(ag[0].x, m.pad.l);
  assert.ok(ag[1].x > ag[0].x && ag[2].x > ag[1].x);
  // タスク総数は open+claimed+done = 0,4,6
  const tk = m.series[1].points;
  assert.ok(tk[2].y < tk[1].y < tk[0].y, "タスク増加は上向き");
});

test("chartModel: 全0履歴でも0除算せずyMax=1", () => {
  const m = mc.chartModel([{ agents: 0, open: 0, claimed: 0, done: 0, tokens: 0 }]);
  assert.equal(m.yMax, 1);
  assert.equal(m.series[0].points[0].y, m.pad.t + (m.height - m.pad.t - m.pad.b));
});

test("renderChartSvg: polylineと凡例を含むSVG文字列を返す", () => {
  const svg = mc.renderChartSvg([
    { agents: 1, open: 2, claimed: 0, done: 3, tokens: 0 },
    { agents: 3, open: 1, claimed: 1, done: 3, tokens: 0 },
  ]);
  assert.match(svg, /^<svg class="chart"/);
  assert.ok(svg.includes("<polyline"), "折れ線がある");
  assert.ok(svg.includes('aria-label="推移チャート"'), "アクセシビリティ属性");
  assert.ok(svg.includes("エージェント 3"), "凡例に最新エージェント数");
  assert.ok(svg.includes("タスク 5"), "凡例に最新タスク総数");
  assert.ok(svg.includes('stroke="#fbbf24"') && svg.includes('stroke="#86efac"'), "2系列の色");
  assert.ok(!svg.includes("NaN"), "NaNを含まない");
});

test("renderChartSvg: 1点でもcircleで描く(0除算・空polyline回避)", () => {
  const svg = mc.renderChartSvg([{ agents: 2, open: 1, claimed: 0, done: 0, tokens: 0 }]);
  assert.ok(svg.includes("<circle"), "単点はcircle");
  assert.ok(!svg.includes('points=""'), "空pointsのpolylineを作らない");
});

test("renderTokenBarsSvg: サンプル数だけrectを描き、最新が右端", () => {
  const svg = mc.renderTokenBarsSvg([
    { tokens: 1000 }, { tokens: 3000 }, { tokens: 2000 },
  ]);
  assert.match(svg, /^<svg class="chart"/);
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.ok(svg.includes('aria-label="トークン消費の推移"'));
  assert.ok(!svg.includes("NaN"));
  // 最大値が左上ラベル(k表記)
  assert.ok(svg.includes(">3k<"));
});

test("renderTokenBarsSvg: 空履歴でも壊れない(データなし表示)", () => {
  const svg = mc.renderTokenBarsSvg([]);
  assert.match(svg, /^<svg class="chart"/);
  assert.ok(svg.includes("データなし"));
  assert.ok(!svg.includes("NaN"));
});

test("外部ライブラリ非依存: script/src/import/外部URL参照を含まない", () => {
  assert.ok(!code.includes("require("));
  assert.ok(!code.includes("import "));
  assert.ok(!code.includes("https://")); // 外部リソース参照は無し
  // http:// の許容はSVG名前空間識別子のみ。fetch不能な固定識別子で外部依存ではない
  var httpRefs = code.split("http://").slice(1).filter(function (s) { return !s.startsWith("www.w3.org/2000/svg"); });
  assert.equal(httpRefs.length, 0, "SVG名前空間以外のhttp参照は無し");
  assert.ok(!code.includes("src="));
});
