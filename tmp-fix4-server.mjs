import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/server.js";
let s = readFileSync(f, "utf8");
const lines = s.split("\n");

// 未設定時は usage.round を監視しない(そもそも購読を足さない)。
const oldLine = '    budgetState.costUsd = cost;';
const newLine = '    if (budgetState.thresholdUsd == null) return; // 未設定なら監視自体をしない(costも配らない)\n    budgetState.costUsd = cost;';
let done = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === oldLine) { lines[i] = newLine; done = true; break; }
}
if (!done) throw new Error("costUsd line not found");

writeFileSync(f, lines.join("\n"));
console.log("guard added");
