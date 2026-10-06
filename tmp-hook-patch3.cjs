// ソース上「'\n'」(バックスラッシュ2個+n、単一引用符で括る)を「'\010'」へ。
const fs = require("fs");
const p = "test/hooks.test.js";
let t = fs.readFileSync(p, "utf8");
const needle = "'\\n')"; // JS文字列としては: '\n')  ← ソースの字形: バックスラッシュ, バックスラッシュ, n
if (!t.includes(needle)) { console.error("needle not found"); process.exit(1); }
t = t.replace(needle, "'\\010')"); // ソースの字形: バックスラッシュ, バックスラッシュ, 0, 1, 0
fs.writeFileSync(p, t);
console.log("patched");
