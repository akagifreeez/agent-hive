import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const p = "src/model/openai.js";
const lines = readFileSync(p, "utf8").split(/\r?\n/);
// マーカー行(行頭完全一致・CR strip)を検出して採用側を決める
let out = [];
let mode = null; // "head" | "branch"
let startLine = -1;
for (let i = 0; i < lines.length; i++) {
  const L = lines[i].replace(/\r$/, "");
  if (L === "<<<<<<< HEAD") { mode = "head"; startLine = i + 1; out.push(`__HEAD_START__${i+1}`); continue; }
  if (L === "=======" && mode === "head") { mode = "branch"; out.push(`__DIVIDER__${i+1}`); continue; }
  if (L === ">>>>>>> agent/process-guard-impl") { mode = null; out.push(`__BRANCH_END__${i+1}`); continue; }
  out.push(L);
}
console.log(JSON.stringify(out.filter(l => l.startsWith("__"))));
