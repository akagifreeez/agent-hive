import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/server.js";
let s = readFileSync(f, "utf8");
const lines = s.split("\n");

// 82〜96行目(バッククォート入りの重複ブロック)を削除する。
// 前回checkout mainした直後に誰か(マージ処理?)が同blockをテンプレートリテラル版で
// 追加しており、今回のパッチと二重になっている。末尾挿入版(文字列連結版)を残す。
let start = -1, end = -1;
for (let i = 0; i < lines.length; i++) {
  if (start < 0 && lines[i].includes("usage予算アラート(config.chat.budgetAlertUsd)")) { start = i; continue; }
  if (start >= 0 && lines[i].includes("usage予算アラート(config.chat.budgetAlertUsd)")) { end = i; break; }
}
if (start < 0 || end < 0) throw new Error("duplicate block not found");

// 2つ目のブロック開始の直前(=1つ目のブロックの末尾付近)を探す:
// 1つ目のブロックは start から「2つ目のコメント行の1行前+空行」まで。
// 実際には end-1 が空行のはず(パッチは block + "\n" + anchor の形)。
// 消す範囲: start .. end-2(空行ごと)
lines.splice(start, end - 1 - start);

writeFileSync(f, lines.join("\n"));
console.log("removed duplicate block:", start + 1, "-", end - 1);
