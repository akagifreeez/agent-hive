// 競合解消: src/engine/test-semaphore.js の isTestCommand を HEAD(語境界仕様)版へ統一
// 使い方: node tmp-fix-sem.cjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const NL = String.fromCharCode(10);
const strip = (arr) => arr.map((l) => l.replace(/\r$/, ""));

// 1. HEADから語境界版isTestCommand(JSDoc+実装)を抽出
const head = strip(execFileSync("git", ["show", "HEAD:src/engine/test-semaphore.js"], { encoding: "utf8", maxBuffer: 4194304 }).split(NL));
const hs = head.findIndex((l) => l.startsWith("export function isTestCommand"));
if (hs < 0) throw new Error("HEADにisTestCommandなし");
const hbody = [];
for (let i = hs; i < head.length; i++) { hbody.push(head[i]); if (head[i].trim() === "}") break; }
if (hbody.length !== 9 || !hbody.some((l) => l.includes("new RegExp(start"))) {
  throw new Error("HEAD語境界版の特定に失敗: len=" + hbody.length);
}
let hdoc = hs;
for (let i = hs - 1; i >= 0; i--) { if (head[i].trim().startsWith("/**")) { hdoc = i; break; } }
const hchunk = head.slice(hdoc, hs).concat(hbody);
console.log("HEAD語境界版: " + hchunk.length + "行 (JSDoc " + (hs - hdoc) + " + 実装 " + hbody.length + ")");

// 2. 現行ファイル(main採用・旧仕様)の同関数を置換
const cur = strip(readFileSync("src/engine/test-semaphore.js", "utf8").split(NL));
const cs = cur.findIndex((l) => l.startsWith("export function isTestCommand"));
if (cs < 0) throw new Error("現行にisTestCommandなし");
const cbody = [];
for (let i = cs; i < cur.length; i++) { cbody.push(cur[i]); if (cur[i].trim() === "}") break; }
let cdoc = cs;
for (let i = cs - 1; i >= 0; i--) { if (cur[i].trim().startsWith("/**")) { cdoc = i; break; } }
const out = cur.slice(0, cdoc).concat(hchunk, cur.slice(cs + cbody.length));
writeFileSync("src/engine/test-semaphore.js", out.join(NL));
console.log("置換完了: 旧" + (cs - cdoc + cbody.length) + "行 -> 新" + hchunk.length + "行, 全" + out.length + "行");
