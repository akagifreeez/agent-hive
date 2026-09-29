// tmp-fix-btlink.mjs — extractElements のリンク正規表現を([\s\S]*?)構文へ修正。目的達成後に削除
import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/browser-tools.js";
let s = readFileSync(p, "utf8");
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

// 壊れた(\s\S*?) → 正しい([\s\S]*?)。ソース上は (<BS>s<BS>S*?) となっている箇所
const bad = ">(" + BS + "s" + BS + "S*?)</a" + BS + "s*>";
const good = ">([" + BS + "s" + BS + "S]*?)</a" + BS + "s*>";
if (!s.includes(bad)) { console.log("BAD-NOT-FOUND"); process.exit(1); }
const n = s.split(bad).length - 1;
if (n !== 1) { console.log("COUNT:", n); process.exit(1); }
s = s.replace(bad, good);
writeFileSync(p, s);
console.log("fixed");
