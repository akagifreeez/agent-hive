import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const bs = String.fromCharCode(92);
// 目標: 3箇所ともテンプレートリテラル評価後に write("ALIVE\n") — つまりsrc上は ALIVE\n
// 現状を検査して統一する
const wrongLiteral = 'write("ALIVE\n")';           // src上に生改行が入っている状態(実害)
const rightEscaped = 'write("ALIVE' + bs + bs + 'n")'; // src上で\n(評価後\n)
let n = 0;
while (src.includes(wrongLiteral)) { src = src.replace(wrongLiteral, rightEscaped); n++; }
fs.writeFileSync(p, src);
console.log("replaced", n, "literal-newline ALIVE writes");
const m = src.match(/ALIVE.{0,12}/g);
console.log(m?.slice(0, 6));
