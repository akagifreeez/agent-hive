// 一時パッチ(実行後自己削除): tools.js の browser_* 二重登録を解消する。
// 1つ目のグループ(161〜・リッチ出力版+case 659〜)を残し、
// 2つ目の specs(215〜・私の仮追加版)と case(736〜・私の仮実装)を削除する。
// 残す側の動作は browser-tools-finish.test.js / tools-ext.test.js が担保している。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const p = "src/engine/tools.js";
const src = readFileSync(p, "utf8");
const lines = src.split(/\r?\n/);

// specs側: 2つ目の browser_fetch spec 開始行を見つける(215行目付近・"指定URLのページを取得し" 説明)
const specStart = lines.findIndex((l) => l.includes('name: "browser_fetch"') && lines[lines.indexOf(l) + 1]?.includes("指定URLのページを取得し"));
if (specStart < 0) { console.error("specs側の2つ目が見つからない"); process.exit(1); }
// browser_submit spec の required html/base_url の閉じ(2つ目グループ末尾)まで削る
let specEnd = -1;
for (let i = specStart; i < lines.length; i++) {
  if (lines[i].includes('required: ["html", "base_url"]')) {
    // その後の }, }, を見つける
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "}," && lines[j + 1]?.trim() === "},") { specEnd = j + 1; break; }
    }
    break;
  }
}
if (specEnd < 0) { console.error("specs側の末尾が見つからない"); process.exit(1); }
console.log("specs削除範囲:", specStart + 1, "〜", specEnd + 1, "行");

// case側: 736行目付近の "urlはhttp(s)の絶対URLで指定してください" 版(browserSubmit簡易版)を削除
const caseStart = lines.findIndex((l, i) => i > specEnd && l.includes('case "browser_fetch"') && lines[i + 2]?.includes("urlはhttp(s)の絶対URLで指定してください"));
if (caseStart < 0) { console.error("case側の2つ目が見つからない"); process.exit(1); }
let caseEnd = -1;
for (let i = caseStart; i < lines.length; i++) {
  // search_files の直前の } まで(browser_submit簡易3ケースの一括)
  if (lines[i].includes('case "search_files"')) { caseEnd = i - 1; break; }
}
if (caseEnd < 0) { console.error("case側の末尾が見つからない"); process.exit(1); }
console.log("case削除範囲:", caseStart + 1, "〜", caseEnd + 1, "行");

const out = lines.slice(0, specStart).concat(lines.slice(specEnd + 1)).join("\n");
// 行数がずれるので再スキャン: specs削除後の文字列から case 側を削る
const outLines = out.split("\n");
const cStart = outLines.findIndex((l) => l.includes('case "browser_fetch"') && outLines[outLines.indexOf(l) + 2]?.includes("urlはhttp(s)の絶対URLで指定してください"));
if (cStart >= 0) {
  let cEnd2 = -1;
  for (let i = cStart; i < outLines.length; i++) {
    if (outLines[i].includes('case "search_files"')) { cEnd2 = i - 1; break; }
  }
  if (cEnd2 >= 0) {
    outLines.splice(cStart, cEnd2 - cStart);
    console.log("case削除後の整理: 完了");
  }
}
writeFileSync(p, outLines.join("\n"));
unlinkSync("tmp-dedupe-browser-beta.mjs");
console.log("二重登録解消・スクリプト自己削除");
