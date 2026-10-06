// hooks.test.js: ソース中のリテラル "\n"(2文字: バックスラッシュ+n)を8進エスケープ \010 へ差し替える。
// 対象はroundEndフック行のみ(afterTool等の他テストは影響受けない形だが、このパターンはroundEnd行にしか無い)。
const fs = require("fs");
const p = "test/hooks.test.js";
let t = fs.readFileSync(p, "utf8");
const needle = "ENDED_BY + '\\n')"; // ソース上は ENDED_BY + '\n')
if (!t.includes(needle)) { console.error("needle not found"); process.exit(1); }
const replacement = "ENDED_BY + '\\010')"; // ソース上は ENDED_BY + '\010')
t = t.replace(needle, replacement);
fs.writeFileSync(p, t);
console.log("patched");
