import { readFileSync, writeFileSync } from "node:fs";
const p = "src/ui/public/index.html";
let src = readFileSync(p, "utf8");

// 1) 私の重複ブロック(usageAggTable関数+inline loadAgg)を除去
// usageAggTable関数: コメント行から関数終端まで
const helperStart = src.indexOf("// 集計テーブル(usage-aggregate)を組み立てる。");
if (helperStart < 0) { console.error("helper comment not found"); process.exit(1); }
const helperFnIdx = src.indexOf("function usageAggTable(");
if (helperFnIdx < 0) { console.error("usageAggTable not found"); process.exit(1); }
// 関数終端(波括弧バランス)
let depth = 0, started = false, end = -1;
for (let j = helperFnIdx; j < src.length; j++) {
  const c = src[j];
  if (c === "{") { depth++; started = true; }
  if (c === "}") { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
if (end < 0) { console.error("usageAggTable end not found"); process.exit(1); }
// コメント開始から関数終端+改行まで削除
let cutStart = helperStart;
// 直前の空行も巻き込む
src = src.slice(0, cutStart) + src.slice(end);
// 連続した空行の整形状から書き直し: 実際はslice位置調整のため改行確認
console.log("helper removed");

// 2) inline loadAggブロック(renderStatusTab冒頭)を除去
const anchor = "function renderStatusTab(body) {";
const aIdx = src.indexOf(anchor);
if (aIdx < 0) { console.error("renderStatusTab not found"); process.exit(1); }
const blockStart = src.indexOf("  // usage集計ビュー(日別/スレッド別/日別×スレッド、イシュー#6)。/api/usage の aggregate を描画", aIdx);
if (blockStart < 0) { console.error("inline block start not found"); process.exit(1); }
const blockEndMarker = "  loadAgg();";
const bEnd = src.indexOf(blockEndMarker, blockStart);
if (bEnd < 0) { console.error("loadAgg call not found"); process.exit(1); }
src = src.slice(0, blockStart) + src.slice(bEnd + blockEndMarker.length);

// 3) 相手側の配線を復元(renderStatusTab内、エージェント表の後)
const wireLines = [
  "  // 日別・スレッド別の集計ビュー(GitHubイシュー#6): /api/usage のaggregateを表示",
  '  const aggBox = document.createElement("div");',
  '  aggBox.id = "usage-aggregate";',
  "  body.appendChild(aggBox);",
  "  renderUsageAggregate(aggBox);",
].join(String.fromCharCode(10));
const wireAnchor = "    body.appendChild(tbl);" + String.fromCharCode(10) + "  }";
if (!src.includes(wireAnchor)) { console.error("wire anchor not found"); process.exit(1); }
src = src.replace(wireAnchor, wireAnchor + String.fromCharCode(10) + wireLines);

writeFileSync(p, src);
console.log("unified: my duplicates removed, respawn wiring restored");
