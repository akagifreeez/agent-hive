import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("src/engine/mcp.js", "utf8");
// 残った競合マーカー対(<<<<<<< HEAD 〜 ======= 〜 >>>>>>> main)を除去。
// HEAD側は空、main側にMcpHostInstance typedefがあるので typedef を残す
const start = s.indexOf("<<<<<<< HEAD");
if (start === -1) { console.log("start marker not found"); process.exit(1); }
const sep = s.indexOf("=======", start);
const endM = s.indexOf(">>>>>>> main", sep);
if (sep === -1 || endM === -1) { console.log("other markers missing"); process.exit(1); }
const keep = s.slice(sep + "=======".length, endM).replace(/^\r?\n/, "");
s = s.slice(0, start) + keep + s.slice(s.indexOf("\n", endM) + 1);
writeFileSync("src/engine/mcp.js", s);
console.log("conflict block resolved");