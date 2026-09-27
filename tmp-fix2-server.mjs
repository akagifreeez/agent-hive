import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/server.js";
let s = readFileSync(f, "utf8");
const lines = s.split("\n");

// 破損で失われた先頭2行を復元する:
// 1) import文1行(osの次にあったやつ: URL作成用の url モジュール)
// 2) PUBLIC定数とエージェントログのコメントブロック
// 破損行の直後に、本来ファイル先頭にあった残骸が連結して残っているため位置を特定して整列。
let bad2 = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("budget-" + ' Date.now()') && lines[i].includes("予算超過")) { bad2 = i; break; }
}
if (bad2 < 0) throw new Error("broken line not found (2nd)");

// 破損行の直後にあるべき構造を復元:
//   push文 → import { URL, URLSearchParams } from "node:url"; → PUBLIC定数 → AGENT_LOG_LIMITコメント
const restore = [
  'import { URL, URLSearchParams } from "node:url";',
  '',
  'const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");',
  '',
  '// エージェントごとの活動ログ(思考/発言/ツール/状態)。UIの詳細パネル用。',
];
lines.splice(bad2 + 1, 0, ...restore);

writeFileSync(f, s = lines.join("\n"));
console.log("restored head after line", bad2 + 1);
