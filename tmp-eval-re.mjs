// RE直接評価: importしたモジュールからではなく、ファイル内のREを動的に構築して一致検証
// → "echo npm test" が (\s|...) 直後のnpmにマッチしない理由を探す
// 疑い: (?:-{1,2}[\w.-]+\s+)* が "echo " を消費? いや、npm直前は(^|[\s&;|])のどれか。
// "echo npm test" は "echo" の後にスペース → \s に該当するはず。
// 実際に正規表現オブジェクトを作って試す(コピペではなくexec.jsと同一生成経路で)
import { readFileSync } from "node:fs";
const src = readFileSync("src/engine/exec.js", "utf8");
const lines = src.split(String.fromCharCode(10));
const start = lines.findIndex(l => l.includes("TEST_COMMAND_RE = new RegExp"));
let expr = "";
for (let k = start; k < lines.length; k++) {
  expr += lines[k];
  if (lines[k].includes("));")) break;
}
// exprから「const TEST_COMMAND_RE = 」を評価
const fn = new Function("return " + expr.replace("const TEST_COMMAND_RE = ", "const re = ").replace(/;\s*$/, "").replace(/^const re = /, "") + "");
const re = eval("(" + expr.replace("const TEST_COMMAND_RE = ", "").replace(/;\s*$/, "").replace(/\/\/.*$/, "") + ")");
console.log("echo npm test:", re.test("echo npm test"));
console.log("npm test:", re.test("npm test"));
console.log("a && npm test:", re.test("a && npm test"));
console.log("source head:", re.source.slice(0, 80));
