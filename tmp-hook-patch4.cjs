// 文字コード直指定で安全に差し替える(CRLF/エスケープ多層の誤爆回避)。
// 対象: テンプレートリテラル内の ...ENDED_BY + '\n')... の \n 部分(バックスラッシュ0x5C+n)を \010 へ。
const fs = require("fs");
const p = "test/hooks.test.js";
const B = String.fromCharCode(92); // バックスラッシュ
const oldSeg = "ENDED_BY + '" + B + "n')";      // ソース上の字形: ENDED_BY + '\n')
const newSeg = "ENDED_BY + '" + B + "010')";   // ソース上の字形: ENDED_BY + '\010')
let t = fs.readFileSync(p, "utf8");
if (!t.includes(oldSeg)) { console.error("needle not found"); process.exit(1); }
t = t.replace(oldSeg, newSeg);
fs.writeFileSync(p, t);
console.log("patched");
