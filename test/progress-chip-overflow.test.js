// 進捗チップのポップアップパネルが画面外にはみ出さないことの固定(fix-progress-chip-overflow)。
// jsdom等の依存なしで、index.htmlの実CSS値をパースして幾何計算する(狭いビューポート想定:
// 幅800px×高さ600px)。パネルは right:0 右端基準で左へ伸び、幅は min(520px,90vw)/max-width、
// 高さは max-height:60vh で上限を切る。超過分は overflow-y:auto の縦スクロールで読める。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

function panelGeometry() {
  const m = html.match(/#progress-panel \{([^}]*)\}/);
  assert.ok(m, "#progress-panelのCSS定義が存在する");
  const css = m[1];
  const num = (re, label) => {
    const mm = css.match(re);
    assert.ok(mm, `CSS ${label} が存在する`);
    return Number(mm[1]);
  };
  const w = css.match(/width: min\((\d+)px, (\d+)vw\)/);
  assert.ok(w, "width: min(px, vw) 形式である");
  const maxW = num(/max-width: (\d+)px/, "max-width");
  const maxHvh = num(/max-height: (\d+)vh/, "max-height");
  const anchoredRight = /position: absolute; top: 100%; right: 0;/.test(css);
  const scrollsY = /overflow-y: auto/.test(css);
  const hidesX = /overflow-x: hidden/.test(css);
  return { css, maxW, maxHvh, anchoredRight, scrollsY, hidesX, wPx: Number(w[1]), wVw: Number(w[2]) };
}

test("overflow: パネルは右端基準で配置され、横スクロールを出さない", () => {
  const g = panelGeometry();
  assert.ok(g.anchoredRight, "right:0 右端基準(左へ伸びる)ではみ出しにくい配置");
  assert.ok(g.hidesX, "overflow-x: hidden(横にはみ出させない)");
  assert.ok(g.scrollsY, "overflow-y: auto(縦はスクロールで読める)");
});

test("overflow: 幅800px×高さ600pxのビューポートで画面外に出ない(実寸計算)", () => {
  const g = panelGeometry();
  const VW = 800, VH = 600;
  const panelW = Math.min(g.wPx, (VW * g.wVw) / 100, g.maxW);
  const panelH = (VH * g.maxHvh) / 100;
  // 最悪ケース: チップの右端がビューポート右端ぴったり(パネルはそこから左へ伸びる)
  const panelLeft = VW - panelW;
  // top:100% はヘッダー直下。ヘッダー高を保守的に200pxと仮定しても下端は収まる
  const panelBottom = 200 + panelH;
  assert.ok(panelLeft >= 0, `左端が画面内(左=${panelLeft}px)`);
  assert.ok(panelBottom <= VH, `下端が画面内(下=${panelBottom}px <= ${VH}px)`);
});
