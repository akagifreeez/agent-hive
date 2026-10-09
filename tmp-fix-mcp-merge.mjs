// 一時スクリプト: mcp.jsの競合ブロックを「HEAD側を採用」で解消する(用後削除)
import { readFileSync, writeFileSync } from "node:fs";
const f = "src/engine/mcp.js";
const lines = readFileSync(f, "utf8").split("\n");
const out = [];
let mode = "normal"; // normal | inHead | inTheirs
let removed = 0;
for (const raw of lines) {
  const line = raw.replace(/\r$/, "");
  if (mode === "normal") {
    if (line === "<<<<<<< HEAD") { mode = "inHead"; continue; }
    out.push(raw);
  } else if (mode === "inHead") {
    if (line === "=======") { mode = "inTheirs"; continue; }
    if (line.startsWith(">>>>>>> ")) { mode = "normal"; continue; } // HEAD側だけのブロック
    out.push(raw);
  } else { // inTheirs: agent/impl-78側は捨てる(HEADに同等実装があるため)
    if (line.startsWith(">>>>>>> ")) { mode = "normal"; continue; }
    removed++;
  }
}
if (mode !== "normal") { console.error("UNEXPECTED: ended in mode=" + mode); process.exit(1); }
writeFileSync(f, out.join("\n"));
console.log("resolved. dropped-theirs-lines=" + removed);
