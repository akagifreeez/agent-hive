import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/server.js";
let s = readFileSync(f, "utf8");

// 破損行(94行目: パッチスクリプトのテンプレートリテラルが source 内へ展開された)を特定して修復。
// 破損の形: 行が "live.board.push({ id: ..." で始まり、同じ行にファイル先頭のコメント
// "// ローカルWebUI..." が連結されている。その間に正しいテキスト構築コードを復元する。
const lines = s.split("\n");
let bad = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("live.board.push({ id:") && lines[i].includes("予算超過")) { bad = i; break; }
}
if (bad < 0) throw new Error("broken line not found");

// 復元する1行(バッククォート・ドル記号は単引用符の連結のみで作る)
const fixed = '    live.board.push({ id: "budget-" + Date.now(), from: "system", text: "[予算超過] 累積コストが設定(" + String(budgetAlertUsd) + "$)を超えました。予算超過: 累積$" + cost.toFixed(2) });';

// 元の行には「壊れた text: 値 + ファイル先頭コメントの連結」が残っている。
// ファイル先頭コメント2行(// ローカルWebUI... / // 描画はブラウザ側...)は既に
// この行の中に食い込んでいるため、破損行をまるごと正しい1行へ差し替えたうえで、
// 欠けた先頭コメントをファイルの先頭へ戻す。
lines[bad] = fixed;
s = lines.join("\n");

// 先頭に欠けたコメントを復元(破損行へ取り込まれた分)
const head = '// ローカルWebUI。依存ゼロ(node:http + SSE)。後からElectron殻で包む前提なので\n// 描画はブラウザ側に寄せ、サーバーは状態API+SSEストリームだけを持つ。\n';
if (!s.startsWith("// ローカルWebUI")) s = head + s;

writeFileSync(f, s);
console.log("fixed line", bad + 1);
