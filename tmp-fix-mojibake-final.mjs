// 修復パッチ3(最終): chat.jsを素直に直す。
// 現状: クラス内に検知関数群が誤挿入(export不可で構文エラー)。sayは未改変。
// 手順: (1)誤挿入ブロックを削除 (2)クラス外へ移動(インデント調整) (3)sayへ警告組込
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
let text = readFileSync(p, "utf8");

// ---- (1) 誤挿入ブロック削除: 「  // ---- 文字化け入力の検知」〜「  return null;\r\n}\r\r\r」
const startMark = "  // ---- 文字化け入力の検知(イシュー#20 提案3) ----";
const si = text.indexOf(startMark);
if (si < 0) throw new Error("block start not found");
const endMark = "  return null;" + String.fromCharCode(13) + "\n}" + String.fromCharCode(13) + String.fromCharCode(13) + String.fromCharCode(13);
const ei0 = text.indexOf(endMark, si);
if (ei0 < 0) throw new Error("block end not found");
const ei = ei0 + endMark.length;
const removed = text.slice(si, ei);
if (!removed.includes("mojibakeWarning")) throw new Error("unexpected removed content");
text = text.slice(0, si) + text.slice(ei);

// ---- (2) クラス外へ移動。各行の先頭2スペースを剥がす(クラス内挿入だった名残)
const lines = removed.split(String.fromCharCode(13) + "\n");
while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
const body = lines.map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join(String.fromCharCode(13) + "\n");
const CR = String.fromCharCode(13);
const classAnchor = "export class ChatHost {";
const ci = text.indexOf(classAnchor);
if (ci < 0) throw new Error("class anchor not found");
const insert = "// ---- 文字化け入力の検知(イシュー#20 提案3): クラス外の純関数群 ----" + CR + "\n" + body + CR + "\n" + CR + "\n";
text = text.slice(0, ci) + insert + text.slice(ci);

// ---- (3) say() 改変: 警告をkickoffへ連結
const CRs = CR;
const sayLines = [
  "  say(text) {" + CRs,
  "    this.board.post(\"you\", text);" + CRs,
  "    // 文字化け入力(U+FFFD・二重エンコード兆候)は内容を信用できないため、" + CRs,
  "    // 推測で応答させず再送を促す警告を注入文へ明示する(イシュー#20 提案3)" + CRs,
  "    const mj = mojibakeWarning(text);" + CRs,
  "    const base = \"[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。\";" + CRs,
  "    const kickoff = mj ? mj + \"\\n\" + base : base;" + CRs,
  "    this.mains.forEach((m, i) => {" + CRs,
  "      this.wake(m, kickoff, i * this.staggerMs);" + CRs,
  "    });" + CRs,
  "  }" + CRs,
];
const oldSay = sayLines.filter((l, i) => i < 2 || i >= 7).map((l) => l).join("");
// 正確な置換: 元のsayブロック(2行目〜)を組み立て
const oldBlock = [
  "  say(text) {" + CRs,
  "    this.board.post(\"you\", text);" + CRs,
  "    this.mains.forEach((m, i) => {" + CRs,
  "      this.wake(m, \"[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。\", i * this.staggerMs);" + CRs,
  "    });" + CRs,
  "  }" + CRs,
].join("");
if (!text.includes(oldBlock)) throw new Error("say block not found");
text = text.replace(oldBlock, sayLines.join(""));

writeFileSync(p, text);
console.log("done: moved + wired");
