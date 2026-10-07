// 一時修復スクリプト(実行後削除): test-semaphore.jsのisTestCommand二重定義+破損を修復する
import { readFileSync, writeFileSync } from "node:fs";
const BS = String.fromCharCode(92); // バックスラッシュ(シェル経由のエスケープ食い対策)
const p = "src/engine/test-semaphore.js";
const lines = readFileSync(p, "utf8").split(String.fromCharCode(10));

// 正しいisTestCommand関数(5行)。正規表現は断片結合で組み立て(テンプレートリテラル不使用)
const rx1 = "/(^|[;&|(" + BS + "s*)" + "npm" + BS + "s+(run" + BS + "s+)?test/";
const rx2 = "/(^|[;&|(" + BS + "s*)" + "node" + BS + "s+--test/";
const rx3 = "/(^|[;&|(" + BS + "s*)" + "npm" + BS + "s+(--" + BS + "S+" + BS + "s+)*--test(" + BS + "s|$)/";
const newFn = [
  "export function isTestCommand(command) {",
  '  const c = String(command ?? "");',
  "  if (" + rx1 + ".test(c) || " + rx2 + ".test(c)) return true;",
  "  return " + rx3 + ".test(c); // npm --test / npm --silent --test もテスト意図",
  "}",
];

// 16行目から始まる2連続のisTestCommandブロックを特定して差し替え
const starts = lines.map((l, i) => (l.startsWith("export function isTestCommand") ? i : -1)).filter((i) => i >= 0);
if (starts.length !== 2) { console.error("unexpected blocks:", starts); process.exit(1); }
const first = starts[0];
// 2個目のブロック終端(行頭が } の行)
let secondEnd = -1;
for (let i = starts[1] + 1; i < lines.length; i++) { if (lines[i] === "}") { secondEnd = i; break; } }
if (secondEnd < 0) { console.error("end not found"); process.exit(1); }
lines.splice(first, secondEnd - first + 1, ...newFn);
writeFileSync(p, lines.join(String.fromCharCode(10)), "utf8");
console.log("replaced lines", first + 1, "-", secondEnd + 1, "with", newFn.length, "lines");
