import { readFileSync, writeFileSync } from "node:fs";
const p = "src/ui/public/index.html";
const NL = String.fromCharCode(10);
let src = readFileSync(p, "utf8");

// --- step1: 私のhelper(usageAggTable)を除去 ---
const helperStart = src.indexOf("// 集計テーブル(usage-aggregate)を組み立てる。");
if (helperStart < 0) { console.error("S1: helper comment not found"); process.exit(1); }
const helperFnIdx = src.indexOf("function usageAggTable(", helperStart);
if (helperFnIdx < 0) { console.error("S1: usageAggTable not found"); process.exit(1); }
let depth = 0, started = false, end = -1;
for (let j = helperFnIdx; j < src.length; j++) {
  const c = src[j];
  if (c === "{") { depth++; started = true; }
  if (c === "}") { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
if (end < 0) { console.error("S1: end not found"); process.exit(1); }
// helperコメントの直前の空行1つを含めて削除し、直後にNLを補う
src = src.slice(0, helperStart) + src.slice(end) + NL;

// --- step2: inline loadAggブロックを除去(renderStatusTab冒頭) ---
const anchor = "function renderStatusTab(body) {" + NL;
const aIdx = src.indexOf(anchor);
if (aIdx < 0) { console.error("S2: renderStatusTab not found"); process.exit(1); }
const blockStart = src.indexOf("  // usage集計ビュー(日別/スレッド別/日別×スレッド、イシュー#6)。/api/usage の aggregate を描画", aIdx);
if (blockStart < 0) { console.error("S2: inline block not found"); process.exit(1); }
const callIdx = src.indexOf("  loadAgg();", blockStart);
if (callIdx < 0) { console.error("S2: loadAgg call not found"); process.exit(1); }
src = src.slice(0, blockStart) + src.slice(callIdx + ("  loadAgg();").length);

// --- step3: 相手側(renderUsageAggregate)の配線を復元 ---
const wire = [
  "  // 日別・スレッド別の集計ビュー(GitHubイシュー#6): /api/usage のaggregateを表示",
  '  const aggBox = document.createElement("div");',
  '  aggBox.id = "usage-aggregate";',
  "  body.appendChild(aggBox);",
  "  renderUsageAggregate(aggBox);",
].join(NL);
const wireAnchor = "    body.appendChild(tbl);" + NL + "  }";
if (!src.includes(wireAnchor)) { console.error("S3: wire anchor not found"); process.exit(1); }
src = src.replace(wireAnchor, wireAnchor + NL + wire);

writeFileSync(p, src);
console.log("OK: unified");
