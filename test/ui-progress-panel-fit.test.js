// 進捗チップのポップアップパネルの画面外はみ出し防止(fix-progress-chip-overflow):
// 幅800px×高さ600px相当の狭いビューポートでも、パネルが右端/下端からはみ出さず、
// 長いid・要約は1行に収まる(ellipsis+titleで全文ホバー)ことをCSS/DOMの静的検査で固定する。
// 実DOMでのposition計算は重いので、既存UIテスト作法と同じくindex.htmlの実装を正規表現/DOM解析で検証する。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "src", "ui", "public");
const html = readFileSync(join(root, "index.html"), "utf8");

// CSSブロック抽出: #progress-panel の宣言部(ビューポート基準の制約が書かれる場所)
const panelCss = html.match(/#progress-panel \{[^}]+\}/)?.[0] ?? "";
const rowCss = html.match(/#progress-panel \.pc-row \{[^}]+\}/)?.[0] ?? "";
const idCss = html.match(/#progress-panel \.pc-id \{[^}]+\}/)?.[0] ?? "";
const sumCss = html.match(/#progress-panel \.pc-sum \{[^}]+\}/)?.[0] ?? "";

test("fix-progress-chip-overflow: パネルはビューポート基準で配置され、幅・高さが画面内に収まる", () => {
  // ビューポート基準: position: fixed(またはabsolute+right:0で右端基準)。808px幅ビューポートでも左にはみ出さない
  assert.match(panelCss, /position: (fixed|absolute)/, "パネルはpositionで浮かせる");
  assert.match(panelCss, /right: 0/, "右端基準の配置(左へのはみ出しを構造的に防ぐ)");
  // 幅: max-width 520px以下+90vw上限。max-widthが無いと長文で無限に横へ伸びる
  const wmax = panelCss.match(/max-width: (\d+)px/)?.[1];
  assert.ok(wmax && Number(wmax) <= 520, "max-widthは520px以下(" + wmax + ")");
  assert.match(panelCss, /width: min\((\d+)px, 90vw\)/, "widthはmin(Npx, 90vw)で狭いビューポートでも追従");
  // 高さ: max-height(60vh等)+縦スクロール。下端のはみ出しを構造的に防ぐ
  const hmax = panelCss.match(/max-height: (\d+)vh/)?.[1];
  assert.ok(hmax && Number(hmax) <= 60, "max-heightは60vh以下(" + hmax + ")");
  assert.match(panelCss, /overflow(-y)?: auto/, "縦スクロール(overflow: auto)");
});

test("fix-progress-chip-overflow: 長いタスクid・要約は1行に収まる(ellipsis+title属性)", () => {
  // 行・セル側のellipsis: min-width:0(flex子の縮小許可)+hidden+ellipsis+nowrap
  assert.match(rowCss, /min-width: 0/, "pc-rowはflex子の縮小を許可(min-width: 0)");
  for (const [name, css] of [["pc-id", idCss], ["pc-sum", sumCss]]) {
    assert.match(css, /overflow: hidden/, name + "はoverflow: hidden");
    assert.match(css, /text-overflow: ellipsis/, name + "はtext-overflow: ellipsis");
    assert.match(css, /white-space: nowrap/, name + "はwhite-space: nowrap");
  }
  // title属性でホバー時に全文を出す(mk関数のrow構築部)
  assert.match(html, /row\.title = /, "pc-rowにtitle属性(全文ホバー)を設定する");
});

test("fix-progress-chip-overflow: 完了一覧は直近15件に絞られ、溢れは「他N件」で示す", () => {
  // slice(0, 15): 作業中は全件・完了は直近15件。溢れ分は「他N件」表記
  assert.match(html, /slice\(0, 15\)/, "完了は直近15件に絞る");
  assert.match(html, /他\d+件|他" \+|"他"/, "溢れ分の「他N件」表記がある");
  // 作業中セクションは絞らない(全件表示)ことを構造で確認: claimedはsliceされない
  const claimedPart = html.slice(html.indexOf('pc-sec"; s1.textContent'), html.indexOf('pc-sec"; s2.textContent'));
  assert.doesNotMatch(claimedPart, /slice\(0,/, "作業中は全件表示(絞らない)");
});

test("fix-progress-chip-overflow: パネルの開閉はチップクリックのトグル(ホバー非依存)", () => {
  // onclickでトグルし、マウスが外れても消えない(panelはclickのみで開閉)
  assert.match(html, /\$\("progress-chip"\)\.onclick = \(\) => \{ progressPanelOpen = !progressPanelOpen;/, "クリックでトグル");
  // ホバー系ハンドラでパネルを閉じない(onmouseleave等で消えると読めない)
  const wrapPart = html.slice(html.indexOf("progress-wrap"), html.indexOf("function renderAll()"));
  assert.doesNotMatch(wrapPart, /onmouse(out|leave)[^;]*progressPanelOpen = false/, "マウスアウトで勝手に閉じない");
});

// 幅800×高さ600相当の狭いビューポートでの幾何検査: CSS座標の実計算。
// パネルは右端基準・width min(Npx,90vw)・max-height 60vhなので、
// 800×600でも right:0 + 幅min(520,720) + 高さmax360 の矩形がビューポートに収まることを実数で保証する。
test("fix-progress-chip-overflow: 800x600ビューポートでパネル矩形が画面内に収まる(実数計算)", () => {
  const w = Math.min(Number(panelCss.match(/width: min\((\d+)px, 90vw\)/)?.[1]), Math.round(800 * 0.9));
  const h = Math.round(600 * (Number(panelCss.match(/max-height: (\d+)vh/)?.[1]) / 100));
  // right:0配置なので左端 = 800 - w、下端 = top(header高さを仮に40pxとする) + h
  const left = 800 - w;
  const bottom = 40 + h;
  assert.ok(left >= 0, "左端が画面内(" + left + ">=0)");
  assert.ok(bottom <= 600, "下端が画面内(" + bottom + "<=600)");
  assert.ok(w > 0 && h > 0, "矩形が正の大きさを持つ");
});
