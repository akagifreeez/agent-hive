import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const bs = String.fromCharCode(92);
// 3箇所とも統一: テンプレートリテラル評価後に "ALIVE\n"(backslash-n リテラル)になる形へ。
// 望ましい子ソース: process.stdout.write("ALIVE\n");  → テンプレート内では ALIVE\n
// 現状: 91行=\n(評価後 \n で正しい), 98行=\\n(評価後 \n で誤り), 138行=バッククォート文字列内 \n(正しい)
src = src.replace('write("ALIVE' + bs + bs + bs + bs + 'n")', 'write("ALIVE' + bs + bs + 'n")');
fs.writeFileSync(p, src);
console.log("fixed 98");
