// 一時スクリプト: mcp.jsの競合ブロックを「HEAD側(自ブランチ版)を採用」で解消する(用後削除)
// 前提: HEAD(1da75c5)は impl-78引き継ぎ済みの強化版。main側は旧ガンマ版で同等機能だが
// HEAD側が失敗メッセージ接頭辞など微強化。統一のためHEAD側を採る。
import { readFileSync, writeFileSync } from "node:fs";
const f = "src/engine/mcp.js";
const lines = readFileSync(f, "utf8").split("\n");
const out = [];
let mode = "normal"; // normal | inHead | inTheirs
let dropped = 0;
for (const raw of lines) {
  const line = raw.replace(/\r$/, "");
  if (mode === "normal") {
    if (line === "<<<<<<< HEAD") { mode = "inHead"; continue; }
    out.push(raw);
  } else if (mode === "inHead") {
    if (line === "=======") { mode = "inTheirs"; continue; }
    if (line.startsWith(">>>>>>> ")) { mode = "normal"; continue; }
    out.push(raw);
  } else {
    if (line.startsWith(">>>>>>> ")) { mode = "normal"; continue; }
    dropped++;
  }
}
if (mode !== "normal") { console.error("UNEXPECTED mode=" + mode); process.exit(1); }
writeFileSync(f, out.join("\n"));
console.log("resolved. dropped-main-lines=" + dropped);
