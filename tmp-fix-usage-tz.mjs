// usage-aggregate.test.js をUTC基準に固定する(実装usage.jsはtoISOString=UTCで日付を付けるため)
// ローカル時刻(setHours)で作るとJST 0-9時などUTCと日付がずれる時間帯に期待が壊れる。
import { readFileSync, writeFileSync } from "node:fs";

const path = "test/usage-aggregate.test.js";
const src = readFileSync(path, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
let lines = src.split(eol);

const idx = lines.findIndex((l) => l.replace(/\r$/, "").trim() === "const d = (offsetDays, hour) => {");
if (idx < 0) throw new Error("d() 定義行が見つからない");
// d() のブロック: 定義行から「};」まで(5行想定、保険で8行内で検索)
let end = -1;
for (let i = idx + 1; i < Math.min(idx + 9, lines.length); i++) {
  if (lines[i].replace(/\r$/, "").trim() === "};") { end = i; break; }
}
if (end < 0) throw new Error("d() の閉じ「};」が見つからない");

const replacement = [
  "  // 実装(usage.js)はUTC基準(toISOString)で日付を付けるため、テストもUTCで組み立てて決定的にする。",
  "  // ローカル時刻(setHours)で作るとJST 0-9時などUTCと日付がずれる帯で期待が壊れる(2026-09-30 実害)。",
  "  const utcBase = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());",
  "  const todayUTC = new Date(utcBase).toISOString().slice(0, 10);",
  "  const d = (offsetDays, hour) => new Date(utcBase - offsetDays * 86400000 + hour * 3600000).toISOString();",
];
lines.splice(idx, end - idx + 1, ...replacement);

// 「now.toISOString().slice(0, 10)」の2箇所(今日の期待値)を todayUTC へ
let replaced = 0;
lines = lines.map((l) => {
  if (l.includes("now.toISOString().slice(0, 10)")) { replaced++; return l.split("now.toISOString().slice(0, 10)").join("todayUTC"); }
  return l;
});
if (replaced !== 2) throw new Error("today期待の置換が2箇所でない: " + replaced);

writeFileSync(path, lines.join(eol));
console.log("patched:", path, "d-block lines", idx + 1, "-", end + 1, "todayUTC refs:", replaced);
