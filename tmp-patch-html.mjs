import { readFileSync, writeFileSync } from "node:fs";

const f = "src/ui/public/index.html";
let s = readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// 行単位で安全に差し込む(anchor文字列の一致ではなく行の完全一致)。
const lines = s.split("\n");
const target = '  const bits = [mdl, effTxt, permTxt, lastState.live.scenario ? `[' + '${lastState.live.scenario.phase}]` : null].filter(Boolean);'.replace("${", String.fromCharCode(36) + "{");
let at = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("  const bits = [mdl, effTxt, permTxt")) { at = i; break; }
}
if (at < 0) throw new Error("bits line not found");

const inject = [
  '  // 予算アラート表示: 超過済みのときだけステータスライン(nav-foot)へ出す',
  '  const budgetBits = (lastState.live.budget && lastState.live.budget.exceeded)',
  '    ? ["予算超過: 累積$" + Number(lastState.live.budget.costUsd ?? 0).toFixed(2)]',
  '    : [];',
].join("\n");
lines[at] = inject + "\n" + lines[at].replace("const bits = [", "const bits = [...budgetBits, ");

writeFileSync(f, lines.join("\n"));
console.log("index.html patched at line", at + 1);
