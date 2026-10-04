// 修復パッチ2: クラス内に誤挿入した検知関数群を削除→モジュール直下へ再挿入し、
// say()へ警告付与を組み込む。行終端の汚れ(^M^M^M)も一緒に正規化する。
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
let text = readFileSync(p, "utf8");
const CR = String.fromCharCode(13);

// 1) 誤挿入ブロック(クラス内)を正規表現で削除: 「  // ---- 文字化け入力の検知」から
//    「  return null;\r}\r」(mojibakeWarning終端)まで
const startRe = / {2}\/\/ ---- 文字化け入力の検知\(イシュー#20 提案3\) ----/;
const m = text.match(startRe);
if (!m) throw new Error("block start not found");
const startIdx = m.index;
const endRe = / {2}return null;\r\n\}\r\r\r/;
endRe.lastIndex = startIdx;
const em = endRe.exec(text);
if (!em) throw new Error("block end not found");
const removed = text.slice(startIdx, em.index + em[0].length);
if (!removed.includes("mojibakeWarning")) throw new Error("unexpected removed content: " + removed.slice(-120));
text = text.slice(0, startIdx) + text.slice(em.index + em[0].length);

// 2) モジュール直下(export class ChatHost の直前)へ挿入。2スペインデントを剥がす
const clsAnchor = "export class ChatHost {";
const clsIdx = text.indexOf(clsAnchor);
if (clsIdx < 0) throw new Error("class anchor not found");
const NL = CR + "\n";
const funcs = removed.split(NL)
  .filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ""))
  .map((l) => (l.startsWith("  ") ? l.slice(2) : l.replace(/\r+$/, "")))
  .join(NL) + NL;
const insert = "// ---- 文字化け入力の検知(イシュー#20 提案3): クラス外の純関数群 ----" + NL + funcs + NL;
text = text.slice(0, clsIdx) + insert + text.slice(clsIdx);

// 3) say() に警告付与を組み込む(警告 + 空行 + 従来の指示文)
const oldSayLines = [
  "  say(text) {",
  "    this.board.post(\"you\", text);",
  "    this.mains.forEach((m, i) => {",
  "      this.wake(m, \"[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。\", i * this.staggerMs);",
  "    });",
  "  }",
];
const oldSay = oldSayLines.map((l) => l + NL).join("\n");
if (!text.includes(oldSay)) throw new Error("say block not found");
const newSayLines = [
  "  say(text) {",
  "    this.board.post(\"you\", text);",
  "    // 文字化け入力(U+FFFD・二重エンコード兆候)は内容を信用できないため、",
  "    // 推測で応答させず再送を促す警告を注入文へ明示する(イシュー#20 提案3)",
  "    const mj = mojibakeWarning(text);",
  "    const base = \"[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。\";",
  "    const kickoff = mj ? mj + \"\\n\" + base : base;",
  "    this.mains.forEach((m, i) => {",
  "      this.wake(m, kickoff, i * this.staggerMs);",
  "    });",
  "  }",
];
const newSay = newSayLines.map((l) => l + NL).join("\n");
text = text.replace(oldSay, newSay);

writeFileSync(p, text);
console.log("moved to module scope + wired say()");
